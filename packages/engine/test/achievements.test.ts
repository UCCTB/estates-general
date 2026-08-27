// 成就判定（TDD-002 §5 自动档 / §6 提名档）。
// 每条成就一个正例 + 一个「刚好不满足」的反例——反例比正例重要，它防的是错报。
import { describe, expect, it } from 'vitest';
import type { Game, GameEvent, Round, SeatId } from '../src/types.js';
import type { StandingRow } from '../src/finalStanding.js';
import { emitRoundFacts, type RoundFacts } from '../src/roundFacts.js';
import { evaluateEndgameAchievements, evaluateRoundAchievements, nominationCandidates } from '../src/achievements.js';
import { pledgeCrisis } from '../src/pledge.js';
import { registerNotarizedContract } from '../src/contracts.js';
import { freshState, negotiableState, seatByIdentity } from './helpers.js';

const ALL: SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function facts(round: Round, over: Partial<Omit<RoundFacts, 'seq'>> = {}): Omit<RoundFacts, 'seq'> {
  const zero: Record<string, number> = {};
  for (const s of ALL) zero[String(s)] = 0;
  return {
    round,
    teams: { ENGINEERING: [], WAR: [], COMMERCE: [] },
    winnerTeamId: { ENGINEERING: null, WAR: null, COMMERCE: null },
    winnerMembers: { ENGINEERING: [], WAR: [], COMMERCE: [] },
    projectResult: { ENGINEERING: 'NO_AWARD', WAR: 'NO_AWARD', COMMERCE: 'NO_AWARD', ADMIN: 'NO_AWARD' },
    entryLabel: { ENGINEERING: '无', WAR: '无', COMMERCE: '无', ADMIN: '无' },
    admin: { applicants: [], selected: [] },
    crisis: { result: 'SUCCESS', contributions: {}, fundsTarget: 100, abilityTarget: 200 },
    abilityCommitted: { ...zero },
    gains: { ...zero },
    pledges: { count: 0, funds: 0, ability: 0 },
    ...over,
  };
}

/** 造一个只带 ROUND_FACTS 的状态，直接驱动回合内的自动档判定。 */
function withFacts(...rows: Omit<RoundFacts, 'seq'>[]): Game {
  const s = freshState('ach-seed');
  const out: GameEvent[] = [];
  for (const f of rows) emitRoundFacts(s, out, f);
  return s;
}

function keysOf(s: Game): string[] {
  return s.events.filter((e) => e.type === 'ACHIEVEMENT_AUTO').map((e) => e.payload['key'] as string);
}

function runRound(s: Game, round: Round): string[] {
  const out: GameEvent[] = [];
  evaluateRoundAchievements(s, out, round);
  return out.filter((e) => e.type === 'ACHIEVEMENT_AUTO').map((e) => e.payload['key'] as string);
}

// ── 危机承诺（TDD-002 §9.2 CR-2）─────────────────────────────────────

describe('公开承诺 pledgeCrisis（TDD-002 §9.2）', () => {
  it('只在 NEGOTIATION 阶段受理；同回合后登记覆盖前一条；事件公开', () => {
    const ready = freshState();
    expect(pledgeCrisis(ready, 1, 10, 10).ok).toBe(false);   // ROUND_START 阶段

    let s = negotiableState();
    const cap = Math.min(20, s.seats[1].abilityBase);
    const r1 = pledgeCrisis(s, 1, 10, cap);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    s = r1.state;
    expect(r1.events[0]!.visibility).toBe('PUBLIC');
    expect(r1.events[0]!.type).toBe('CRISIS_PLEDGED');

    const r2 = pledgeCrisis(s, 1, 30, cap);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.crisisPledges.filter((p) => p.seatId === 1 && p.round === 1)).toHaveLength(1);
    expect(r2.state.crisisPledges.find((p) => p.seatId === 1)!.funds).toBe(30);
  });

  it('承诺不动任何资源——它只是一句被记录下来的话', () => {
    const s = negotiableState();
    const before = s.seats[1].funds;
    const r = pledgeCrisis(s, 1, 999, 0);   // 允许吹牛：承诺可以超过持有量
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.seats[1].funds).toBe(before);
    expect(r.state.seats[1].lockedFunds).toBe(s.seats[1].lockedFunds);
  });

  it('能力承诺不得超过身份卡基础值（越界属输入错误，不是策略）', () => {
    const s = negotiableState();
    expect(pledgeCrisis(s, 1, 0, s.seats[1].abilityBase + 1).ok).toBe(false);
    expect(pledgeCrisis(s, 1, 0, s.seats[1].abilityBase).ok).toBe(true);
  });
});

// ── 自动档：回合内 ───────────────────────────────────────────────────

describe('【公地悲剧】（规则书 §17.3）', () => {
  it('危机失败 + 承诺总量足以完成 → 解锁', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'FAIL', contributions: {}, fundsTarget: 100, abilityTarget: 200 },
      pledges: { count: 12, funds: 100, ability: 200 },
    }));
    expect(runRound(s, 1)).toContain('TRAGEDY_OF_COMMONS');
  });

  it('承诺差 1 点 → 不解锁', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'FAIL', contributions: {}, fundsTarget: 100, abilityTarget: 200 },
      pledges: { count: 12, funds: 100, ability: 199 },
    }));
    expect(runRound(s, 1)).not.toContain('TRAGEDY_OF_COMMONS');
  });

  it('危机成功 → 不解锁（哪怕承诺富余）', () => {
    const s = withFacts(facts(1, { pledges: { count: 12, funds: 999, ability: 999 } }));
    expect(runRound(s, 1)).not.toContain('TRAGEDY_OF_COMMONS');
  });
});

describe('【最后一个傻瓜】（规则书 §17.3）', () => {
  it('危机失败且某人贡献超过目标的 30% → 解锁', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'FAIL', contributions: { '4': { funds: 31, ability: 0 } }, fundsTarget: 100, abilityTarget: 200 },
    }));
    const got = runRound(s, 1);
    expect(got).toContain('LAST_FOOL');
    const ev = s.events.find((e) => e.type === 'ACHIEVEMENT_AUTO' && e.payload['key'] === 'LAST_FOOL')!;
    expect((ev.payload['subjects'] as SeatId[])).toEqual([4]);
  });

  it('恰好 30%（不是「超过」）→ 不解锁', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'FAIL', contributions: { '4': { funds: 30, ability: 60 } }, fundsTarget: 100, abilityTarget: 200 },
    }));
    expect(runRound(s, 1)).not.toContain('LAST_FOOL');
  });
});

describe('【共同体】（规则书 §17.3）', () => {
  const contrib = (funds: number, ability: number) =>
    Object.fromEntries(ALL.map((s) => [String(s), { funds: funds / 12, ability: ability / 12 }]));

  it('12 席全部承诺且实际与约定差额不超过一成 → 解锁', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'SUCCESS', contributions: contrib(96, 192), fundsTarget: 90, abilityTarget: 180 },
      pledges: { count: 12, funds: 100, ability: 200 },
    }));
    expect(runRound(s, 1)).toContain('COMMUNITY');
  });

  it('只有 11 席承诺 → 不解锁（原文要求 12 人形成完整方案）', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'SUCCESS', contributions: contrib(100, 200), fundsTarget: 90, abilityTarget: 180 },
      pledges: { count: 11, funds: 100, ability: 200 },
    }));
    expect(runRound(s, 1)).not.toContain('COMMUNITY');
  });

  it('偏差 11% → 不解锁', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'SUCCESS', contributions: contrib(89, 200), fundsTarget: 80, abilityTarget: 180 },
      pledges: { count: 12, funds: 100, ability: 200 },
    }));
    expect(runRound(s, 1)).not.toContain('COMMUNITY');
  });
});

describe('【同工不同酬】（规则书 §17.4）', () => {
  it('同能力、收益相差 100% → 解锁', () => {
    const s = withFacts(facts(1, {
      abilityCommitted: { ...Object.fromEntries(ALL.map((x) => [String(x), 0])), '2': 40, '5': 40 },
      gains: { ...Object.fromEntries(ALL.map((x) => [String(x), 0])), '2': 60, '5': 30 },
    }));
    expect(runRound(s, 1)).toContain('EQUAL_WORK_UNEQUAL_PAY');
  });

  it('差距不到 100% → 不解锁', () => {
    const s = withFacts(facts(1, {
      abilityCommitted: { ...Object.fromEntries(ALL.map((x) => [String(x), 0])), '2': 40, '5': 40 },
      gains: { ...Object.fromEntries(ALL.map((x) => [String(x), 0])), '2': 59, '5': 30 },
    }));
    expect(runRound(s, 1)).not.toContain('EQUAL_WORK_UNEQUAL_PAY');
  });

  it('能力投入为 0 的两人不算「同工」', () => {
    const s = withFacts(facts(1, {
      gains: { ...Object.fromEntries(ALL.map((x) => [String(x), 0])), '2': 100 },
    }));
    expect(runRound(s, 1)).not.toContain('EQUAL_WORK_UNEQUAL_PAY');
  });
});

describe('【金融市场】（规则书 §17.3）', () => {
  function withContracts(n: number): Game {
    let s = negotiableState('fin-seed');
    const pairs: [SeatId, SeatId][] = [[1, 2], [3, 4], [5, 6], [7, 8]];
    for (let i = 0; i < n; i++) {
      const [a, b] = pairs[i]!;
      const r = registerNotarizedContract(s, {
        parties: [a, b], payer: a, payee: b,
        trigger: { kind: 'PLAYER_AWARDED', round: 1, domain: 'COMMERCE', seat: a, awarded: true },
        amount: 10, escrowed: false, expiresRound: 1, feeSplit: [5, 0],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return s;
      s = r.state;
    }
    const out: GameEvent[] = [];
    emitRoundFacts(s, out, facts(1));
    return s;
  }

  it('3 份以未来结果为条件、未托管的契约 → 解锁', () => {
    expect(runRound(withContracts(3), 1)).toContain('FINANCIAL_MARKET');
  });

  it('只有 2 份 → 不解锁', () => {
    expect(runRound(withContracts(2), 1)).not.toContain('FINANCIAL_MARKET');
  });
});

describe('一局只解锁一次（TDD-002 §5.2）', () => {
  it('连续两回合都满足，只发一次 ACHIEVEMENT_AUTO', () => {
    const fail = (r: Round) => facts(r, {
      crisis: { result: 'FAIL', contributions: {}, fundsTarget: 100, abilityTarget: 200 },
      pledges: { count: 12, funds: 100, ability: 200 },
    });
    const s = withFacts(fail(1), fail(2));
    runRound(s, 1);
    runRound(s, 2);
    expect(keysOf(s).filter((k) => k === 'TRAGEDY_OF_COMMONS')).toHaveLength(1);
  });
});

// ── 自动档：终局 ─────────────────────────────────────────────────────

function standing(over: Partial<StandingRow>[] = []): StandingRow[] {
  return ALL.map((seatId, i) => ({
    seatId,
    identity: 'PEASANT',
    funds: 10, stampsTotal: 0, stampsEffective: 0, recordsTotal: 0,
    highestQualification: 'NONE', qualified: false, rank: null, winner: false,
    overallRank: i + 1,
    ...(over[i] ?? {}),
  } as StandingRow));
}

describe('终局自动档（TDD-002 §5.2）', () => {
  it('【钱不是万能的】资金最高者未过线 → 解锁；过线则不解锁', () => {
    const s = freshState();
    const rich = standing();
    rich[0] = { ...rich[0]!, funds: 999, qualified: false };
    expect(evaluateEndgameAchievements(s, rich).map((a) => a.key)).toContain('MONEY_IS_NOT_ENOUGH');

    const ok = standing();
    ok[0] = { ...ok[0]!, funds: 999, qualified: true };
    expect(evaluateEndgameAchievements(s, ok).map((a) => a.key)).not.toContain('MONEY_IS_NOT_ENOUGH');
  });

  it('【身份不是命运】开局无资格者排在四大身份中至少三人之前', () => {
    const s = freshState();
    const peasant = seatByIdentity(s, 'PEASANT');
    const rows = standing();
    // 让农民排第 1，四大身份全排在后面
    for (const r of rows) {
      r.identity = s.seats[r.seatId].identity;
      r.overallRank = r.seatId === peasant ? 1 : r.seatId + 1;
    }
    expect(evaluateEndgameAchievements(s, rows).map((a) => a.key)).toContain('BIRTH_IS_NOT_DESTINY');

    // 四大身份占据前四名、农民垫底 → 不解锁
    const four = ['KING', 'QUEEN', 'BISHOP', 'NOBLE'];
    const head = rows.filter((r) => four.includes(r.identity)).map((r) => r.seatId);
    const tail = rows.filter((r) => !four.includes(r.identity) && r.seatId !== peasant).map((r) => r.seatId);
    const order = [...head, ...tail, peasant];
    const rows2 = rows.map((r) => ({ ...r, overallRank: order.indexOf(r.seatId) + 1 }));
    expect(evaluateEndgameAchievements(s, rows2).map((a) => a.key)).not.toContain('BIRTH_IS_NOT_DESTINY');
  });

  it('【从农民到贵族】开局无资格 + 终局持高级资格 + 进前 6', () => {
    const s = freshState();
    const peasant = seatByIdentity(s, 'PEASANT');
    s.seats[peasant].qualifications = [{ kind: 'ENGINEERING', usedThisRound: false, acquiredRound: 4 }];
    const rows = standing();
    rows[peasant - 1] = { ...rows[peasant - 1]!, winner: true, highestQualification: 'ENGINEERING' };
    expect(evaluateEndgameAchievements(s, rows).map((a) => a.key)).toContain('PEASANT_TO_NOBLE');

    // 没进前 6 → 不解锁
    const rows2 = rows.map((r) => ({ ...r, winner: false }));
    expect(evaluateEndgameAchievements(s, rows2).map((a) => a.key)).not.toContain('PEASANT_TO_NOBLE');
  });

  it('国王开局就有核心资格，不适用「开局无资格」两条', () => {
    const s = freshState();
    const king = seatByIdentity(s, 'KING');
    s.seats[king].qualifications = [{ kind: 'CORE', usedThisRound: false, acquiredRound: 0 }];
    const rows = standing();
    rows[king - 1] = { ...rows[king - 1]!, winner: true, highestQualification: 'CORE' };
    const keys = evaluateEndgameAchievements(s, rows).map((a) => a.key);
    expect(keys).not.toContain('PEASANT_TO_NOBLE');
  });
});

describe('确定性（TDD-002 §10）', () => {
  it('同一终态重复调用输出逐字节相同', () => {
    const s = withFacts(facts(1, {
      crisis: { result: 'FAIL', contributions: { '4': { funds: 90, ability: 0 } }, fundsTarget: 100, abilityTarget: 200 },
      pledges: { count: 12, funds: 100, ability: 200 },
    }));
    const a = JSON.stringify(nominationCandidates(s));
    const b = JSON.stringify(nominationCandidates(s));
    expect(a).toBe(b);
    const rows = standing();
    expect(JSON.stringify(evaluateEndgameAchievements(s, rows)))
      .toBe(JSON.stringify(evaluateEndgameAchievements(s, rows)));
  });
});
