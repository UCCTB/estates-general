// Game Server 的 HTTP 层：房间状态、阶段计时、广播、持久化（TDD-001 §3.1）。
// 零运行时依赖——node:http + SSE 就够了。广播只推一个版本号，客户端收到后回来拉
// 自己那一份裁剪过的状态：这样可见性规则只在 visibility.ts 一处执行，不会散在推送里。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Domain, SeatId, Submission } from '@estates/engine';
import { createRoom, getRoom, listRooms, type Room } from './room.js';
import { snapshotFor } from './visibility.js';
import { verifyToken } from './tokens.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

interface Caller { room: Room; seatId: SeatId | 'HOST'; }

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function serveFile(res: ServerResponse, name: string): void {
  const path = join(PUBLIC_DIR, normalize(name).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function startServer(secret: string, port: number): ReturnType<typeof createServer> {
  function resolve(raw: string | null): Caller | null {
    if (raw === null || raw === '') return null;
    const p = verifyToken(secret, raw, Date.now());
    if (p === null) return null;
    const room = getRoom(p.gameId);
    if (room === undefined) return null;
    // 重发令牌后旧 nonce 立即作废（§7.2）
    if (!room.nonceValid(p.seatId, p.nonce)) return null;
    return { room, seatId: p.seatId === 0 ? 'HOST' : p.seatId };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      json(res, 500, { ok: false, reason: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/' ) return serveFile(res, 'index.html');
    if (path === '/app.css') return serveFile(res, 'app.css');
    if (path.startsWith('/join/')) return serveFile(res, 'player.html');
    if (path.startsWith('/host/')) return serveFile(res, 'host.html');

    // ── 建局 ──
    if (path === '/api/create' && req.method === 'POST') {
      const body = await readJson(req);
      const seed = typeof body['seed'] === 'string' && body['seed'] !== '' ? body['seed'] : `seed-${Date.now()}`;
      const room = createRoom(seed, secret);
      const seats: SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      return json(res, 200, {
        ok: true,
        gameId: room.gameId,
        seedCommitment: room.state.seedCommitment,
        hostUrl: `/host/${room.hostToken()}`,
        // 牵头玩家自动占座位 1（§7.2），其余 11 个 magic link 由他私发
        links: seats.map((s) => ({ seatId: s, identity: room.state.seats[s].identity, url: `/join/${room.seatToken(s)}` })),
      });
    }

    if (path === '/api/rooms') {
      return json(res, 200, { ok: true, rooms: listRooms().map((r) => ({ gameId: r.gameId, round: r.state.round, phase: r.state.phase })) });
    }

    const caller = resolve(url.searchParams.get('t'));
    if (caller === null) return json(res, 401, { ok: false, reason: '令牌无效、已过期或已被重发作废' });
    const { room, seatId } = caller;
    if (seatId !== 'HOST') room.connect(seatId);

    // ── 状态 ──
    if (path === '/api/state') {
      return json(res, 200, {
        ok: true,
        seatId: seatId === 'HOST' ? null : seatId,
        isHost: seatId === 'HOST',
        snapshot: snapshotFor(room.state, seatId),
        meta: room.meta(),
      });
    }

    // ── SSE：只推版本号，客户端回来拉自己那一份 ──
    if (path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ v: room.version })}\n\n`);
      const off = room.subscribe(() => res.write(`data: ${JSON.stringify({ v: room.version })}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { off(); clearInterval(ping); });
      return;
    }

    // ── 动作 ──
    if (path === '/api/act' && req.method === 'POST') {
      const body = await readJson(req);
      const action = String(body['action'] ?? '');
      const r = seatId === 'HOST' ? hostAction(room, action, body) : playerAction(room, seatId, action, body);
      return json(res, r.ok ? 200 : 400, r);
    }

    return json(res, 404, { ok: false, reason: '没有这个路由' });
  }

  server.listen(port);
  return server;
}

// ── 主持端动作 ───────────────────────────────────────────────────────

function hostAction(room: Room, action: string, body: Record<string, unknown>): { ok: boolean; reason?: string; [k: string]: unknown } {
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
    case 'links': {
      const seats: SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      return { ok: true, links: seats.map((s) => ({ seatId: s, url: `/join/${room.seatToken(s)}` })) };
    }
    case 'openVote': return room.openVote();
    case 'closeVote': return room.closeVote();
    default: return { ok: false, reason: `未知的主持端动作：${action}` };
  }
}

// ── 玩家动作 ─────────────────────────────────────────────────────────

function playerAction(room: Room, seatId: SeatId, action: string, body: Record<string, unknown>): { ok: boolean; reason?: string; [k: string]: unknown } {
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
