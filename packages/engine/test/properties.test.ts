// 性质测试（TDD-001 §11 + 2026-08-27 裁定）：任意合法输入下——
//   资金守恒（独立 oracle 逐座位对账，不依赖引擎自身事件）；
//   在途收益与收款人一致；状态-事件一致；无负余额；结算后锁定清零；
//   abilityCommitted ≤ abilityBase；每人每回合 stamps ≤ 1；同输入重放逐字节一致；
//   到账检查：roundStart 后收款人拿到全额、在途清空。
// 第 1 回合卡面钉为门槛最低的五张，保证中标 / 录取 / 危机成功路径可达；
// 覆盖率由测试末尾的硬断言保证（fc seed 固定，计数确定）。
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Game, PendingPayout, Qualification, SeatId, Submission, SubmissionEntry } from '../src/types.js';
import { lockSubmissions } from '../src/validate.js';
import { settle, type SettleResults, type Team } from '../src/settle.js';
import { roundStart } from '../src/roundStart.js';
import { readyState, seatByIdentity, setRoundCard } from './helpers.js';

const ALL_SEATS: SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const base: Game = (() => {
  const s = readyState('prop-seed');
  setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');    // 无准入, 能力 60, cap 45
  setRoundCard(s, 'WAR', 'WAR_ROYAL_ESCORT');           // 无准入（裁定）, 10/40, 报酬 50
  setRoundCard(s, 'COMMERCE', 'COM_CAPITAL_FAIR');      // 30/20, 收益 55, 风险 0
  setRoundCard(s, 'ADMIN', 'ADM_CADASTRE');             // 无准入, 能力 30, 名额 2
  setRoundCard(s, 'CRISIS', 'CRI_REPAIR_MONASTERY');    // 30/80, 罚 5
  return s;
})();

// ── 生成器 ──────────────────────────────────────────────────────────

interface SeatPlan {
  domains: ('WAR' | 'ENGINEERING' | 'COMMERCE' | 'ADMIN' | 'CRISIS')[];
  warFunds: number; warAbility: number;
  engAbility: number; bid: number;
  comFunds: number; comAbility: number;
  admAbility: number;
  criFunds: number; criAbility: number;
  useQual: boolean;
  pairWar: boolean;   // 国王/骑士两座位生效：合组一支两人战争队
  buyQual: boolean;   // 无资格且余钱充足时申请购买基础资格
}

const PLAN_DOMAINS: ('WAR' | 'ENGINEERING' | 'COMMERCE' | 'ADMIN' | 'CRISIS')[] =
  ['WAR', 'ENGINEERING', 'COMMERCE', 'ADMIN', 'CRISIS'];

function arbPlan(seatId: SeatId): fc.Arbitrary<SeatPlan> {
  const seat = base.seats[seatId];
  return fc.record({
    // 每座位至多 2 个领域：避免比例缩放把数值全部稀释到门槛之下（覆盖率会检验这一点）
    domains: fc.subarray(PLAN_DOMAINS, { maxLength: 2 }),
    warFunds: fc.integer({ min: 0, max: seat.funds }),
    warAbility: fc.integer({ min: 0, max: seat.abilityBase }),
    engAbility: fc.integer({ min: 0, max: seat.abilityBase }),
    bid: fc.integer({ min: 20, max: 50 }),   // 合法区间 [23,45]，两端越界以覆盖 entry 剔除
    comFunds: fc.integer({ min: 0, max: seat.funds }),
    comAbility: fc.integer({ min: 0, max: seat.abilityBase }),
    admAbility: fc.integer({ min: 0, max: seat.abilityBase }),
    criFunds: fc.integer({ min: 0, max: seat.funds }),
    criAbility: fc.integer({ min: 0, max: seat.abilityBase }),
    useQual: fc.boolean(),
    pairWar: fc.boolean(),
    buyQual: fc.boolean(),
  }) as fc.Arbitrary<SeatPlan>;
}

// 国王 + 骑士的确定性战争强队（核心资格 +60，动员 150）：
// 战争门槛较高，纯随机生成难以到达中标路径，用一个生成器开关保证覆盖。
const KING_SEAT = seatByIdentity(base, 'KING');
const KNIGHT_SEAT = seatByIdentity(base, 'KNIGHT');
const PAIR_SEATS: SeatId[] = [KING_SEAT, KNIGHT_SEAT].sort((a, b) => a - b);
const PAIR_PAYEE = PAIR_SEATS[0]!;

function boostPlan(seatId: SeatId): SeatPlan {
  const king = seatId === KING_SEAT;
  return {
    domains: ['WAR'],
    warFunds: king ? 10 : 0,
    warAbility: king ? 20 : 70,
    engAbility: 0, bid: 23, comFunds: 0, comAbility: 0, admAbility: 0, criFunds: 0, criAbility: 0,
    useQual: king,   // 国王声明 CORE：动员 +60
    pairWar: true,
    buyQual: false,
  };
}

// 把计划落为提交：先按比例缩到预算内，再挑一个 entry 附上持有的资格
function planToSubmission(seatId: SeatId, plan: SeatPlan, pairActive: boolean): Submission {
  const seat = base.seats[seatId];
  const want = {
    WAR: { funds: plan.warFunds, ability: plan.warAbility },
    ENGINEERING: { funds: 0, ability: plan.engAbility },
    COMMERCE: { funds: plan.comFunds, ability: plan.comAbility },
    ADMIN: { funds: 0, ability: plan.admAbility },
    CRISIS: { funds: plan.criFunds, ability: plan.criAbility },
  };
  const chosen = plan.domains;
  const fundsSum = chosen.reduce((a, d) => a + want[d].funds, 0);
  const abilitySum = chosen.reduce((a, d) => a + want[d].ability, 0);
  const fundsScale = fundsSum > seat.funds ? seat.funds / fundsSum : 1;
  const abilityScale = abilitySum > seat.abilityBase ? seat.abilityBase / abilitySum : 1;

  const entries: SubmissionEntry[] = [];
  let lockedFunds = 0;
  for (const d of chosen) {
    const funds = Math.floor(want[d].funds * fundsScale);
    const ability = Math.floor(want[d].ability * abilityScale);
    switch (d) {
      case 'WAR': {
        const pair = pairActive && PAIR_SEATS.includes(seatId);
        entries.push({
          domain: 'WAR',
          teamId: pair ? 'pair-war' : `w${seatId}`,
          members: pair ? PAIR_SEATS : [seatId],
          payee: pair ? PAIR_PAYEE : seatId,
          funds, ability,
        });
        lockedFunds += funds;
        break;
      }
      case 'ENGINEERING':
        entries.push({ domain: 'ENGINEERING', teamId: `e${seatId}`, members: [seatId], payee: seatId, ability, bid: plan.bid });
        break;
      case 'COMMERCE':
        entries.push({ domain: 'COMMERCE', teamId: `c${seatId}`, members: [seatId], payee: seatId, funds, ability });
        lockedFunds += funds;
        break;
      case 'ADMIN':
        entries.push({ domain: 'ADMIN', ability });
        break;
      case 'CRISIS':
        entries.push({ domain: 'CRISIS', funds, ability });
        lockedFunds += funds;
        break;
    }
  }

  // 附资格：优先 WAR（动员加成），其次 ENGINEERING / ADMIN（准入 / 选拔优势）
  const held = seat.qualifications[0]?.kind;
  if (plan.useQual && held !== undefined) {
    const target = entries.find((e) => e.domain === 'WAR')
      ?? entries.find((e) => e.domain === 'ENGINEERING')
      ?? entries.find((e) => e.domain === 'ADMIN');
    if (target !== undefined && ('qualificationUsed' in target) === false) {
      (target as { qualificationUsed?: Qualification }).qualificationUsed = held;
    }
  }

  const sub: Submission = { seatId, round: 1, entries };
  // 购买基础资格：无资格且余钱够 20 才申请（避免整份提交因超支被拒）
  if (plan.buyQual && seat.qualifications.length === 0 && lockedFunds + 20 <= seat.funds) {
    sub.qualificationPurchase = true;
  }
  return sub;
}

// ── 独立对账 oracle：不读引擎事件，从提交与结果重算每座位终态资金与在途收益 ──
// （中标者身份取自 results；金额、退款、处罚、购买退款全部在测试内独立重算）

function oracle(accepted: Submission[], r: SettleResults, settledState: Game): {
  funds: Map<SeatId, number>; pending: PendingPayout[];
} {
  const exp = new Map<SeatId, number>(ALL_SEATS.map((k) => [k, base.seats[k].funds]));
  const add = (k: SeatId, v: number) => exp.set(k, exp.get(k)! + v);

  const inWinner = (team: Team | null, seatId: SeatId, teamId: string) =>
    team !== null && team.teamId === teamId && team.members.includes(seatId);

  for (const sub of accepted) {
    add(sub.seatId, -sub.entries.reduce((a, e) => a + ('funds' in e ? e.funds : 0), 0));
    if (sub.qualificationPurchase === true) add(sub.seatId, -20);
    // 落选返还（战争 80% floor；商业全退；危机 / 中标不退）
    for (const e of sub.entries) {
      if (e.domain === 'WAR' && !inWinner(r.war.winner, sub.seatId, e.teamId)) {
        add(sub.seatId, Math.floor(e.funds * 0.8));
      }
      if (e.domain === 'COMMERCE' && !inWinner(r.commerce.winner, sub.seatId, e.teamId)) {
        add(sub.seatId, e.funds);
      }
    }
  }
  // 中标收益：全额入在途，收款人 = 队伍指定 payee（2026-08-27 裁定；队列顺序 = 结算步骤 6 顺序）
  const pending: PendingPayout[] = [];
  if (r.engineering.winner) pending.push({ seatId: r.engineering.winner.payee!, amount: r.engineering.payout, source: 'ENGINEERING', awardedRound: 1 });
  if (r.war.winner) pending.push({ seatId: r.war.winner.payee!, amount: r.war.payout, source: 'WAR', awardedRound: 1 });
  if (r.commerce.winner && r.commerce.result === 'SUCCESS') {
    pending.push({ seatId: r.commerce.winner.payee!, amount: r.commerce.payout, source: 'COMMERCE', awardedRound: 1 });
  }
  // 行政报酬当回合入账
  for (const k of r.admin.selected) add(k, r.admin.payoutEach);
  // 危机处罚（下限 0）——先于购买退款（步骤 7 在步骤 10 之前）
  if (r.crisis.result === 'FAIL') {
    for (const k of ALL_SEATS) exp.set(k, Math.max(0, exp.get(k)! - r.crisis.card.failPenalty!));
  }
  // 购买：印章结算时点数（裁定 #10）。印章是否达标以引擎终态为准（印章逻辑另有专测）
  for (const sub of accepted) {
    if (sub.qualificationPurchase === true && settledState.seats[sub.seatId].stamps.length < 2) {
      add(sub.seatId, 20);   // 不足 → 退还
    }
  }
  return { funds: exp, pending };
}

describe('性质测试', () => {
  const initialTotal = ALL_SEATS.reduce((a, k) => a + base.seats[k].funds, 0);
  const coverage = { ENGINEERING: 0, WAR: 0, COMMERCE: 0, ADMIN: 0, CRISIS_SUCCESS: 0, PURCHASE_REFUND: 0 };

  it('资金守恒（独立 oracle）/ 在途收益 / 无负余额 / 锁定清零 / 能力上限 / 印章上限 / 重放与到账', () => {
    fc.assert(
      fc.property(
        fc.record({ plans: fc.tuple(...ALL_SEATS.map((k) => arbPlan(k))), warBoost: fc.boolean() }),
        ({ plans: rawPlans, warBoost }) => {
          const plans = [...rawPlans];
          if (warBoost) {
            plans[KING_SEAT - 1] = boostPlan(KING_SEAT);
            plans[KNIGHT_SEAT - 1] = boostPlan(KNIGHT_SEAT);
          }
          const pk = plans[KING_SEAT - 1]!, pn = plans[KNIGHT_SEAT - 1]!;
          const pairActive = pk.pairWar && pn.pairWar
            && pk.domains.includes('WAR') && pn.domains.includes('WAR');
          const rawSubs = ALL_SEATS.map((k, i) => planToSubmission(k, plans[i]!, pairActive));
          const lock = lockSubmissions(base, rawSubs);
          const settled = settle(lock.state, lock.accepted, base.seed);
          const s = settled.state;
          const r = settled.results;

          // 覆盖率计数（fc seed 固定，确定可断言）
          if (r.engineering.winner) coverage.ENGINEERING += 1;
          if (r.war.winner) coverage.WAR += 1;
          if (r.commerce.winner) coverage.COMMERCE += 1;
          if (r.admin.selected.length > 0) coverage.ADMIN += 1;
          if (r.crisis.result === 'SUCCESS') coverage.CRISIS_SUCCESS += 1;
          if (settled.events.some((e) => e.type === 'PAYOUT' && e.payload['source'] === 'QUALIFICATION_PURCHASE')) {
            coverage.PURCHASE_REFUND += 1;
          }

          // 无负余额、锁定清零、能力上限
          for (const k of ALL_SEATS) {
            expect(s.seats[k].funds).toBeGreaterThanOrEqual(0);
            expect(s.seats[k].lockedFunds).toBe(0);
            expect(s.seats[k].abilityCommitted).toBeLessThanOrEqual(s.seats[k].abilityBase);
          }

          // 每人本回合 stamps ≤ 1
          for (const k of ALL_SEATS) {
            expect(s.seats[k].stamps.filter((st) => st.round === 1).length).toBeLessThanOrEqual(1);
          }

          // 资金守恒：独立 oracle 逐座位对账 + 在途收益逐笔对账
          const exp = oracle(lock.accepted, r, s);
          for (const k of ALL_SEATS) {
            expect(s.seats[k].funds, `座位 ${k} 终态资金`).toBe(exp.funds.get(k)!);
          }
          expect(s.pendingPayouts).toEqual(exp.pending);

          // 状态-事件一致：事件汇总应与状态变化吻合（补充性检查；在途收益尚未入账）
          const locked = lock.accepted.reduce(
            (a, sub) => a
              + sub.entries.reduce((x, e) => x + ('funds' in e ? e.funds : 0), 0)
              + (sub.qualificationPurchase === true ? 20 : 0),
            0);
          const sumEv = (kind: string) => settled.events
            .filter((e) => e.type === 'PAYOUT' && e.payload['kind'] === kind)
            .reduce((a, e) => a + (e.payload['amount'] as number), 0);
          const penalties = settled.events
            .filter((e) => e.type === 'PENALTY')
            .reduce((a, e) => a + (e.payload['amount'] as number), 0);
          const total = ALL_SEATS.reduce((a, k) => a + s.seats[k].funds, 0);
          expect(total).toBe(initialTotal - locked + sumEv('REFUND') + sumEv('REWARD') - penalties);

          // 到账检查：下一回合开始后收款人拿到全额、在途清空
          const next = roundStart(s);
          for (const p of exp.pending) {
            const delta = exp.pending.filter((x) => x.seatId === p.seatId).reduce((a, x) => a + x.amount, 0);
            expect(next.state.seats[p.seatId].funds).toBe(s.seats[p.seatId].funds + delta);
          }
          expect(next.state.pendingPayouts).toHaveLength(0);

          // 同输入重放逐字节一致
          const lock2 = lockSubmissions(base, rawSubs);
          const settled2 = settle(lock2.state, lock2.accepted, base.seed);
          expect(JSON.stringify(settled2.state)).toBe(JSON.stringify(s));
          expect(JSON.stringify(settled2.events)).toBe(JSON.stringify(settled.events));
        },
      ),
      { numRuns: 80, seed: 42 },
    );

    // 覆盖率硬断言：中标 / 录取 / 危机成功 / 购买退款路径必须真实到达过，
    // 否则守恒断言对相应路径恒真（审查发现的盲区）。
    expect(coverage.ENGINEERING, '工程中标覆盖').toBeGreaterThan(0);
    expect(coverage.WAR, '战争中标覆盖').toBeGreaterThan(0);
    expect(coverage.COMMERCE, '商业中标覆盖').toBeGreaterThan(0);
    expect(coverage.ADMIN, '行政录取覆盖').toBeGreaterThan(0);
    expect(coverage.CRISIS_SUCCESS, '危机成功覆盖').toBeGreaterThan(0);
    expect(coverage.PURCHASE_REFUND, '购买退款覆盖').toBeGreaterThan(0);
  });
});
