// TDD-001 §10.1 提交校验：每条规则正反例。
import { describe, expect, it } from 'vitest';
import type { Submission } from '../src/types.js';
import { lockSubmissions } from '../src/validate.js';
import { negotiableState, seatByIdentity, setRoundCard } from './helpers.js';

describe('lockSubmissions（TDD-001 §10.1）', () => {
  it('资金超限 → 拒绝整份提交', () => {
    const s = negotiableState();
    const peasant = seatByIdentity(s, 'PEASANT');   // 资金 10
    const sub: Submission = {
      seatId: peasant, round: 1,
      entries: [{ domain: 'CRISIS', funds: 11, ability: 0 }],
    };
    const r = lockSubmissions(s, [sub]);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('资金不足');
    expect(r.state.seats[peasant].funds).toBe(10);   // 未锁定
  });

  it('能力超限 → 拒绝整份提交', () => {
    const s = negotiableState();
    const king = seatByIdentity(s, 'KING');   // 能力 20
    const sub: Submission = {
      seatId: king, round: 1,
      entries: [{ domain: 'CRISIS', funds: 0, ability: 21 }],
    };
    const r = lockSubmissions(s, [sub]);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('能力超限');
  });

  it('多 entry 拆分能力合法（规则书 §5.2），总和超限拒绝', () => {
    const s = negotiableState();
    const peasant = seatByIdentity(s, 'PEASANT');   // 能力 90
    const ok: Submission = {
      seatId: peasant, round: 1,
      entries: [
        { domain: 'ENGINEERING', teamId: 't1', members: [peasant], payee: peasant, ability: 50, bid: Math.ceil(s.decks.ENGINEERING[0]!.budgetCap! * 0.5) },
        { domain: 'CRISIS', funds: 0, ability: 40 },
      ],
    };
    expect(lockSubmissions(s, [ok]).accepted).toHaveLength(1);
    const over: Submission = {
      seatId: peasant, round: 1,
      entries: [
        { domain: 'ENGINEERING', teamId: 't1', members: [peasant], payee: peasant, ability: 60, bid: Math.ceil(s.decks.ENGINEERING[0]!.budgetCap! * 0.5) },
        { domain: 'CRISIS', funds: 0, ability: 40 },
      ],
    };
    expect(lockSubmissions(s, [over]).accepted).toHaveLength(0);
  });

  it('未持有 / 已用 / 重复使用的资格 → 拒绝整份提交', () => {
    const s = negotiableState();
    const peasant = seatByIdentity(s, 'PEASANT');   // 无资格
    const notHeld: Submission = {
      seatId: peasant, round: 1,
      entries: [{ domain: 'WAR', teamId: 'w', members: [peasant], payee: peasant, funds: 0, ability: 10, qualificationUsed: 'ORG' }],
    };
    expect(lockSubmissions(s, [notHeld]).rejected[0]!.reason).toContain('未持有');

    const king = seatByIdentity(s, 'KING');
    const dup: Submission = {
      seatId: king, round: 1,
      entries: [
        { domain: 'WAR', teamId: 'w1', members: [king], payee: king, funds: 0, ability: 10, qualificationUsed: 'CORE' },
        { domain: 'ADMIN', ability: 10, qualificationUsed: 'CORE' },
      ],
    };
    expect(lockSubmissions(s, [dup]).rejected[0]!.reason).toContain('重复使用');

    // 已用：先把资格标记为本回合已使用
    const s2 = negotiableState();
    const king2 = seatByIdentity(s2, 'KING');
    s2.seats[king2].qualifications[0]!.usedThisRound = true;
    const used: Submission = {
      seatId: king2, round: 1,
      entries: [{ domain: 'WAR', teamId: 'w', members: [king2], payee: king2, funds: 0, ability: 10, qualificationUsed: 'CORE' }],
    };
    expect(lockSubmissions(s2, [used]).rejected[0]!.reason).toContain('已使用');
  });

  it('工程 bid 越界 → 仅拒绝该 entry，其余保留', () => {
    const s = negotiableState();
    setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');   // cap 45，合法 [23, 45]
    const peasant = seatByIdentity(s, 'PEASANT');
    const sub: Submission = {
      seatId: peasant, round: 1,
      entries: [
        { domain: 'ENGINEERING', teamId: 't1', members: [peasant], payee: peasant, ability: 60, bid: 22 },   // 低于下限
        { domain: 'CRISIS', funds: 0, ability: 30 },
      ],
    };
    const r = lockSubmissions(s, [sub]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.entries).toHaveLength(1);
    expect(r.accepted[0]!.entries[0]!.domain).toBe('CRISIS');
  });

  it('ADMIN / CRISIS entry 多于一条 → 拒绝整份提交', () => {
    const s = negotiableState();
    const scholar = seatByIdentity(s, 'SCHOLAR');
    const twoAdmin: Submission = {
      seatId: scholar, round: 1,
      entries: [{ domain: 'ADMIN', ability: 10 }, { domain: 'ADMIN', ability: 10 }],
    };
    expect(lockSubmissions(s, [twoAdmin]).rejected[0]!.reason).toContain('ADMIN');
    const twoCrisis: Submission = {
      seatId: scholar, round: 1,
      entries: [{ domain: 'CRISIS', funds: 0, ability: 10 }, { domain: 'CRISIS', funds: 0, ability: 10 }],
    };
    expect(lockSubmissions(s, [twoCrisis]).rejected[0]!.reason).toContain('CRISIS');
  });

  it('qualificationPurchase：已持有资格 → 拒绝该字段，提交其余部分保留', () => {
    const s = negotiableState();
    const king = seatByIdentity(s, 'KING');   // 持核心资格
    const sub: Submission = {
      seatId: king, round: 1,
      entries: [{ domain: 'CRISIS', funds: 10, ability: 0 }],
      qualificationPurchase: true,
    };
    const r = lockSubmissions(s, [sub]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.qualificationPurchase).toBeUndefined();
    // 只锁了危机的 10，没有购买的 20
    expect(r.state.seats[king].lockedFunds).toBe(10);
  });

  it('qualificationPurchase：无资格即可锁定 20（印章在结算时点数，2026-08-27 裁定 #10）', () => {
    const s = negotiableState();
    const merchant = seatByIdentity(s, 'MERCHANT');   // 无资格、无印章——照样锁定，结算时不足则退
    const sub: Submission = { seatId: merchant, round: 1, entries: [], qualificationPurchase: true };
    const r = lockSubmissions(s, [sub]);
    expect(r.accepted[0]!.qualificationPurchase).toBe(true);
    expect(r.state.seats[merchant].lockedFunds).toBe(20);
    expect(r.state.seats[merchant].funds).toBe(70 - 20);
  });

  it('锁定后 funds/lockedFunds/abilityCommitted/usedThisRound 正确', () => {
    const s = negotiableState();
    const king = seatByIdentity(s, 'KING');
    const sub: Submission = {
      seatId: king, round: 1,
      entries: [{ domain: 'WAR', teamId: 'w', members: [king], payee: king, funds: 15, ability: 20, qualificationUsed: 'CORE' }],
    };
    const r = lockSubmissions(s, [sub]);
    const seat = r.state.seats[king];
    expect(seat.funds).toBe(5);
    expect(seat.lockedFunds).toBe(15);
    expect(seat.abilityCommitted).toBe(20);
    expect(seat.qualifications[0]!.usedThisRound).toBe(true);
    expect(r.events.some((e) => e.type === 'SUBMISSION_LOCKED')).toBe(true);
  });

  it('members 不含提交者本人 → 该 entry 被剔除', () => {
    const s = negotiableState();
    const king = seatByIdentity(s, 'KING');
    const queen = seatByIdentity(s, 'QUEEN');
    const sub: Submission = {
      seatId: king, round: 1,
      entries: [{ domain: 'WAR', teamId: 'w', members: [queen], payee: queen, funds: 5, ability: 10 }],
    };
    const r = lockSubmissions(s, [sub]);
    expect(r.accepted[0]!.entries).toHaveLength(0);
  });
});
