// 与传输无关的路由与动作分发（TDD-001 §3.1）。
//
// 这里不认识 node:http，也不认识浏览器：进来的是 { method, path, query, body }，
// 出去的是「回一段 JSON」「回一个静态文件」「开一条流」三选一。宿主负责把它落到
// 具体的传输上——Node 端是 http.ts，浏览器沙盒端是 packages/web 的 fetch/EventSource 替身。
//
// 之所以要拆出来：可见性规则、令牌校验、动作白名单只能有一份实现。沙盒若自己抄一遍
// 路由，迟早会和真服务端漂移，那沙盒里「跑通的一局」就不算数了。
import type { Domain, SeatId, Submission } from '@estates/engine';
import { createRoom, getRoom, listRooms, type Room } from './room.js';
import { snapshotFor } from './visibility.js';
import { verifyToken } from './tokens.js';

const ALL_SEATS: readonly SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export interface RouterRequest {
  method: string;
  /** URL 的 pathname，例如 /api/state */
  path: string;
  query: URLSearchParams;
  /** 惰性读取请求体；只有 POST 路由会调用 */
  body: () => Promise<Record<string, unknown>>;
}

export type RouterResult =
  | { kind: 'json'; code: number; body: unknown }
  | { kind: 'file'; name: string }
  | { kind: 'stream'; room: Room };

export interface Caller { room: Room; seatId: SeatId | 'HOST'; }

const json = (code: number, body: unknown): RouterResult => ({ kind: 'json', code, body });

export function createRouter(secret: string): (req: RouterRequest) => Promise<RouterResult> {
  function resolve(raw: string | null): Caller | null {
    if (raw === null || raw === '') return null;
    const p = verifyToken(secret, raw, Date.now());
    if (p === null) return null;
    const room = getRoom(p.gameId, secret);
    if (room === undefined) return null;
    // 重发令牌后旧 nonce 立即作废（§7.2）
    if (!room.nonceValid(p.seatId, p.nonce)) return null;
    return { room, seatId: p.seatId === 0 ? 'HOST' : p.seatId };
  }

  return async function route(req: RouterRequest): Promise<RouterResult> {
    const path = req.path;

    if (path === '/') return { kind: 'file', name: 'index.html' };
    if (path === '/app.css') return { kind: 'file', name: 'app.css' };
    if (path.startsWith('/join/')) return { kind: 'file', name: 'player.html' };
    if (path.startsWith('/host/')) return { kind: 'file', name: 'host.html' };

    // ── 建局 ──
    if (path === '/api/create' && req.method === 'POST') {
      const body = await req.body();
      const seed = typeof body['seed'] === 'string' && body['seed'] !== '' ? body['seed'] : `seed-${Date.now()}`;
      const room = createRoom(seed, secret);
      return json(200, {
        ok: true,
        gameId: room.gameId,
        seedCommitment: room.state.seedCommitment,
        hostUrl: `/host/${room.hostToken()}`,
        // 牵头玩家自动占座位 1（§7.2），其余 11 个 magic link 由他私发
        links: ALL_SEATS.map((s) => ({ seatId: s, identity: room.state.seats[s].identity, url: `/join/${room.seatToken(s)}` })),
      });
    }

    if (path === '/api/rooms') {
      return json(200, { ok: true, rooms: listRooms().map((r) => ({ gameId: r.gameId, round: r.state.round, phase: r.state.phase })) });
    }

    const caller = resolve(req.query.get('t'));
    if (caller === null) return json(401, { ok: false, reason: '令牌无效、已过期或已被重发作废' });
    const { room, seatId } = caller;
    if (seatId !== 'HOST') room.connect(seatId);

    // ── 状态 ──
    if (path === '/api/state') {
      return json(200, {
        ok: true,
        seatId: seatId === 'HOST' ? null : seatId,
        isHost: seatId === 'HOST',
        snapshot: snapshotFor(room.state, seatId),
        meta: room.meta(),
      });
    }

    // ── SSE：只推版本号，客户端回来拉自己那一份 ──
    if (path === '/api/stream') return { kind: 'stream', room };

    // ── 动作 ──
    if (path === '/api/act' && req.method === 'POST') {
      const body = await req.body();
      const action = String(body['action'] ?? '');
      const r = seatId === 'HOST' ? hostAction(room, action, body) : playerAction(room, seatId, action, body);
      return json(r.ok ? 200 : 400, r);
    }

    return json(404, { ok: false, reason: '没有这个路由' });
  };
}

// ── 主持端动作 ───────────────────────────────────────────────────────

export function hostAction(room: Room, action: string, body: Record<string, unknown>): { ok: boolean; reason?: string; [k: string]: unknown } {
  switch (action) {
    case 'advance': return room.advance();
    case 'timer': {
      const sec = Number(body['seconds'] ?? 0);
      room.setDeadline(Number.isFinite(sec) && sec > 0 ? sec : null);
      return { ok: true };
    }
    case 'reissue': {
      const seatId = Number(body['seatId']) as SeatId;
      if (!(seatId >= 1 && seatId <= 12)) return { ok: false, reason: '座位号非法' };
      return { ok: true, url: `/join/${room.reissue(seatId)}` };
    }
    case 'links':
      return { ok: true, links: ALL_SEATS.map((s) => ({ seatId: s, url: `/join/${room.seatToken(s)}` })) };
    case 'openVote': return room.openVote();
    case 'closeVote': return room.closeVote();
    default: return { ok: false, reason: `未知的主持端动作：${action}` };
  }
}

// ── 玩家动作 ─────────────────────────────────────────────────────────

export function playerAction(room: Room, seatId: SeatId, action: string, body: Record<string, unknown>): { ok: boolean; reason?: string; [k: string]: unknown } {
  const num = (k: string) => Number(body[k]);
  switch (action) {
    case 'transfer':
      return room.doTransfer(seatId, num('to') as SeatId, num('amount'));
    case 'intel':
      return room.doIntel(seatId, String(body['domain']) as Domain);
    case 'pledge':
      return room.doPledge(seatId, num('funds'), num('ability'));
    case 'submit':
      return room.doSubmit(seatId, body['submission'] as Submission);
    case 'propose':
      return room.propose(seatId, body['proposal'] as never);
    case 'confirm':
      return room.confirm(seatId, String(body['proposalId']));
    case 'reject':
      return room.reject(seatId, String(body['proposalId']));
    case 'cancel':
      return room.doCancel(seatId, String(body['contractId']));
    case 'accuse':
      return room.doAccuse(seatId, String(body['contractId']), String(body['statement']));
    case 'rebut':
      return room.doRebut(seatId, String(body['contractId']), String(body['statement']));
    case 'openConversation':
      return room.openConversation(seatId, (body['with'] as SeatId[]) ?? []);
    case 'closeConversation':
      return room.closeConversation(seatId, String(body['id']));
    case 'vote':
      return room.castVote(seatId, (body['picks'] as Record<string, string>) ?? {});
    default:
      return { ok: false, reason: `未知的玩家动作：${action}` };
  }
}
