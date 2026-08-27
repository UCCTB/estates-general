// TDD-001 §6.2 结算流水线场景测试（固定 seed），含 2026-08-27 五项裁定：
//   资格严格按卡面列举（无高低替代）；行政「资格优先」无隐含高级档；战争无准入；
//   队伍收益全额下一回合打给一致指定的收款人（payee）；购买基础资格结算时点印章、第 6 回合禁买。
// 注意：每回合危机都会结算；无人贡献时 FAIL → 全员扣 failPenalty（下限 0）。
// 场景测试统一把危机卡钉为最温和的「修复修道院」（-5），预期值中显式计入。
import { describe, expect, it } from 'vitest';
import type { Game, SeatId, Submission } from '../src/types.js';
import { lockSubmissions } from '../src/validate.js';
import { settle } from '../src/settle.js';
import { roundStart } from '../src/roundStart.js';
import { drawInt, drawU32 } from '../src/rng.js';
import { readyState, seatByIdentity, setRoundCard, sumFunds } from './helpers.js';

const SEED = 'test-seed';
const P = 5;   // 修复修道院 failPenalty

function scenarioState(seed = SEED): Game {
  const s = readyState(seed);
  setRoundCard(s, 'CRISIS', 'CRI_REPAIR_MONASTERY');   // 无人贡献 → FAIL → 全员 -5
  return s;
}

function run(state: Game, subs: Submission[]) {
  const lock = lockSubmissions(state, subs);
  expect(lock.rejected).toHaveLength(0);
  return { lock, settled: settle(lock.state, lock.accepted, state.seed) };
}

describe('步骤 1 工程（规则书 §12 最低报价制）', () => {
  it('最低报价中标；报酬入在途、下一回合打给收款人；记录与印章', () => {
    const s = scenarioState();
    setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');   // minAbility 60, cap 45
    const peasant = seatByIdentity(s, 'PEASANT');
    const artisan = seatByIdentity(s, 'ARTISAN');
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 'tp', members: [peasant], payee: peasant, ability: 90, bid: 30 }] },
      { seatId: artisan, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 'ta', members: [artisan], payee: artisan, ability: 80, bid: 25 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.engineering.winner?.teamId).toBe('ta');
    expect(settled.results.engineering.payout).toBe(25);
    // 报酬不当回合入账：进入在途队列
    const a = settled.state.seats[artisan];
    expect(a.funds).toBe(10 - P);
    expect(settled.state.pendingPayouts).toEqual([
      { seatId: artisan, amount: 25, source: 'ENGINEERING', awardedRound: 1 },
    ]);
    expect(a.records).toEqual([{ round: 1, domain: 'ENGINEERING' }]);
    expect(a.stamps).toEqual([{ round: 1, source: 'ENGINEERING' }]);
    // 落选者能力锁定、无返还、无记录
    expect(settled.state.seats[peasant].funds).toBe(10 - P);
    expect(settled.state.seats[peasant].records).toHaveLength(0);
    // 下一回合开始：到账给收款人
    const next = roundStart(settled.state);
    expect(next.state.seats[artisan].funds).toBe(10 - P + 25);
    expect(next.state.pendingPayouts).toHaveLength(0);
    expect(next.events.some((e) => e.type === 'PAYOUT' && e.payload['kind'] === 'REWARD')).toBe(true);
  });

  it('同价比总能力', () => {
    const s = scenarioState();
    setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');
    const peasant = seatByIdentity(s, 'PEASANT');
    const artisan = seatByIdentity(s, 'ARTISAN');
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 'tp', members: [peasant], payee: peasant, ability: 90, bid: 23 }] },
      { seatId: artisan, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 'ta', members: [artisan], payee: artisan, ability: 80, bid: 23 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.engineering.winner?.teamId).toBe('tp');
  });

  it('准入严格按列举：无工程资格进不了王家大堡垒', () => {
    const s = scenarioState();
    setRoundCard(s, 'ENGINEERING', 'ENG_ROYAL_FORTRESS');   // entry 工程资格, minAbility 180
    const peasant = seatByIdentity(s, 'PEASANT');
    const king = seatByIdentity(s, 'KING');
    const team: SeatId[] = [king, peasant].sort((a, b) => a - b);
    const subs: Submission[] = [
      // 国王声明核心资格也不行（2026-08-27 裁定：高级不能顶替列举资格）
      { seatId: peasant, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 't', members: team, payee: peasant, ability: 90, bid: 75 }] },
      { seatId: king,    round: 1, entries: [{ domain: 'ENGINEERING', teamId: 't', members: team, payee: peasant, ability: 20, bid: 75, qualificationUsed: 'CORE' }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.engineering.winner).toBeNull();
  });

  it('收款人不一致 → 队伍作废', () => {
    const s = scenarioState();
    setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');
    const peasant = seatByIdentity(s, 'PEASANT');
    const artisan = seatByIdentity(s, 'ARTISAN');
    const team: SeatId[] = [peasant, artisan].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 't', members: team, payee: peasant, ability: 90, bid: 23 }] },
      { seatId: artisan, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 't', members: team, payee: artisan, ability: 80, bid: 23 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.engineering.winner).toBeNull();
    expect(settled.state.pendingPayouts).toHaveLength(0);
  });
});

describe('步骤 2 战争（规则书 §11 / 2026-08-27 裁定：无准入）', () => {
  it('动员值比较、加成上限 60、落选退 80%、报酬入在途', () => {
    const s = scenarioState();
    setRoundCard(s, 'WAR', 'WAR_ROYAL_ESCORT');   // teamSize 1–2, minFunds 10, minAbility 40, reward 50
    const king = seatByIdentity(s, 'KING');
    const knight = seatByIdentity(s, 'KNIGHT');
    const queen = seatByIdentity(s, 'QUEEN');
    const noble = seatByIdentity(s, 'NOBLE');
    const crown: SeatId[] = [king, knight].sort((a, b) => a - b);
    const court: SeatId[] = [queen, noble].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: king,   round: 1, entries: [{ domain: 'WAR', teamId: 'crown', members: crown, payee: king, funds: 10, ability: 20, qualificationUsed: 'CORE' }] },
      { seatId: knight, round: 1, entries: [{ domain: 'WAR', teamId: 'crown', members: crown, payee: king, funds: 0, ability: 70, qualificationUsed: 'BASIC' }] },
      { seatId: queen,  round: 1, entries: [{ domain: 'WAR', teamId: 'court', members: court, payee: queen, funds: 10, ability: 20, qualificationUsed: 'ORG' }] },
      { seatId: noble,  round: 1, entries: [{ domain: 'WAR', teamId: 'court', members: court, payee: queen, funds: 0, ability: 20, qualificationUsed: 'ORG' }] },
    ];
    const { settled } = run(s, subs);
    const r = settled.results.war;
    // crown: 90 能力 + min(60, 60+0) = 150；court: 40 + min(60, 30+30) = 100
    expect(r.winner?.teamId).toBe('crown');
    expect(r.payout).toBe(50);
    // 中标队资金全投（king 10 消耗）；报酬 50 全额入在途，收款人 = king
    expect(settled.state.pendingPayouts).toEqual([
      { seatId: king, amount: 50, source: 'WAR', awardedRound: 1 },
    ]);
    expect(settled.state.seats[king].funds).toBe(20 - 10 - P);
    expect(settled.state.seats[knight].funds).toBe(10 - 0 - P);
    // 落选队退 80%：queen 投 10 → 退 8
    expect(settled.state.seats[queen].funds).toBe(30 - 10 + 8 - P);
    expect(settled.state.seats[noble].funds).toBe(50 - P);
    // 记录：有效参与（≥10 资金或 ≥20 能力）→ king 与 knight 都算
    expect(settled.state.seats[king].records).toEqual([{ round: 1, domain: 'WAR' }]);
    expect(settled.state.seats[knight].records).toEqual([{ round: 1, domain: 'WAR' }]);
    // 下一回合：50 打给 king
    const next = roundStart(settled.state);
    expect(next.state.seats[king].funds).toBe(20 - 10 - P + 50);
  });

  it('无资格也能参战（裁定：战争不设准入）', () => {
    const s = scenarioState();
    setRoundCard(s, 'WAR', 'WAR_ROYAL_ESCORT');
    const peasant = seatByIdentity(s, 'PEASANT');   // 无任何资格
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'WAR', teamId: 'w', members: [peasant], payee: peasant, funds: 10, ability: 90 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.war.winner?.teamId).toBe('w');
    expect(settled.state.pendingPayouts).toEqual([
      { seatId: peasant, amount: 50, source: 'WAR', awardedRound: 1 },
    ]);
    expect(settled.state.seats[peasant].records).toEqual([{ round: 1, domain: 'WAR' }]);
  });

  it('人数越界的队伍按落选处理（退 80%）', () => {
    const s = scenarioState();
    setRoundCard(s, 'WAR', 'WAR_SUPPRESS_REBELLION');   // teamSize 2–4
    const king = seatByIdentity(s, 'KING');
    const subs: Submission[] = [
      { seatId: king, round: 1, entries: [{ domain: 'WAR', teamId: 'solo', members: [king], payee: king, funds: 10, ability: 20, qualificationUsed: 'CORE' }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.war.winner).toBeNull();
    expect(settled.state.seats[king].funds).toBe(20 - 10 + 8 - P);
  });
});

describe('步骤 3 商业（规则书 §13）', () => {
  it('出资最多者中标；风险 0 必成；报酬入在途给收款人；落选全退', () => {
    const s = scenarioState();
    setRoundCard(s, 'COMMERCE', 'COM_CAPITAL_FAIR');   // minFunds 30, minAbility 20, reward 55, risk 0
    const merchant = seatByIdentity(s, 'MERCHANT');
    const burgher = seatByIdentity(s, 'BURGHER');
    const noble = seatByIdentity(s, 'NOBLE');
    const hansa: SeatId[] = [merchant, burgher].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: merchant, round: 1, entries: [{ domain: 'COMMERCE', teamId: 'hansa', members: hansa, payee: merchant, funds: 40, ability: 10 }] },
      { seatId: burgher,  round: 1, entries: [{ domain: 'COMMERCE', teamId: 'hansa', members: hansa, payee: merchant, funds: 0, ability: 30 }] },
      { seatId: noble,    round: 1, entries: [{ domain: 'COMMERCE', teamId: 'lone', members: [noble], payee: noble, funds: 35, ability: 20 }] },
    ];
    const { settled } = run(s, subs);
    const r = settled.results.commerce;
    expect(r.winner?.teamId).toBe('hansa');
    expect(r.result).toBe('SUCCESS');   // risk 0 → R' = 0，骰 1..6 均 > 0
    // 中标资金消耗；收益 55 全额入在途给 merchant（市民拿不拿得到分成是他们内部的事）
    expect(settled.state.pendingPayouts).toEqual([
      { seatId: merchant, amount: 55, source: 'COMMERCE', awardedRound: 1 },
    ]);
    expect(settled.state.seats[merchant].funds).toBe(70 - 40 - P);
    expect(settled.state.seats[burgher].funds).toBe(40 - 0 - P);
    // 落选全退
    expect(settled.state.seats[noble].funds).toBe(50 - P);
    // 有效参与：市民 30 能力 ≥ 20；商人 40 资金 ≥ 10
    expect(settled.state.seats[burgher].records).toEqual([{ round: 1, domain: 'COMMERCE' }]);
    expect(settled.state.seats[merchant].records).toEqual([{ round: 1, domain: 'COMMERCE' }]);
    const next = roundStart(settled.state);
    expect(next.state.seats[merchant].funds).toBe(70 - 40 - P + 55);
  });

  it('高风险失败路径：投入资金全损、无收益、无记录、无印章', () => {
    // 东方香料远航 risk 3；能力压到门槛 → R' = 3；搜一个骰 ≤ 3 的 seed
    let seed = '';
    for (let i = 0; i < 200; i++) {
      const cand = `fail-${i}`;
      if (drawInt(cand, 1, 'COMMERCE', 'COM_DICE', 0, 1, 6) <= 3) { seed = cand; break; }
    }
    expect(seed).not.toBe('');
    const s = scenarioState(seed);
    setRoundCard(s, 'COMMERCE', 'COM_SPICE_VOYAGE');   // minFunds 80, minAbility 50, risk 3
    const merchant = seatByIdentity(s, 'MERCHANT');
    const burgher = seatByIdentity(s, 'BURGHER');
    const peasant = seatByIdentity(s, 'PEASANT');
    const team: SeatId[] = [merchant, burgher, peasant].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: merchant, round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 70, ability: 0 }] },
      { seatId: burgher,  round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 10, ability: 0 }] },
      { seatId: peasant,  round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 0, ability: 50 }] },
    ];
    const { settled } = run(s, subs);
    const r = settled.results.commerce;
    expect(r.effectiveRisk).toBe(3);
    expect(r.result).toBe('FAIL');
    expect(settled.state.pendingPayouts).toHaveLength(0);
    expect(settled.state.seats[merchant].funds).toBe(0);           // 全损后处罚扣 0
    expect(settled.state.seats[burgher].funds).toBe(40 - 10 - P);
    expect(settled.state.seats[merchant].records).toHaveLength(0);
    expect(settled.state.seats[merchant].stamps).toHaveLength(0);
  });

  it('超额能力压风险：R\' = max(0, R − floor((ability−min)/20))', () => {
    const s = scenarioState();
    setRoundCard(s, 'COMMERCE', 'COM_SILVER_MINE');   // minFunds 60, minAbility 40, risk 2
    const merchant = seatByIdentity(s, 'MERCHANT');
    const peasant = seatByIdentity(s, 'PEASANT');
    const team: SeatId[] = [merchant, peasant].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: merchant, round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 60, ability: 0 }] },
      { seatId: peasant,  round: 1, entries: [{ domain: 'COMMERCE', teamId: 't', members: team, payee: merchant, funds: 0, ability: 80 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.commerce.effectiveRisk).toBe(0);   // 2 − floor(40/20) = 0
  });
});

describe('步骤 4 行政（规则书 §14）', () => {
  function adminScenario(auditIdx: 'RECORD_FIRST' | 'QUALIFICATION_FIRST' | 'PRACTICE_FIRST') {
    const s = scenarioState();
    setRoundCard(s, 'ADMIN', 'ADM_CADASTRE');   // slots 2, entry 无, minAbility 30
    s.auditOrders[0] = auditIdx;
    const scholar = seatByIdentity(s, 'SCHOLAR');   // 无资格，能力 40
    const clerk = seatByIdentity(s, 'CLERK');       // BASIC，能力 30
    const knight = seatByIdentity(s, 'KNIGHT');     // BASIC，能力 70（申报 35）
    const subs: Submission[] = [
      { seatId: scholar, round: 1, entries: [{ domain: 'ADMIN', ability: 40 }] },
      { seatId: clerk,   round: 1, entries: [{ domain: 'ADMIN', ability: 30, qualificationUsed: 'BASIC' }] },
      { seatId: knight,  round: 1, entries: [{ domain: 'ADMIN', ability: 35, qualificationUsed: 'BASIC' }] },
    ];
    return { s, scholar, clerk, knight, subs };
  }

  it('实务优先：投入能力排序', () => {
    const { s, scholar, knight, subs } = adminScenario('PRACTICE_FIRST');
    const { settled } = run(s, subs);
    expect(settled.results.admin.selected).toEqual([scholar, knight]);
  });

  it('资格优先：基础资格压过无资格', () => {
    const { s, clerk, knight, subs } = adminScenario('QUALIFICATION_FIRST');
    const { settled } = run(s, subs);
    // knight（基础, 35）与 clerk（基础, 30）同档比能力，scholar 无资格垫底
    expect(settled.results.admin.selected).toEqual([knight, clerk]);
  });

  it('资格优先：门槛「无」的项目不存在高级档（2026-08-27 裁定）', () => {
    const s = scenarioState();
    setRoundCard(s, 'ADMIN', 'ADM_CADASTRE');   // entry 无
    s.auditOrders[0] = 'QUALIFICATION_FIRST';
    const guild = seatByIdentity(s, 'GUILD_MASTER');   // ENGINEERING（高级），但卡面未列举 → 末档
    const scholar = seatByIdentity(s, 'SCHOLAR');      // 无资格 → 末档
    const clerk = seatByIdentity(s, 'CLERK');          // BASIC → 第三档
    const subs: Submission[] = [
      { seatId: guild,   round: 1, entries: [{ domain: 'ADMIN', ability: 30, qualificationUsed: 'ENGINEERING' }] },
      { seatId: scholar, round: 1, entries: [{ domain: 'ADMIN', ability: 40 }] },
      { seatId: clerk,   round: 1, entries: [{ domain: 'ADMIN', ability: 30, qualificationUsed: 'BASIC' }] },
    ];
    const { settled } = run(s, subs);
    // clerk（基础档）第一；guild 与 scholar 同为末档，按能力 scholar 40 > guild 30
    expect(settled.results.admin.selected).toEqual([clerk, scholar]);
  });

  it('履历优先：行政记录多者先', () => {
    const { s, scholar, clerk, subs } = adminScenario('RECORD_FIRST');
    s.seats[clerk].records.push({ round: 1, domain: 'ADMIN' });
    const { settled } = run(s, subs);
    expect(settled.results.admin.selected[0]).toBe(clerk);
    expect(settled.results.admin.selected[1]).toBe(scholar);
  });

  it('录取者入账报酬与情报权（当回合）；准入不满足者不参选', () => {
    const s = scenarioState();
    setRoundCard(s, 'ADMIN', 'ADM_SURVEY_BORDERS');   // slots 1, entry 行政资格, minAbility 50
    const scholar = seatByIdentity(s, 'SCHOLAR');     // 无资格 → 不可参选
    const subs: Submission[] = [
      { seatId: scholar, round: 1, entries: [{ domain: 'ADMIN', ability: 40 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.admin.selected).toHaveLength(0);

    const s2 = scenarioState();
    setRoundCard(s2, 'ADMIN', 'ADM_CADASTRE');   // 35 资金 + 1 情报权
    const scholar2 = seatByIdentity(s2, 'SCHOLAR');
    const before = s2.seats[scholar2];
    const { settled: st2 } = run(s2, [
      { seatId: scholar2, round: 1, entries: [{ domain: 'ADMIN', ability: 40 }] },
    ]);
    const after = st2.state.seats[scholar2];
    expect(after.funds).toBe(before.funds + 35 - P);
    expect(after.intel).toBe(before.intel + 1);
    expect(after.records).toEqual([{ round: 1, domain: 'ADMIN' }]);
    expect(after.stamps).toEqual([{ round: 1, source: 'ADMIN' }]);
  });
});

describe('步骤 5/7 危机（规则书 §15）', () => {
  it('双目标达成 → SUCCESS；达标贡献者得危机印章；资金消耗', () => {
    const s = scenarioState();   // 修复修道院 30 / 80 / -5
    const peasant = seatByIdentity(s, 'PEASANT');
    const noble = seatByIdentity(s, 'NOBLE');
    const knight = seatByIdentity(s, 'KNIGHT');
    const subs: Submission[] = [
      { seatId: noble,   round: 1, entries: [{ domain: 'CRISIS', funds: 30, ability: 0 }] },
      { seatId: peasant, round: 1, entries: [{ domain: 'CRISIS', funds: 0, ability: 60 }] },
      { seatId: knight,  round: 1, entries: [{ domain: 'CRISIS', funds: 5, ability: 20 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.crisis.result).toBe('SUCCESS');
    expect(settled.state.seats[noble].funds).toBe(50 - 30);
    expect(settled.state.seats[noble].stamps).toEqual([{ round: 1, source: 'CRISIS' }]);
    expect(settled.state.seats[peasant].stamps).toEqual([{ round: 1, source: 'CRISIS' }]);
    expect(settled.state.seats[knight].stamps).toEqual([{ round: 1, source: 'CRISIS' }]);   // 5 资金 <10 但 20 能力达标
    // 危机不产生项目成功记录
    expect(settled.state.seats[noble].records).toHaveLength(0);
  });

  it('未达标 → FAIL：已提交照常消耗，全员处罚（下限 0），无印章', () => {
    const s = scenarioState();
    const peasant = seatByIdentity(s, 'PEASANT');   // 资金 10
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'CRISIS', funds: 10, ability: 90 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.crisis.result).toBe('FAIL');   // 资金 10 < 30
    expect(settled.state.seats[peasant].funds).toBe(0);
    expect(settled.state.seats[peasant].stamps).toHaveLength(0);
    const king = seatByIdentity(s, 'KING');
    expect(settled.state.seats[king].funds).toBe(20 - P);
    for (const k of Object.keys(settled.state.seats).map(Number) as SeatId[]) {
      expect(settled.state.seats[k].funds).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('步骤 9 有效参与（TDD-001 §6.3）', () => {
  it('中标队里仅挂资格的成员（<10 资金且 <20 能力）不得记录、不得印章', () => {
    const s = scenarioState();
    setRoundCard(s, 'WAR', 'WAR_ROYAL_ESCORT');   // minFunds 10, minAbility 40, reward 50
    const king = seatByIdentity(s, 'KING');
    const knight = seatByIdentity(s, 'KNIGHT');
    const crown: SeatId[] = [king, knight].sort((a, b) => a - b);
    const subs: Submission[] = [
      // 国王只出 5 资金 0 能力 + 核心资格加成，低于双门槛
      { seatId: king,   round: 1, entries: [{ domain: 'WAR', teamId: 'crown', members: crown, payee: knight, funds: 5, ability: 0, qualificationUsed: 'CORE' }] },
      { seatId: knight, round: 1, entries: [{ domain: 'WAR', teamId: 'crown', members: crown, payee: knight, funds: 5, ability: 70 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.war.winner?.teamId).toBe('crown');
    // 国王：中标但非有效参与 → 无记录、无印章
    const kSeat = settled.state.seats[king];
    expect(kSeat.records).toHaveLength(0);
    expect(kSeat.stamps).toHaveLength(0);
    expect(kSeat.funds).toBe(20 - 5 - P);
    // 骑士：70 能力 → 记录 + 印章；50 报酬入在途（收款人 = 骑士）
    const nSeat = settled.state.seats[knight];
    expect(nSeat.records).toEqual([{ round: 1, domain: 'WAR' }]);
    expect(nSeat.stamps).toEqual([{ round: 1, source: 'WAR' }]);
    expect(nSeat.funds).toBe(10 - 5 - P);
    expect(settled.state.pendingPayouts).toEqual([
      { seatId: knight, amount: 50, source: 'WAR', awardedRound: 1 },
    ]);
    const next = roundStart(settled.state);
    expect(next.state.seats[knight].funds).toBe(10 - 5 - P + 50);
  });

  it('成队但不合法的商业队（能力不足门槛）落选资金全退', () => {
    const s = scenarioState();
    setRoundCard(s, 'COMMERCE', 'COM_SILVER_MINE');   // minFunds 60, minAbility 40
    const merchant = seatByIdentity(s, 'MERCHANT');   // 能力 10 < 40 → 队伍不合法
    const subs: Submission[] = [
      { seatId: merchant, round: 1, entries: [{ domain: 'COMMERCE', teamId: 'lone', members: [merchant], payee: merchant, funds: 60, ability: 10 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.commerce.winner).toBeNull();
    expect(settled.state.seats[merchant].funds).toBe(70 - P);   // 60 全退
    expect(settled.state.seats[merchant].lockedFunds).toBe(0);
  });
});

describe('平局抽签（TDD-001 §6.2 / §6.5）', () => {
  it('工程同价同能力 → seed 派生抽签定中标，且记 RNG_DRAWN', () => {
    const s = scenarioState();
    setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');
    const peasant = seatByIdentity(s, 'PEASANT');
    const artisan = seatByIdentity(s, 'ARTISAN');
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 'tp', members: [peasant], payee: peasant, ability: 60, bid: 23 }] },
      { seatId: artisan, round: 1, entries: [{ domain: 'ENGINEERING', teamId: 'ta', members: [artisan], payee: artisan, ability: 60, bid: 23 }] },
    ];
    const { settled } = run(s, subs);
    // 抽签 key 按 teamId 升序（ta=0, tp=1）派生；key 小者胜
    const keyTa = drawU32(s.seed, 1, 'ENGINEERING', 'ENG', 0);
    const keyTp = drawU32(s.seed, 1, 'ENGINEERING', 'ENG', 1);
    const expected = keyTa < keyTp ? 'ta' : 'tp';
    expect(settled.results.engineering.winner?.teamId).toBe(expected);
    const drawn = settled.events.filter((e) => e.type === 'RNG_DRAWN' && e.payload['purpose'] === 'ENG');
    expect(drawn).toHaveLength(2);
    expect(drawn.map((e) => e.payload['value'])).toEqual([keyTa, keyTp]);
  });

  it('战争同动员值 → 抽签定中标（无次级能力比较）', () => {
    const s = scenarioState();
    setRoundCard(s, 'WAR', 'WAR_ROYAL_ESCORT');
    const knight = seatByIdentity(s, 'KNIGHT');
    const burgher = seatByIdentity(s, 'BURGHER');
    const subs: Submission[] = [
      { seatId: knight,  round: 1, entries: [{ domain: 'WAR', teamId: 'a', members: [knight], payee: knight, funds: 10, ability: 40 }] },
      { seatId: burgher, round: 1, entries: [{ domain: 'WAR', teamId: 'b', members: [burgher], payee: burgher, funds: 10, ability: 40 }] },
    ];
    const { settled } = run(s, subs);
    const keyA = drawU32(s.seed, 1, 'WAR', 'WAR', 0);
    const keyB = drawU32(s.seed, 1, 'WAR', 'WAR', 1);
    const expected = keyA < keyB ? 'a' : 'b';
    expect(settled.results.war.winner?.teamId).toBe(expected);
    expect(settled.events.some((e) => e.type === 'RNG_DRAWN' && e.payload['purpose'] === 'WAR')).toBe(true);
  });
});

describe('步骤 9 印章上限', () => {
  it('同回合多项目成功也只得 1 枚印章（记录不限）', () => {
    const s = scenarioState();
    setRoundCard(s, 'ENGINEERING', 'ENG_REPAIR_MILL');
    const peasant = seatByIdentity(s, 'PEASANT');
    const noble = seatByIdentity(s, 'NOBLE');
    const knight = seatByIdentity(s, 'KNIGHT');
    const subs: Submission[] = [
      {
        seatId: peasant, round: 1,
        entries: [
          { domain: 'ENGINEERING', teamId: 't', members: [peasant], payee: peasant, ability: 60, bid: 23 },
          { domain: 'CRISIS', funds: 10, ability: 30 },
        ],
      },
      { seatId: noble,  round: 1, entries: [{ domain: 'CRISIS', funds: 20, ability: 20 }] },
      { seatId: knight, round: 1, entries: [{ domain: 'CRISIS', funds: 0, ability: 50 }] },
    ];
    // 危机合计：资金 30/30 ✓ 能力 100/80 ✓ → SUCCESS
    const { settled } = run(s, subs);
    expect(settled.results.crisis.result).toBe('SUCCESS');
    const pSeat = settled.state.seats[peasant];
    expect(pSeat.stamps).toHaveLength(1);
    expect(pSeat.stamps[0]!.source).toBe('ENGINEERING');
    expect(pSeat.records).toEqual([{ round: 1, domain: 'ENGINEERING' }]);
  });
});

describe('步骤 10 / roundStart a：资格购买与晋升（2026-08-27 裁定 #10/#11）', () => {
  it('购买基础资格：印章结算时点数（含本回合新得），下一回合生效', () => {
    const s = scenarioState();
    const merchant = seatByIdentity(s, 'MERCHANT');
    s.seats[merchant].stamps.push({ round: 1, source: 'COMMERCE' }, { round: 2, source: 'COMMERCE' });
    const { settled } = run(s, [{ seatId: merchant, round: 1, entries: [], qualificationPurchase: true }]);
    expect(settled.state.seats[merchant].funds).toBe(70 - 20 - P);
    expect(settled.state.seats[merchant].lockedFunds).toBe(0);
    expect(settled.state.seats[merchant].qualifications).toHaveLength(0);   // 尚未生效
    expect(settled.state.pendingQualifications).toEqual([{ seatId: merchant, kind: 'BASIC', viaPurchase: true }]);

    const next = roundStart(settled.state);
    expect(next.state.seats[merchant].qualifications).toEqual([
      { kind: 'BASIC', usedThisRound: false, acquiredRound: 2 },
    ]);
    expect(next.state.pendingQualifications).toHaveLength(0);
  });

  it('本回合刚拿到第 2 枚印章也可购买（规则书 §7.1 最早第 3 回合的路径）', () => {
    const s = scenarioState();
    const merchant = seatByIdentity(s, 'MERCHANT');
    s.seats[merchant].stamps.push({ round: 1, source: 'COMMERCE' });   // 已有 1 枚
    const noble = seatByIdentity(s, 'NOBLE');
    const knight = seatByIdentity(s, 'KNIGHT');
    const peasant = seatByIdentity(s, 'PEASANT');
    const subs: Submission[] = [
      // 商人本回合通过危机贡献 10 资金再得 1 枚（合计 2），同时申请购买
      { seatId: merchant, round: 1, entries: [{ domain: 'CRISIS', funds: 10, ability: 0 }], qualificationPurchase: true },
      { seatId: noble,    round: 1, entries: [{ domain: 'CRISIS', funds: 20, ability: 0 }] },
      { seatId: knight,   round: 1, entries: [{ domain: 'CRISIS', funds: 0, ability: 40 }] },
      { seatId: peasant,  round: 1, entries: [{ domain: 'CRISIS', funds: 0, ability: 40 }] },
    ];
    // 危机 30/30、80/80 → SUCCESS，商人 10 资金达标得印章
    const { settled } = run(s, subs);
    expect(settled.results.crisis.result).toBe('SUCCESS');
    expect(settled.state.seats[merchant].stamps).toHaveLength(2);
    expect(settled.state.pendingQualifications).toEqual([{ seatId: merchant, kind: 'BASIC', viaPurchase: true }]);
    expect(settled.state.seats[merchant].funds).toBe(70 - 10 - 20);   // 危机 10 消耗 + 购买 20 消耗
  });

  it('印章不足 → 结算时退还 20，不排队', () => {
    const s = scenarioState();
    const merchant = seatByIdentity(s, 'MERCHANT');   // 无印章
    const { settled } = run(s, [{ seatId: merchant, round: 1, entries: [], qualificationPurchase: true }]);
    // 步骤 7 处罚时 20 在锁定中：funds 50 → 45；步骤 10 退 20 → 65
    expect(settled.state.seats[merchant].funds).toBe(70 - 20 - P + 20);
    expect(settled.state.pendingQualifications).toHaveLength(0);
    expect(settled.events.some((e) =>
      e.type === 'PAYOUT' && e.payload['kind'] === 'REFUND' && e.payload['source'] === 'QUALIFICATION_PURCHASE')).toBe(true);
  });

  it('第 6 回合禁止购买（资格已无法生效）', () => {
    const s = readyState(SEED);
    s.round = 6;
    const merchant = seatByIdentity(s, 'MERCHANT');
    s.seats[merchant].stamps.push({ round: 1, source: 'COMMERCE' }, { round: 2, source: 'COMMERCE' });
    const lock = lockSubmissions(s, [{ seatId: merchant, round: 6, entries: [], qualificationPurchase: true }]);
    expect(lock.accepted[0]!.qualificationPurchase).toBeUndefined();
    expect(lock.state.seats[merchant].lockedFunds).toBe(0);
  });

  it('晋升：持基础资格期间对应领域记录 ≥ 2 → 升级并替换基础资格', () => {
    const s = scenarioState();
    const clerk = seatByIdentity(s, 'CLERK');   // BASIC, acquiredRound 0
    s.seats[clerk].records.push({ round: 1, domain: 'ENGINEERING' }, { round: 1, domain: 'ENGINEERING' });
    const { settled } = run(s, []);
    expect(settled.state.pendingQualifications).toEqual([{ seatId: clerk, kind: 'ENGINEERING', viaPurchase: false }]);
    const next = roundStart(settled.state);
    expect(next.state.seats[clerk].qualifications).toEqual([
      { kind: 'ENGINEERING', usedThisRound: false, acquiredRound: 2 },
    ]);
  });

  it('取得基础资格之前的记录不计入晋升', () => {
    const s = scenarioState();
    const merchant = seatByIdentity(s, 'MERCHANT');
    s.seats[merchant].qualifications.push({ kind: 'BASIC', usedThisRound: false, acquiredRound: 3 });
    s.seats[merchant].records.push({ round: 1, domain: 'COMMERCE' }, { round: 2, domain: 'COMMERCE' });
    const { settled } = run(s, []);
    expect(settled.state.pendingQualifications).toHaveLength(0);
  });
});

describe('边界情形（TDD-001 §10.2）与回放', () => {
  it('members 集合不一致 → 队伍作废：战争退 80%、商业全退', () => {
    const s = scenarioState();
    setRoundCard(s, 'WAR', 'WAR_ROYAL_ESCORT');
    setRoundCard(s, 'COMMERCE', 'COM_CAPITAL_FAIR');
    const king = seatByIdentity(s, 'KING');
    const knight = seatByIdentity(s, 'KNIGHT');
    const merchant = seatByIdentity(s, 'MERCHANT');
    const burgher = seatByIdentity(s, 'BURGHER');
    const warMembers: SeatId[] = [king, knight].sort((a, b) => a - b);
    const comMembers: SeatId[] = [merchant, burgher].sort((a, b) => a - b);
    const subs: Submission[] = [
      { seatId: king,   round: 1, entries: [{ domain: 'WAR', teamId: 'w', members: warMembers, payee: king, funds: 10, ability: 20, qualificationUsed: 'CORE' }] },
      { seatId: knight, round: 1, entries: [{ domain: 'WAR', teamId: 'w', members: [knight], payee: knight, funds: 5, ability: 70 }] },
      { seatId: merchant, round: 1, entries: [{ domain: 'COMMERCE', teamId: 'c', members: comMembers, payee: merchant, funds: 40, ability: 10 }] },
    ];
    const { settled } = run(s, subs);
    expect(settled.results.war.winner).toBeNull();
    expect(settled.results.commerce.winner).toBeNull();
    expect(settled.state.seats[king].funds).toBe(20 - 10 + 8 - P);
    expect(settled.state.seats[knight].funds).toBe(10 - 5 + 4 - P);
    expect(settled.state.seats[merchant].funds).toBe(70 - P);   // 商业全退
  });

  it('同输入重放：终态与事件逐字节一致；资金守恒可核算', () => {
    const s = readyState(SEED);
    const peasant = seatByIdentity(s, 'PEASANT');
    const noble = seatByIdentity(s, 'NOBLE');
    const subs: Submission[] = [
      { seatId: peasant, round: 1, entries: [{ domain: 'CRISIS', funds: 10, ability: 90 }] },
      { seatId: noble, round: 1, entries: [{ domain: 'CRISIS', funds: 30, ability: 0 }] },
    ];
    const l1 = lockSubmissions(s, subs);
    const r1 = settle(l1.state, l1.accepted, s.seed);
    const l2 = lockSubmissions(s, subs);
    const r2 = settle(l2.state, l2.accepted, s.seed);
    expect(JSON.stringify(r1.state)).toBe(JSON.stringify(r2.state));
    expect(JSON.stringify(r1.events)).toBe(JSON.stringify(r2.events));
    // 账目恒等式：终态总资金 = 初始 300 − 危机消耗 40 + payout − 处罚
    const total = sumFunds(r1.state);
    const payouts = r1.events.filter((e) => e.type === 'PAYOUT').reduce((a, e) => a + (e.payload['amount'] as number), 0);
    const penalties = r1.events.filter((e) => e.type === 'PENALTY').reduce((a, e) => a + (e.payload['amount'] as number), 0);
    expect(total).toBe(300 - 40 + payouts - penalties);
  });
});
