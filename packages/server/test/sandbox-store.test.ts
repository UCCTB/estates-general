// 浏览器沙盒（packages/web）的房间仓库是 localStorage：每次请求把房间从 JSON 还原出来，
// 跑完 router 再整个写回去。这里就用一个「每次请求都过一遍 JSON」的仓库跑完整一局——
// Room.toJSON() 少存一个字段，这条测试就会在那个字段被用到的那一步炸掉。
//
// 同时这也是沙盒唯一的自动化防线：浏览器里那层只是换传输（fetch / BroadcastChannel），
// 路由、令牌、可见性、动作白名单跑的都是这儿测的同一份 createRouter。
import { beforeAll, describe, expect, it } from 'vitest';
import { Room, setRoomStore, type RoomData, type RoomStore } from '../src/room.js';
import { createRouter, type RouterRequest } from '../src/router.js';

const SECRET = 'sandbox-test';
const SEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** localStorage 的替身：只认字符串，所以每次 get 都是一次完整的 JSON 往返。 */
const disk = new Map<string, string>();
let writes = 0;

const jsonStore: RoomStore = {
  get(gameId, secret) {
    const raw = disk.get(gameId);
    return raw === undefined ? undefined : Room.restore(JSON.parse(raw) as RoomData, secret);
  },
  put(room) {
    writes += 1;
    disk.set(room.gameId, JSON.stringify(room.toJSON()));
  },
  list() {
    return [...disk.values()].map((raw) => Room.restore(JSON.parse(raw) as RoomData, SECRET));
  },
};

const route = createRouter(SECRET);

async function call(path: string, token: string | null, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(token === null ? {} : { t: token });
  const req: RouterRequest = {
    method: Object.keys(body).length > 0 || path === '/api/create' ? 'POST' : 'GET',
    path,
    query,
    body: () => Promise.resolve(body),
  };
  const out = await route(req);
  if (out.kind !== 'json') return { ok: true, kind: out.kind };
  return out.body as Record<string, unknown>;
}

const act = (token: string, action: string, extra: Record<string, unknown> = {}) =>
  call('/api/act', token, { action, ...extra });

const state = async (token: string) =>
  await call('/api/state', token) as unknown as { snapshot: Record<string, unknown>; meta: Record<string, unknown> };

const phaseOf = async (t: string) => (await state(t)).snapshot['phase'] as string;

const tokenOf = (url: string) => decodeURIComponent(url.replace(/^\/(join|host)\//, ''));

let hostToken = '';
const seatToken: Record<number, string> = {};

beforeAll(async () => {
  setRoomStore(jsonStore);
  const created = await call('/api/create', null, { seed: 'sandbox-seed' });
  expect(created['ok']).toBe(true);
  hostToken = tokenOf(created['hostUrl'] as string);
  for (const l of created['links'] as { seatId: number; url: string }[]) seatToken[l.seatId] = tokenOf(l.url);
});

describe('沙盒仓库：每次请求都把房间序列化一遍', () => {
  it('令牌在 JSON 往返之后照样验得过（nonce 存进了快照）', async () => {
    const s = await state(seatToken[1]!);
    expect(s.snapshot['gameId']).toBeTypeOf('string');
    expect(s.snapshot['seedCommitment']).toHaveLength(64);
  });

  it('重发令牌换掉的 nonce 也在快照里，旧链接过不去', async () => {
    const old = seatToken[12]!;
    const r = await act(hostToken, 'reissue', { seatId: 12 });
    expect(r['ok']).toBe(true);
    expect((await call('/api/state', old))['ok']).toBe(false);
    seatToken[12] = tokenOf(r['url'] as string);
    expect((await state(seatToken[12]!)).snapshot['you']).not.toBeNull();
  });

  it('谈话与契约提案是纯服务端侧状态，也必须活过序列化', async () => {
    await act(hostToken, 'advance');                       // → REVEAL_AND_INTEL
    expect((await act(seatToken[1]!, 'openConversation', { with: [2, 3] }))['ok']).toBe(true);
    // 换一个 tab（= 重新从 JSON 还原）来看，同一场谈话得还在
    const seen = (await state(seatToken[2]!)).meta['conversations'] as { participants: number[] }[];
    expect(seen).toHaveLength(1);
    expect(seen[0]!.participants).toEqual([1, 2, 3]);
  });

  it('整局 6 回合 + 终局投票全程走 JSON 往返', async () => {
    expect(await phaseOf(hostToken)).toBe('REVEAL_AND_INTEL');

    for (let round = 1; round <= 6; round++) {
      if (round > 1) {
        expect(await phaseOf(hostToken)).toBe('ROUND_START');
        await act(hostToken, 'advance');                   // → REVEAL_AND_INTEL
        await act(hostToken, 'advance');                   // → NEGOTIATION
      } else {
        await act(hostToken, 'advance');                   // → NEGOTIATION
      }
      expect(await phaseOf(hostToken)).toBe('NEGOTIATION');

      if (round === 1) {
        // 公证契约：提案 → 对方确认 → 见证人（同一场谈话里的第三人）看得到条款
        const seats = (await state(hostToken)).snapshot['seats'] as { seatId: number; holdings: number }[];
        const rich = [...seats].sort((a, b) => b.holdings - a.holdings).map((x) => x.seatId);
        const [A, B, W] = [rich[0]!, rich[1]!, rich[2]!];
        await act(seatToken[A]!, 'openConversation', { with: [B, W] });
        const p = await act(seatToken[A]!, 'propose', {
          proposal: {
            to: B, kind: 'NOTARIZED', summary: '第 2 回合开始付 10',
            notarized: {
              parties: [A, B], payer: A, payee: B,
              trigger: { kind: 'ROUND_START', round: 2 },
              amount: 10, escrowed: true, expiresRound: 2, feeSplit: [5, 0],
            },
          },
        });
        expect(p['ok'], JSON.stringify(p)).toBe(true);
        // 提案本身也在快照里：确认它的是「另一个 tab 还原出来的房间」
        const c = await act(seatToken[B]!, 'confirm', { proposalId: p['proposalId'] });
        expect(c['ok'], JSON.stringify(c)).toBe(true);
        const asWitness = ((await state(seatToken[W]!)).snapshot['contracts'] as { contractId: string; terms: unknown }[])
          .find((x) => x.contractId === c['contractId']);
        expect(asWitness?.terms).not.toBeNull();
      }

      const nowSeats = (await state(hostToken)).snapshot['seats'] as { seatId: number; abilityBase: number }[];
      for (const s of SEATS) {
        const me = nowSeats.find((x) => x.seatId === s)!;
        expect((await act(seatToken[s]!, 'pledge', { funds: 5, ability: Math.min(10, me.abilityBase) }))['ok']).toBe(true);
      }

      await act(hostToken, 'advance');                     // → SUBMISSION
      expect(await phaseOf(hostToken)).toBe('SUBMISSION');

      for (const s of SEATS) {
        const you = (await state(seatToken[s]!)).snapshot['you'] as { funds: number; abilityBase: number };
        const r = await act(seatToken[s]!, 'submit', {
          submission: { entries: [{ domain: 'CRISIS', funds: Math.min(5, you.funds), ability: Math.min(10, you.abilityBase) }] },
        });
        expect(r['ok'], JSON.stringify(r)).toBe(true);
      }
      // accepted 也在快照里：换个 tab 重复提交照样被挡
      expect((await act(seatToken[1]!, 'submit', { submission: { entries: [] } }))['ok']).toBe(false);

      await act(hostToken, 'advance');                     // → 结算
    }

    expect(await phaseOf(hostToken)).toBe('GAME_END');

    const fin = await state(hostToken);
    const ending = fin.meta['ending'] as { title: string; passCount: number };
    expect(ending).not.toBeNull();
    expect(ending.title).toContain('《');
    expect(fin.snapshot['seed']).toBe('sandbox-seed');

    // ending / ballot / nominations / autoAwards 都是终局才产生的字段，逐个过一遍序列化
    expect((await act(hostToken, 'openVote'))['ok']).toBe(true);
    const ballot = (await state(seatToken[1]!)).meta['ballot'] as { questions: { id: string; options: { id: string }[] }[] };
    expect(ballot.questions.length).toBeGreaterThanOrEqual(2);
    const picks: Record<string, string> = {};
    for (const q of ballot.questions) picks[q.id] = q.options[0]!.id;
    for (const s of SEATS) expect((await act(seatToken[s]!, 'vote', { picks }))['ok']).toBe(true);
    expect((await act(hostToken, 'closeVote'))['ok']).toBe(true);

    const done = await state(hostToken);
    expect((done.meta['tallyLines'] as unknown[]).length).toBeGreaterThan(0);
    expect(done.meta['ballotOpen']).toBe(false);
    expect((done.meta['votesCast'] as number[])).toHaveLength(12);
    expect(writes).toBeGreaterThan(100);   // 确实每次变更都写回去了
  }, 60_000);

  it('最终快照再往返一次，meta 与全量事件逐字节相同', async () => {
    const gameId = (await state(hostToken)).snapshot['gameId'] as string;
    const raw = disk.get(gameId)!;
    const again = JSON.stringify(Room.restore(JSON.parse(raw) as RoomData, SECRET).toJSON());
    expect(again).toBe(raw);
  });
});
