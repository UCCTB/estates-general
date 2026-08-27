// 阶段 3 的 Done 标准（TDD-001 §14）：12 个浏览器 tab 可完整跑一局。
// 这里用 12 个独立 HTTP 客户端替代 12 个 tab——每个只拿到自己那份令牌，
// 只能看到自己那份状态，全程只走公开 API。跑完 6 回合到终局投票为止。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { startServer } from '../src/http.js';

let server: Server;
let base = '';
let hostToken = '';
const seatToken: Record<number, string> = {};
const SEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const tokenOf = (url: string) => decodeURIComponent(url.replace(/^\/(join|host)\//, ''));

async function api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(base + path, init);
  return await r.json() as Record<string, unknown>;
}

async function act(token: string, action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await api(`/api/act?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
}

async function state(token: string): Promise<{ snapshot: Record<string, unknown>; meta: Record<string, unknown> }> {
  const r = await api(`/api/state?t=${encodeURIComponent(token)}`);
  return r as unknown as { snapshot: Record<string, unknown>; meta: Record<string, unknown> };
}

const phaseOf = async (t: string) => (await state(t)).snapshot['phase'] as string;

beforeAll(async () => {
  // 不装 fsStore（那是 main.ts 的事），所以整局只在内存里，测试不落盘
  server = startServer('test-secret', 0);
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const created = await api('/api/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: 'server-test' }),
  });
  expect(created['ok']).toBe(true);
  hostToken = tokenOf(created['hostUrl'] as string);
  for (const l of created['links'] as { seatId: number; url: string }[]) seatToken[l.seatId] = tokenOf(l.url);
});

afterAll(() => { server.close(); });

describe('座位令牌（TDD-001 §7）', () => {
  it('签发 12 条 magic link + 1 个主持端令牌', () => {
    expect(Object.keys(seatToken)).toHaveLength(12);
    expect(hostToken).not.toBe('');
  });

  it('伪造 / 改签名的令牌一律拒绝', async () => {
    const bad = seatToken[1]!.slice(0, -3) + 'aaa';
    const r = await api(`/api/state?t=${encodeURIComponent(bad)}`);
    expect(r['ok']).toBe(false);
  });

  it('重发令牌后旧链接立刻作废，新链接继承座位全部状态', async () => {
    const old = seatToken[12]!;
    const before = (await state(old)).snapshot['you'] as { funds: number };
    const r = await act(hostToken, 'reissue', { seatId: 12 });
    expect(r['ok']).toBe(true);
    expect((await api(`/api/state?t=${encodeURIComponent(old)}`))['ok']).toBe(false);
    seatToken[12] = tokenOf(r['url'] as string);
    const after = (await state(seatToken[12]!)).snapshot['you'] as { funds: number };
    expect(after.funds).toBe(before.funds);
  });

  it('玩家令牌不能推进阶段', async () => {
    const r = await act(seatToken[2]!, 'advance');
    expect(r['ok']).toBe(false);
  });
});

describe('可见性（TDD-001 §8.1 / §5.1）', () => {
  it('别人的可用余额与锁定额不拆分，情报揭示只给本人', async () => {
    const s = (await state(seatToken[3]!)).snapshot;
    const seats = s['seats'] as { seatId: number; holdings: number }[];
    expect(seats).toHaveLength(12);
    for (const x of seats) expect(Object.keys(x)).not.toContain('lockedFunds');
    expect(s['you']).not.toBeNull();
    expect(s['intelReveals']).toEqual([]);
  });

  it('HOST 事件不下发给玩家', async () => {
    const asPlayer = (await state(seatToken[3]!)).snapshot['events'] as { visibility: string }[];
    expect(asPlayer.every((e) => e.visibility !== 'HOST')).toBe(true);
    const asHost = (await state(hostToken)).snapshot['events'] as { visibility: string }[];
    expect(asHost.some((e) => e.visibility === 'HOST')).toBe(true);
  });
});

describe('完整一局：6 回合 → 终局投票', () => {
  it('12 席各自登录、谈判、提交，主持端逐阶段推进', async () => {
    for (let round = 1; round <= 6; round++) {
      expect(await phaseOf(hostToken)).toBe('ROUND_START');
      expect((await act(hostToken, 'advance'))['ok']).toBe(true);
      expect(await phaseOf(hostToken)).toBe('REVEAL_AND_INTEL');

      // 情报阶段：找一个还有情报权的座位侦察（第 6 回合没有下一回合，一定会被拒）
      const seats = (await state(hostToken)).snapshot['seats'] as { seatId: number; intel: number; holdings: number; abilityBase: number }[];
      const scout = seats.find((x) => x.intel > 0);
      if (scout !== undefined) {
        const intel = await act(seatToken[scout.seatId]!, 'intel', { domain: 'COMMERCE' });
        expect(intel['ok']).toBe(round < 6);
      }

      expect((await act(hostToken, 'advance'))['ok']).toBe(true);
      expect(await phaseOf(hostToken)).toBe('NEGOTIATION');

      if (round === 1) {
        // 谈话 → 契约提案 → 对方确认。见证人由谈话推导（§9.1 步骤 4）。
        // 付款方要付得起登记费 5 + 托管 10，所以按持有额挑三个座位，不写死座位号。
        const rich = [...seats].sort((a, b) => b.holdings - a.holdings).map((x) => x.seatId);
        const [A, B, W] = [rich[0]!, rich[1]!, rich[2]!];
        const stranger = rich.find((x) => x !== A && x !== B && x !== W)!;
        expect((await act(seatToken[A]!, 'openConversation', { with: [B, W] }))['ok']).toBe(true);
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
        expect(p['ok']).toBe(true);
        // 提案只对收件人有效；由发起人自己确认应当被拒
        expect((await act(seatToken[A]!, 'confirm', { proposalId: p['proposalId'] }))['ok']).toBe(false);
        const c = await act(seatToken[B]!, 'confirm', { proposalId: p['proposalId'] });
        expect(c['ok'], JSON.stringify(c)).toBe(true);
        const terms = ((await state(seatToken[W]!)).snapshot['contracts'] as { contractId: string; terms: unknown }[])
          .find((x) => x.contractId === c['contractId']);
        expect(terms?.terms).not.toBeNull();      // 见证人看得到条款（§5.1）
        const outsider = ((await state(seatToken[stranger]!)).snapshot['contracts'] as { contractId: string; terms: unknown }[])
          .find((x) => x.contractId === c['contractId']);
        expect(outsider?.terms).toBeNull();       // 局外人只看得到存在与当事人
      }

      // 转账：找一个还付得起的座位转 5 给别人（后几回合大家都被结算榨干了，所以要挑）
      const nowSeats = (await state(hostToken)).snapshot['seats'] as { seatId: number; holdings: number; abilityBase: number }[];
      const donor = nowSeats.find((x) => x.holdings >= 5);
      if (donor !== undefined) {
        const to = nowSeats.find((x) => x.seatId !== donor.seatId)!.seatId;
        expect((await act(seatToken[donor.seatId]!, 'transfer', { to, amount: 5 }))['ok']).toBe(true);
      }
      // 危机承诺：12 席全部登记（承诺不消耗资源，能力不得超过身份卡基础值）
      for (const s of SEATS) {
        const me = nowSeats.find((x) => x.seatId === s)!;
        const r = await act(seatToken[s]!, 'pledge', { funds: 5, ability: Math.min(10, me.abilityBase) });
        expect(r['ok'], JSON.stringify(r)).toBe(true);
      }

      expect((await act(hostToken, 'advance'))['ok']).toBe(true);
      expect(await phaseOf(hostToken)).toBe('SUBMISSION');

      // 11 席提交危机贡献，座位 11 故意不提交（§7.3 缺席按空提交处理）
      for (const s of SEATS) {
        if (s === 11) continue;
        const you = (await state(seatToken[s]!)).snapshot['you'] as { funds: number; abilityBase: number };
        const r = await act(seatToken[s]!, 'submit', {
          submission: { entries: [{ domain: 'CRISIS', funds: Math.min(5, you.funds), ability: Math.min(10, you.abilityBase) }] },
        });
        expect(r['ok'], JSON.stringify(r)).toBe(true);
      }
      // 提交后不得修改
      expect((await act(seatToken[1]!, 'submit', {
        submission: { entries: [{ domain: 'CRISIS', funds: 0, ability: 0 }] },
      }))['ok']).toBe(false);

      expect((await act(hostToken, 'advance'))['ok']).toBe(true);
    }

    expect(await phaseOf(hostToken)).toBe('GAME_END');

    // 终局：三层结局已生成，种子公开
    const fin = await state(hostToken);
    const ending = fin.meta['ending'] as { title: string; era: { name: string }; passCount: number };
    expect(ending).not.toBeNull();
    expect(ending.title).toContain('《');
    expect(fin.snapshot['seed']).toBe('server-test');

    // 投票：开票 → 12 席各投一票 → 收票计票
    expect((await act(hostToken, 'openVote'))['ok']).toBe(true);
    const ballot = (await state(seatToken[1]!)).meta['ballot'] as { questions: { id: string; options: { id: string }[] }[] };
    expect(ballot.questions.length).toBeGreaterThanOrEqual(2);
    const picks: Record<string, string> = {};
    for (const q of ballot.questions) picks[q.id] = q.options[0]!.id;
    for (const s of SEATS) {
      expect((await act(seatToken[s]!, 'vote', { picks }))['ok']).toBe(true);
    }
    expect((await act(hostToken, 'closeVote'))['ok']).toBe(true);

    const done = await state(hostToken);
    expect((done.meta['tallyLines'] as unknown[]).length).toBeGreaterThan(0);
    expect((done.meta['ballotOpen'])).toBe(false);
    // 【等值不等势】12 票同意，跨过规则书 §17.4 的 9 票门槛
    const awards = done.meta['nominatedAwards'] as { key: string }[];
    expect(awards.map((a) => a.key)).toContain('EQUAL_VALUE_UNEQUAL_POWER');
  }, 60_000);
});
