// 契约引擎测试（TDD-001 §5 / §9 / §11 阶段 2 Done 标准）：
// 失信路径全覆盖（paid=0、0<paid<amount、多契约耗尽余额）、托管、六种触发正反例、
// 到期作废、危机处罚先于契约、收益到账时序、备忘契约指控/反驳限次、转账、
// 随机契约组合下的守恒性质测试（独立 oracle）。
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Game, SeatId, Submission } from '../src/types.js';
import { lockSubmissions } from '../src/validate.js';
import { settle } from '../src/settle.js';
import { roundStart } from '../src/roundStart.js';
import { beginNegotiation } from '../src/phases.js';
import { transfer } from '../src/transfer.js';
import {
  accuseMemoContract, cancelNotarizedContract, registerMemoContract,
  registerNotarizedContract, rebutMemoContract, type NotarizedDraft,
} from '../src/contracts.js';
import { readyState, seatByIdentity, setRoundCard } from './helpers.js';

const SEED = 'test-seed';
const P = 5;   // 修复修道院 failPenalty

// 进入第 1 回合谈判阶段，危机钉为最温和卡
function negoState(seed = SEED): Game {
  const s = readyState(seed);
  setRoundCard(s, 'CRISIS', 'CRI_REPAIR_MONASTERY');
  return beginNegotiation(s);
}

function mustRegister(state: Game, draft: NotarizedDraft): Game {
  const r = registerNotarizedContract(state, draft);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}

function settleRound(state: Game, subs: Submission[] = []) {
  const lock = lockSubmissions(state, subs);
  expect(lock.rejected).toHaveLength(0);
  return settle(lock.state, lock.accepted, state.seed);
}

function contract(s: Game, id: string) {
  return s.contracts.find((c) => c.contractId === id)!;
}

describe('公证契约登记（§9.1）', () => {
  it('登记费按 feeSplit 立即扣除（消耗）；事件 PUBLIC + PARTIES 双份', () => {
    const s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');
    const queen = seatByIdentity(s, 'QUEEN');
    const r = registerNotarizedContract(s, {
      parties: [noble, queen], payer: noble, payee: queen,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 20,
      escrowed: false, expiresRound: 2, feeSplit: [3, 2],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.seats[noble].funds).toBe(50 - 3);
    expect(r.state.seats[queen].funds).toBe(30 - 2);
    const regs = r.events.filter((e) => e.type === 'CONTRACT_REGISTERED');
    expect(regs.map((e) => e.visibility).sort()).toEqual(['PARTIES', 'PUBLIC']);
    // PUBLIC 事件不含条款（条款私密，§5.1）
    const pub = regs.find((e) => e.visibility === 'PUBLIC')!;
    expect(pub.payload['amount']).toBeUndefined();
    expect(pub.payload['trigger']).toBeUndefined();
  });

  it('校验拒绝：余额不足付费、托管非 ROUND_START、金额越界、非谈判阶段、feeSplit 不合', () => {
    const s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');
    const queen = seatByIdentity(s, 'QUEEN');
    const peasant = seatByIdentity(s, 'PEASANT');   // 资金 10
    const base: NotarizedDraft = {
      parties: [noble, queen], payer: noble, payee: queen,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 20,
      escrowed: false, expiresRound: 2, feeSplit: [5, 0],
    };
    // 余额不足（费 5 + 托管 10 > 农民资金 10）
    expect(registerNotarizedContract(s, { ...base, parties: [peasant, queen], payer: peasant, feeSplit: [5, 0], amount: 10, escrowed: true }).ok).toBe(false);
    // 托管仅对 ROUND_START
    expect(registerNotarizedContract(s, { ...base, trigger: { kind: 'CRISIS_RESULT', round: 1, result: 'FAIL' }, expiresRound: 1, escrowed: true }).ok).toBe(false);
    // 金额越界（TODO(TDD-001 C.5) 上限 200）
    expect(registerNotarizedContract(s, { ...base, amount: 0 }).ok).toBe(false);
    expect(registerNotarizedContract(s, { ...base, amount: 201 }).ok).toBe(false);
    // feeSplit 和不为 5
    expect(registerNotarizedContract(s, { ...base, feeSplit: [3, 3] }).ok).toBe(false);
    // 回合开始类触发必须晚于当前回合
    expect(registerNotarizedContract(s, { ...base, trigger: { kind: 'ROUND_START', round: 1 }, expiresRound: 1 }).ok).toBe(false);
    // 非谈判阶段
    const s2 = readyState();   // REVEAL_AND_INTEL
    expect(registerNotarizedContract(s2, base).ok).toBe(false);
  });
});

describe('条件付款与失信（§5.4 / §5.5：短缺不结转、无负余额）', () => {
  it('余额充足 → FULFILLED；收款人到账', () => {
    let s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');
    const queen = seatByIdentity(s, 'QUEEN');
    s = mustRegister(s, {
      parties: [noble, queen], payer: noble, payee: queen,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 20,
      escrowed: false, expiresRound: 2, feeSplit: [5, 0],
    });
    const settled = settleRound(s);
    const next = roundStart(settled.state);
    expect(contract(next.state, 'C001').status).toBe('FULFILLED');
    expect(next.state.seats[noble].funds).toBe(50 - 5 - P - 20);
    expect(next.state.seats[queen].funds).toBe(30 - P + 20);
    expect(next.events.some((e) => e.type === 'CONTRACT_FULFILLED')).toBe(true);
    expect(next.state.seats[noble].defaults).toHaveLength(0);
  });

  it('paid = 0 → DEFAULTED + 公开失信记录', () => {
    let s = negoState();
    const peasant = seatByIdentity(s, 'PEASANT');   // 资金 10
    const noble = seatByIdentity(s, 'NOBLE');
    s = mustRegister(s, {
      parties: [peasant, noble], payer: peasant, payee: noble,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 20,
      escrowed: false, expiresRound: 2, feeSplit: [0, 5],
    });
    // 农民把钱全捐给危机 → 到期分文没有
    const settled = settleRound(s, [
      { seatId: peasant, round: 1, entries: [{ domain: 'CRISIS', funds: 10, ability: 90 }] },
    ]);
    const next = roundStart(settled.state);
    const c = contract(next.state, 'C001');
    expect(c.status).toBe('DEFAULTED');
    expect(next.state.seats[peasant].funds).toBe(0);
    expect(next.state.seats[peasant].defaults).toEqual([
      { round: 2, contractId: 'C001', payee: noble, owed: 20, paid: 0, shortfall: 20 },
    ]);
    const ev = next.events.find((e) => e.type === 'CONTRACT_DEFAULTED')!;
    expect(ev.visibility).toBe('PUBLIC');
    expect(ev.payload['shortfall']).toBe(20);
  });

  it('0 < paid < amount → PARTIAL_DEFAULT，付到余额清零', () => {
    let s = negoState();
    const peasant = seatByIdentity(s, 'PEASANT');   // 10 → 危机罚后 5
    const noble = seatByIdentity(s, 'NOBLE');
    s = mustRegister(s, {
      parties: [peasant, noble], payer: peasant, payee: noble,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 20,
      escrowed: false, expiresRound: 2, feeSplit: [0, 5],
    });
    const settled = settleRound(s);
    const next = roundStart(settled.state);
    expect(contract(next.state, 'C001').status).toBe('PARTIAL_DEFAULT');
    expect(next.state.seats[peasant].funds).toBe(0);
    expect(next.state.seats[peasant].defaults[0]).toEqual(
      { round: 2, contractId: 'C001', payee: noble, owed: 20, paid: 10 - P, shortfall: 20 - (10 - P) });
    expect(next.state.seats[noble].funds).toBe(50 - 5 - P + (10 - P));
  });

  it('同一触发点多契约按 registeredAt 升序执行，后续契约失信（§10.2）', () => {
    let s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');   // 50
    const queen = seatByIdentity(s, 'QUEEN');
    const king = seatByIdentity(s, 'KING');
    s = mustRegister(s, {
      parties: [noble, queen], payer: noble, payee: queen,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 30,
      escrowed: false, expiresRound: 2, feeSplit: [5, 0],
    });
    s = mustRegister(s, {
      parties: [noble, king], payer: noble, payee: king,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 30,
      escrowed: false, expiresRound: 2, feeSplit: [5, 0],
    });
    // noble：50 − 10（两笔登记费）− 5（危机罚）= 35 → C001 付 30 → 剩 5 → C002 付 5，欠 25
    const settled = settleRound(s);
    const next = roundStart(settled.state);
    expect(contract(next.state, 'C001').status).toBe('FULFILLED');
    expect(contract(next.state, 'C002').status).toBe('PARTIAL_DEFAULT');
    expect(next.state.seats[noble].funds).toBe(0);
    expect(next.state.seats[noble].defaults).toEqual([
      { round: 2, contractId: 'C002', payee: king, owed: 30, paid: 5, shortfall: 25 },
    ]);
  });
});

describe('托管（§5.4：仅 ROUND_START；触发转付 / 取消与作废退回）', () => {
  it('托管付款不受付款方破产影响', () => {
    let s = negoState();
    const king = seatByIdentity(s, 'KING');     // 20
    const knight = seatByIdentity(s, 'KNIGHT');
    s = mustRegister(s, {
      parties: [king, knight], payer: king, payee: knight,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 5,
      escrowed: true, expiresRound: 2, feeSplit: [5, 0],
    });
    expect(s.seats[king].funds).toBe(20 - 5 - 5);
    expect(s.seats[king].lockedFunds).toBe(5);
    const settled = settleRound(s);
    const next = roundStart(settled.state);
    expect(contract(next.state, 'C001').status).toBe('FULFILLED');
    expect(next.state.seats[king].lockedFunds).toBe(0);
    expect(next.state.seats[knight].funds).toBe(10 - P + 5);
    // 关键：托管从锁定支付，付款方余额不动（防双扣回归）
    expect(next.state.seats[king].funds).toBe(20 - 5 - 5 - P);
    expect(next.state.seats[king].defaults).toHaveLength(0);
  });

  it('双方确认取消：托管退回，登记费不退', () => {
    let s = negoState();
    const king = seatByIdentity(s, 'KING');
    const knight = seatByIdentity(s, 'KNIGHT');
    s = mustRegister(s, {
      parties: [king, knight], payer: king, payee: knight,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 5,
      escrowed: true, expiresRound: 2, feeSplit: [5, 0],
    });
    const r = cancelNotarizedContract(s, 'C001');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(contract(r.state, 'C001').status).toBe('CANCELLED');
    expect(r.state.seats[king].funds).toBe(20 - 5);   // 托管退回，费不退
    expect(r.state.seats[king].lockedFunds).toBe(0);
  });
});

describe('结算类触发（§5.2 / §6.2 步骤 8）', () => {
  // 商人+市民赢下商业项目的公共布置
  function commerceScenario() {
    let s = negoState();
    setRoundCard(s, 'COMMERCE', 'COM_CAPITAL_FAIR');   // 30/20, 收益 55, 风险 0
    const merchant = seatByIdentity(s, 'MERCHANT');
    const burgher = seatByIdentity(s, 'BURGHER');
    const noble = seatByIdentity(s, 'NOBLE');
    const team: SeatId[] = [merchant, burgher].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: merchant, round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 40, ability: 10 }] },
      { seatId: burgher,  round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 0, ability: 30 }] },
    ];
    return { s, merchant, burgher, noble, subs };
  }

  it('PROJECT_RESULT(COMMERCE, SUCCESS) 步骤 8 触发——先于中标收益到账，可致失信（时序后果）', () => {
    const sc = commerceScenario();
    let s = mustRegister(sc.s, {
      parties: [sc.merchant, sc.noble], payer: sc.merchant, payee: sc.noble,
      trigger: { kind: 'PROJECT_RESULT', round: 1, domain: 'COMMERCE', result: 'SUCCESS' },
      amount: 40, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    const settled = settleRound(s, sc.subs);
    const c = contract(settled.state, 'C001');
    // 商人：70 − 40 投入 − 5 危机罚 = 25；55 收益还在途 → 只付得出 25
    expect(c.status).toBe('PARTIAL_DEFAULT');
    expect(settled.state.seats[sc.merchant].funds).toBe(0);
    expect(settled.state.seats[sc.merchant].defaults[0]!.shortfall).toBe(15);
    expect(settled.state.pendingPayouts).toEqual([
      { seatId: sc.merchant, amount: 55, source: 'COMMERCE', awardedRound: 1 },
    ]);
  });

  it('同样的债务改用 ROUND_START(下一回合) 触发——收益先到账，足额履行', () => {
    const sc = commerceScenario();
    let s = mustRegister(sc.s, {
      parties: [sc.merchant, sc.noble], payer: sc.merchant, payee: sc.noble,
      trigger: { kind: 'ROUND_START', round: 2 },
      amount: 40, escrowed: false, expiresRound: 2, feeSplit: [0, 5],
    });
    const settled = settleRound(s, sc.subs);
    const next = roundStart(settled.state);
    expect(contract(next.state, 'C001').status).toBe('FULFILLED');
    // 商人：70 − 40 − 5 = 25 → 到账 +55 = 80 → 付 40 = 40
    expect(next.state.seats[sc.merchant].funds).toBe(40);
    expect(next.state.seats[sc.merchant].defaults).toHaveLength(0);
  });

  it('PLAYER_AWARDED 正反例（含「未申请也算未中标」）', () => {
    const sc = commerceScenario();
    let s = sc.s;
    // 正例：商人中标（商业队 members 含商人）→ awarded true 成立
    s = mustRegister(s, {
      parties: [sc.merchant, sc.noble], payer: sc.noble, payee: sc.merchant,
      trigger: { kind: 'PLAYER_AWARDED', round: 1, domain: 'COMMERCE', seat: sc.merchant, awarded: true },
      amount: 10, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    // 反例条件成立：国王未申请战争 → awarded false 匹配
    const king = seatByIdentity(s, 'KING');
    s = mustRegister(s, {
      parties: [sc.noble, king], payer: sc.noble, payee: king,
      trigger: { kind: 'PLAYER_AWARDED', round: 1, domain: 'WAR', seat: king, awarded: false },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [5, 0],
    });
    // 不成立的条件：市民 awarded false（实际中标了）→ 到期作废
    s = mustRegister(s, {
      parties: [sc.noble, sc.burgher], payer: sc.noble, payee: sc.burgher,
      trigger: { kind: 'PLAYER_AWARDED', round: 1, domain: 'COMMERCE', seat: sc.burgher, awarded: false },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [5, 0],
    });
    const settled = settleRound(s, sc.subs);
    expect(contract(settled.state, 'C001').status).toBe('FULFILLED');
    expect(contract(settled.state, 'C002').status).toBe('FULFILLED');
    expect(contract(settled.state, 'C003').status).toBe('VOID');
    expect(settled.events.filter((e) => e.type === 'CONTRACT_VOID')).toHaveLength(1);
  });

  it('CRISIS_RESULT 与 CRISIS_CONTRIBUTION（达标/未达标）', () => {
    let s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');
    const peasant = seatByIdentity(s, 'PEASANT');
    const king = seatByIdentity(s, 'KING');
    // 危机将成功：noble 30 资金 + peasant 80 能力
    // 登记费由收款方贵族承担，避免国王被三笔费掏空影响履约断言
    s = mustRegister(s, {
      parties: [king, noble], payer: king, payee: noble,
      trigger: { kind: 'CRISIS_RESULT', round: 1, result: 'SUCCESS' },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    s = mustRegister(s, {
      parties: [king, noble], payer: king, payee: noble,
      trigger: { kind: 'CRISIS_CONTRIBUTION', round: 1, seat: noble, resource: 'FUNDS', atLeast: 30 },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    s = mustRegister(s, {
      parties: [king, noble], payer: king, payee: noble,
      trigger: { kind: 'CRISIS_CONTRIBUTION', round: 1, seat: noble, resource: 'FUNDS', atLeast: 31 },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    const settled = settleRound(s, [
      { seatId: noble,   round: 1, entries: [{ domain: 'CRISIS', funds: 30, ability: 0 }] },
      { seatId: peasant, round: 1, entries: [{ domain: 'CRISIS', funds: 0, ability: 80 }] },
    ]);
    expect(settled.results.crisis.result).toBe('SUCCESS');
    expect(contract(settled.state, 'C001').status).toBe('FULFILLED');
    expect(contract(settled.state, 'C002').status).toBe('FULFILLED');
    expect(contract(settled.state, 'C003').status).toBe('VOID');   // 31 未达标 → 到期作废
  });

  it('CRISIS_CONTRIBUTION 的 ABILITY 口径（达标/未达标）', () => {
    let s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');
    const peasant = seatByIdentity(s, 'PEASANT');
    const king = seatByIdentity(s, 'KING');
    s = mustRegister(s, {
      parties: [king, noble], payer: king, payee: noble,
      trigger: { kind: 'CRISIS_CONTRIBUTION', round: 1, seat: peasant, resource: 'ABILITY', atLeast: 80 },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    s = mustRegister(s, {
      parties: [king, noble], payer: king, payee: noble,
      trigger: { kind: 'CRISIS_CONTRIBUTION', round: 1, seat: peasant, resource: 'ABILITY', atLeast: 81 },
      amount: 5, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    // 农民投 80 能力 0 资金：ABILITY≥80 成立，≥81 不成立（且不得误读 funds）
    const settled = settleRound(s, [
      { seatId: noble,   round: 1, entries: [{ domain: 'CRISIS', funds: 30, ability: 0 }] },
      { seatId: peasant, round: 1, entries: [{ domain: 'CRISIS', funds: 0, ability: 80 }] },
    ]);
    expect(settled.results.crisis.result).toBe('SUCCESS');
    expect(contract(settled.state, 'C001').status).toBe('FULFILLED');
    expect(contract(settled.state, 'C002').status).toBe('VOID');
  });

  it('危机处罚先于契约执行（§6.1 原则 3 / §10.2）', () => {
    let s = negoState();
    setRoundCard(s, 'CRISIS', 'CRI_GREAT_PLAGUE');   // 目标 90/200 必失败 → 全员 -20
    const king = seatByIdentity(s, 'KING');   // 20
    const noble = seatByIdentity(s, 'NOBLE');
    s = mustRegister(s, {
      parties: [king, noble], payer: king, payee: noble,
      trigger: { kind: 'CRISIS_RESULT', round: 1, result: 'FAIL' },
      amount: 15, escrowed: false, expiresRound: 1, feeSplit: [0, 5],
    });
    const settled = settleRound(s);
    // 国王 20 → 罚 20 → 0 → 契约全额失信（paid = 0）
    expect(contract(settled.state, 'C001').status).toBe('DEFAULTED');
    expect(settled.state.seats[king].funds).toBe(0);
    expect(settled.state.seats[king].defaults[0]!.paid).toBe(0);
  });
});

describe('QUALIFICATION_GAINED（roundStart 步骤 b，在步骤 a 之后判定）', () => {
  it('购买生效当回合开始即触发', () => {
    let s = negoState();
    const merchant = seatByIdentity(s, 'MERCHANT');
    const noble = seatByIdentity(s, 'NOBLE');
    s.seats[merchant].stamps.push({ round: 1, source: 'COMMERCE' }, { round: 2, source: 'COMMERCE' });
    s = mustRegister(s, {
      parties: [noble, merchant], payer: noble, payee: merchant,
      trigger: { kind: 'QUALIFICATION_GAINED', seat: merchant, kind_: 'BASIC', byRound: 2 },
      amount: 10, escrowed: false, expiresRound: 2, feeSplit: [5, 0],
    });
    const settled = settleRound(s, [
      { seatId: merchant, round: 1, entries: [], qualificationPurchase: true },
    ]);
    const next = roundStart(settled.state);
    expect(next.state.seats[merchant].qualifications[0]!.kind).toBe('BASIC');
    expect(contract(next.state, 'C001').status).toBe('FULFILLED');
    expect(next.state.seats[merchant].funds).toBe(70 - 20 - P + 10);
  });

  it('byRound 到期未取得 → VOID', () => {
    let s = negoState();
    const merchant = seatByIdentity(s, 'MERCHANT');
    const noble = seatByIdentity(s, 'NOBLE');
    s = mustRegister(s, {
      parties: [noble, merchant], payer: noble, payee: merchant,
      trigger: { kind: 'QUALIFICATION_GAINED', seat: merchant, kind_: 'BASIC', byRound: 2 },
      amount: 10, escrowed: false, expiresRound: 2, feeSplit: [5, 0],
    });
    const settled = settleRound(s);
    const next = roundStart(settled.state);
    expect(contract(next.state, 'C001').status).toBe('VOID');
    expect(next.state.seats[noble].defaults).toHaveLength(0);   // 作废不计失信
  });
});

describe('备忘契约（§5.7）', () => {
  it('免费登记；指控 → DISPUTED；反驳附加；每人每回合各限 1 次', () => {
    let s = negoState();
    const noble = seatByIdentity(s, 'NOBLE');
    const peasant = seatByIdentity(s, 'PEASANT');
    const before = s.seats[noble].funds;
    const reg = registerMemoContract(s, {
      parties: [noble, peasant], summary: '农民下回合还 20', kind: 'GENERAL',
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    s = reg.state;
    expect(s.seats[noble].funds).toBe(before);   // 免费
    expect(contract(s, 'C001').status).toBe('OPEN');

    const acc = accuseMemoContract(s, 'C001', noble, '农民没还钱');
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    s = acc.state;
    expect(contract(s, 'C001').status).toBe('DISPUTED');
    // 同回合第二次指控被拒
    expect(accuseMemoContract(s, 'C001', noble, '再骂一次').ok).toBe(false);

    const reb = rebutMemoContract(s, 'C001', peasant, '收成不好，下回合一定还');
    expect(reb.ok).toBe(true);
    if (!reb.ok) return;
    s = reb.state;
    const memo = contract(s, 'C001');
    expect(memo.tier).toBe('MEMO');
    if (memo.tier !== 'MEMO') return;
    expect(memo.accusations[0]!.rebuttal?.statement).toContain('收成');
    expect(memo.status).toBe('DISPUTED');   // 反驳不改状态
    // 同回合第二次反驳被拒；无指控可反驳也被拒
    expect(rebutMemoContract(s, 'C001', peasant, '再辩一次').ok).toBe(false);
    // 非当事人不可指控
    const king = seatByIdentity(s, 'KING');
    expect(accuseMemoContract(s, 'C001', king, '路见不平').ok).toBe(false);
  });

  it('INTEL_RELAY 需要完整 intelClaim；摘要超 140 字被拒', () => {
    const s = negoState();
    const scholar = seatByIdentity(s, 'SCHOLAR');
    const merchant = seatByIdentity(s, 'MERCHANT');
    expect(registerMemoContract(s, {
      parties: [scholar, merchant], summary: '卖你一条情报', kind: 'INTEL_RELAY',
    }).ok).toBe(false);
    expect(registerMemoContract(s, {
      parties: [scholar, merchant], summary: '啰'.repeat(141), kind: 'GENERAL',
    }).ok).toBe(false);
    // TDD-002 §9.1 CR-1：缺 relayFrom / relayFrom 不是当事人 → 拒绝
    expect(registerMemoContract(s, {
      parties: [scholar, merchant], summary: '下回合商业最低出资', kind: 'INTEL_RELAY',
      intelClaim: { target: { round: 2, domain: 'COMMERCE' }, field: 'minFunds', claimedValue: 40 },
    }).ok).toBe(false);
    expect(registerMemoContract(s, {
      parties: [scholar, merchant], summary: '下回合商业最低出资', kind: 'INTEL_RELAY',
      intelClaim: { target: { round: 2, domain: 'COMMERCE' }, field: 'minFunds', claimedValue: 40 },
      relayFrom: seatByIdentity(s, 'KING'),
    }).ok).toBe(false);
    const okRelay = registerMemoContract(s, {
      parties: [scholar, merchant], summary: '下回合商业最低出资', kind: 'INTEL_RELAY',
      intelClaim: { target: { round: 2, domain: 'COMMERCE' }, field: 'minFunds', claimedValue: 40 },
      relayFrom: scholar,
    });
    expect(okRelay.ok).toBe(true);
    if (!okRelay.ok) return;
    const memo = okRelay.state.contracts.find((c) => c.contractId === okRelay.contractId)!;
    expect(memo.tier === 'MEMO' && memo.relayFrom).toBe(scholar);
  });
});

describe('转账（约束 2 / §3.2 冻结窗口）', () => {
  it('开放阶段即时转账；冻结阶段拒绝；余额不足拒绝', () => {
    const s0 = readyState();   // REVEAL_AND_INTEL：开放
    const noble = seatByIdentity(s0, 'NOBLE');
    const peasant = seatByIdentity(s0, 'PEASANT');
    const r = transfer(s0, noble, peasant, 15);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.seats[noble].funds).toBe(35);
    expect(r.state.seats[peasant].funds).toBe(25);
    expect(r.events[0]!.type).toBe('TRANSFER');

    expect(transfer(r.state, noble, peasant, 100).ok).toBe(false);   // 余额不足
    const lock = lockSubmissions(beginNegotiation(r.state), []);
    expect(transfer(lock.state, noble, peasant, 1).ok).toBe(false);  // SUBMISSION 冻结
  });
});

describe('性质：随机 ROUND_START 契约下的守恒 / 无负余额 / 失信一致（独立 oracle）', () => {
  const ALL_SEATS: SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const PAIRS: [SeatId, SeatId][] = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]];

  it('登记费消耗、托管转付、条件付款级联、失信记录逐笔对账', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({
          pairIdx: fc.integer({ min: 0, max: 5 }),
          amount: fc.integer({ min: 1, max: 40 }),
          escrowed: fc.boolean(),
          feeToPayer: fc.boolean(),
        }), { maxLength: 6 }),
        (drafts) => {
          let s = negoState('prop-contracts');
          interface Reg { payer: SeatId; payee: SeatId; amount: number; escrowed: boolean }
          const regs: Reg[] = [];
          for (const d of drafts) {
            const [payer, payee] = PAIRS[d.pairIdx]!;
            const r = registerNotarizedContract(s, {
              parties: [payer, payee], payer, payee,
              trigger: { kind: 'ROUND_START', round: 2 }, amount: d.amount,
              escrowed: d.escrowed, expiresRound: 2,
              feeSplit: d.feeToPayer ? [5, 0] : [0, 5],
            });
            if (r.ok) {
              s = r.state;
              regs.push({ payer, payee, amount: d.amount, escrowed: d.escrowed });
            }
          }
          // 登记后守恒：初始 300 − 每份登记费 5（托管在 lockedFunds 里，未消失）
          const sum = (g: Game) => ALL_SEATS.reduce((a, k) => a + g.seats[k].funds + g.seats[k].lockedFunds, 0);
          expect(sum(s)).toBe(300 - 5 * regs.length);

          const settled = settleRound(s);
          const next = roundStart(settled.state);

          // 独立 oracle：从结算后余额起，按登记顺序模拟步骤 b
          const funds = new Map<SeatId, number>(ALL_SEATS.map((k) => [k, settled.state.seats[k].funds]));
          const expectedShortfalls: { payer: SeatId; shortfall: number }[] = [];
          for (const g of regs) {
            if (g.escrowed) {
              funds.set(g.payee, funds.get(g.payee)! + g.amount);
            } else {
              const paid = Math.min(funds.get(g.payer)!, g.amount);
              funds.set(g.payer, funds.get(g.payer)! - paid);
              funds.set(g.payee, funds.get(g.payee)! + paid);
              if (paid < g.amount) expectedShortfalls.push({ payer: g.payer, shortfall: g.amount - paid });
            }
          }
          for (const k of ALL_SEATS) {
            expect(next.state.seats[k].funds, `座位 ${k} 终态资金`).toBe(funds.get(k)!);
            expect(next.state.seats[k].lockedFunds).toBe(0);
            expect(next.state.seats[k].funds).toBeGreaterThanOrEqual(0);
          }
          // 失信记录逐笔对账（多重集比较）
          const actual = ALL_SEATS
            .flatMap((k) => next.state.seats[k].defaults.map((d) => ({ payer: k, shortfall: d.shortfall })));
          const key = (x: { payer: number; shortfall: number }) => `${x.payer}:${x.shortfall}`;
          expect(actual.map(key).sort()).toEqual(expectedShortfalls.map(key).sort());
          // 全局守恒：初始 − 登记费 − 危机处罚（契约转账与托管转付都是内部转移）
          const penalties = settled.events
            .filter((e) => e.type === 'PENALTY')
            .reduce((a, e) => a + (e.payload['amount'] as number), 0);
          expect(sum(next.state)).toBe(300 - 5 * regs.length - penalties);
        },
      ),
      { numRuns: 50, seed: 7 },
    );
  });
});

describe('六回合收口（§5.6：终局后无契约仍 ACTIVE）', () => {
  it('跑完 6 回合后所有契约都到达终态；作废托管退回', () => {
    let s = negoState();
    const king = seatByIdentity(s, 'KING');
    const knight = seatByIdentity(s, 'KNIGHT');
    const noble = seatByIdentity(s, 'NOBLE');
    // 一笔托管（第 2 回合触发）+ 一笔远期结算类（第 6 回合条件不会成立 → 到期作废）
    s = mustRegister(s, {
      parties: [king, knight], payer: king, payee: knight,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 5,
      escrowed: true, expiresRound: 2, feeSplit: [5, 0],
    });
    s = mustRegister(s, {
      parties: [noble, king], payer: noble, payee: king,
      trigger: { kind: 'PROJECT_RESULT', round: 6, domain: 'WAR', result: 'SUCCESS' },
      amount: 10, escrowed: false, expiresRound: 6, feeSplit: [5, 0],
    });
    let state: Game = s;
    for (let r = 1; r <= 6; r++) {
      const settled = settleRound(state);
      state = settled.state;
      if (r < 6) state = beginNegotiation(roundStart(state).state);
    }
    expect(state.phase).toBe('GAME_END');
    for (const c of state.contracts) {
      expect(c.status === 'ACTIVE').toBe(false);
    }
    expect(contract(state, 'C001').status).toBe('FULFILLED');
    expect(contract(state, 'C002').status).toBe('VOID');
    for (const k of Object.keys(state.seats).map(Number) as SeatId[]) {
      expect(state.seats[k].lockedFunds).toBe(0);
      expect(state.seats[k].funds).toBeGreaterThanOrEqual(0);
    }
  });
});
