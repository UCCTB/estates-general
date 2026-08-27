// 成就查询（TDD-002 §5 自动档 / §6 提名档）。纯函数，无 I/O，无 Math.random。
//
// 两条纪律（TDD-002 §5.1 / §6.1）：
//   自动档「宁可收紧，不要放宽」——错报一条成就比漏报更伤，它会让玩家觉得系统在瞎编。
//   提名档「宁宽勿漏」——候选多一个由投票否掉，候选漏一个这条成就本局就消失了。
// 每条判定都带 evidence（事件 seq + 一句话说明 + 与规则书原文的关系），终局复盘直接引用。
import type {
  Game, GameEvent, MemoContract, NotarizedContract, Qualification, Round, SeatId, Trigger,
} from './types.js';
import { emitEvent } from './events.js';
import { META, THRESHOLDS, type AchievementKey } from './data/achievement-meta.js';
import { readRoundFacts, type RoundFacts, type TeamDomain } from './roundFacts.js';
import type { StandingRow } from './finalStanding.js';

// ── 输出结构（TDD-002 §5.3 / §6.3）─────────────────────────────────────

/** 判定与规则书原文的关系：等价 / 收紧（会漏不会错报）/ 近似（可能两头都偏） */
export type Approx = 'EXACT' | 'NARROW' | 'FUZZY';

export interface Evidence {
  eventSeqs: number[];
  note: string;
  approx: Approx;
}

export interface AchievementAward {
  key: AchievementKey;
  name: string;
  tier: 'AUTO' | 'NOMINATED' | 'VOTE';
  round: Round | 0;               // 0 = GAME_END
  subjects: SeatId[];
  evidence: Evidence;
}

export interface NominationCandidate {
  candidateId: string;
  subjects: SeatId[];
  round?: Round;
  rationale: string;
  eventSeqs: number[];
}

export interface Nomination {
  key: AchievementKey;
  name: string;
  candidates: NominationCandidate[];
}

// ── 通用工具 ─────────────────────────────────────────────────────────

const ALL_SEATS: readonly SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const HIGH_QUALS: readonly Qualification[] = ['CORE', 'ORG', 'ENGINEERING', 'ADMIN'];
const TEAM_DOMAINS: readonly TeamDomain[] = ['ENGINEERING', 'WAR', 'COMMERCE'];

interface MoneyEdge { round: number; from: SeatId; to: SeatId; amount: number; seq: number; }

/** 资金流图的边（TDD-001 §8.2）：玩家间转账 + 公证契约的实际支付。 */
function moneyEdges(state: Game): MoneyEdge[] {
  const out: MoneyEdge[] = [];
  for (const e of state.events) {
    const p = e.payload;
    if (e.type === 'TRANSFER') {
      out.push({ round: e.round as number, from: p['from'] as SeatId, to: p['to'] as SeatId, amount: p['amount'] as number, seq: e.seq });
    } else if (e.type === 'CONTRACT_FULFILLED') {
      out.push({ round: e.round as number, from: p['payer'] as SeatId, to: p['payee'] as SeatId, amount: p['amount'] as number, seq: e.seq });
    } else if (e.type === 'CONTRACT_DEFAULTED' && (p['paid'] as number) > 0) {
      out.push({ round: e.round as number, from: p['payer'] as SeatId, to: p['payee'] as SeatId, amount: p['paid'] as number, seq: e.seq });
    }
  }
  return out;
}

function notarized(state: Game): NotarizedContract[] {
  return state.contracts.filter((c): c is NotarizedContract => c.tier === 'NOTARIZED');
}

function memos(state: Game): MemoContract[] {
  return state.contracts.filter((c): c is MemoContract => c.tier === 'MEMO');
}

const SETTLE_KINDS = new Set(['PROJECT_RESULT', 'PLAYER_AWARDED', 'CRISIS_RESULT', 'CRISIS_CONTRIBUTION']);
function isSettleTrigger(t: Trigger): boolean { return SETTLE_KINDS.has(t.kind); }

function unlocked(state: Game): Set<AchievementKey> {
  return new Set(state.events
    .filter((e) => e.type === 'ACHIEVEMENT_AUTO')
    .map((e) => (e.payload as { key: AchievementKey }).key));
}

function award(
  key: AchievementKey, round: Round | 0, subjects: SeatId[],
  eventSeqs: number[], note: string, approx: Approx,
): AchievementAward {
  const m = META[key];
  return {
    key, name: m.name, tier: m.tier, round,
    subjects: [...subjects].sort((a, b) => a - b),
    evidence: { eventSeqs: [...new Set(eventSeqs)].sort((a, b) => a - b), note, approx },
  };
}

function holdsHigh(state: Game, seatId: SeatId): boolean {
  return state.seats[seatId].qualifications.some((q) => HIGH_QUALS.includes(q.kind));
}

/** 开局即持有资格（acquiredRound = 0）。用于「开局无资格」类判定。 */
function startedWithQualification(state: Game, seatId: SeatId): boolean {
  return state.seats[seatId].qualifications.some((q) => q.acquiredRound === 0);
}

// ── 自动档：回合内可判定的（SETTLEMENT 步骤 11）────────────────────────

/**
 * 在 settle 步骤 11 调用。判定本回合可判定的自动档成就并发出 ACHIEVEMENT_AUTO。
 * 已解锁的成就不再重复判定（一局只解锁一次，只记第一次的 evidence）。
 */
export function evaluateRoundAchievements(s: Game, out: GameEvent[], round: Round): void {
  const done = unlocked(s);
  const facts = readRoundFacts(s);
  const here = facts.find((f) => f.round === round);
  if (here === undefined) return;
  const edges = moneyEdges(s);

  const push = (a: AchievementAward | null) => {
    if (a === null || done.has(a.key)) return;
    done.add(a.key);
    emitEvent(s, out, 'ACHIEVEMENT_AUTO', 'PUBLIC', { ...a }, round, 'SETTLEMENT');
  };

  push(done.has('FINANCIAL_MARKET') ? null : ruleFinancialMarket(s, round));
  push(done.has('SHADOW_BANK') ? null : ruleShadowBank(s, facts, edges, round));
  push(done.has('GUARANTOR_OF_LAST_RESORT') ? null : ruleGuarantor(s, facts, round));
  push(done.has('EQUAL_WORK_UNEQUAL_PAY') ? null : ruleEqualWorkUnequalPay(here));
  push(done.has('TRAGEDY_OF_COMMONS') ? null : ruleTragedyOfCommons(here));
  push(done.has('LAST_FOOL') ? null : ruleLastFool(here));
  push(done.has('COMMUNITY') ? null : ruleCommunity(here));

  const dis = findDisintermediation(edges, round);
  if (dis !== null) {
    push(done.has('DISINTERMEDIATION') ? null : award('DISINTERMEDIATION', round, [dis.a, dis.b, dis.m],
      dis.seqs, `座位 ${dis.a} 与 ${dis.b} 原先经 ${dis.m} 转手，第 ${dis.r3} 回合起直接往来，不再经过 ${dis.m}`, 'FUZZY'));
    const re = findReintermediation(edges, dis, round);
    if (re !== null) {
      push(done.has('REINTERMEDIATION') ? null : award('REINTERMEDIATION', round, [dis.a, dis.b, re.m2],
        [...dis.seqs, ...re.seqs], `绕开 ${dis.m} 之后，${dis.a} 与 ${dis.b} 之间又出现了新的中间人 ${re.m2}`, 'FUZZY'));
    }
  }
}

// 【金融市场】一回合内至少 3 笔以未来项目收益为偿付来源的借贷 / 投资关系（规则书 §17.3）。
// 收紧：口头达成而未登记的关系引擎看不见。
function ruleFinancialMarket(s: Game, round: Round): AchievementAward | null {
  const hits = notarized(s).filter((c) =>
    c.registeredRound === round && !c.escrowed && isSettleTrigger(c.trigger));
  if (hits.length < THRESHOLDS.FINANCIAL_MARKET_CONTRACTS) return null;
  const seqs = s.events
    .filter((e) => e.type === 'CONTRACT_REGISTERED' && e.round === round && e.visibility === 'PUBLIC')
    .map((e) => e.seq);
  return award('FINANCIAL_MARKET', round, hits.map((c) => c.payer), seqs,
    `第 ${round} 回合登记了 ${hits.length} 份以未来结果为偿付条件、且未托管的正式契约`, 'NARROW');
}

// 【影子银行】不承担主要生产能力，却连续两回合向多个项目提供融资并获利（规则书 §17.3）。
function ruleShadowBank(s: Game, facts: RoundFacts[], edges: MoneyEdge[], round: Round): AchievementAward | null {
  const financedIn = (seat: SeatId, r: number): SeatId[] => {
    const viaTransfer = edges.filter((e) => e.round === r && e.from === seat).map((e) => e.to);
    const viaContract = notarized(s)
      .filter((c) => c.registeredRound === r && c.payee === seat && !c.escrowed && isSettleTrigger(c.trigger))
      .map((c) => c.payer);
    return [...new Set([...viaTransfer, ...viaContract])];
  };
  for (const seat of ALL_SEATS) {
    for (let r = 1; r + 1 <= round; r++) {
      const f1 = facts.find((f) => f.round === r), f2 = facts.find((f) => f.round === r + 1);
      if (f1 === undefined || f2 === undefined) continue;
      const lowAbility = (f: RoundFacts) => (f.abilityCommitted[String(seat)] ?? 0) <= THRESHOLDS.SHADOW_BANK_MAX_ABILITY;
      if (!lowAbility(f1) || !lowAbility(f2)) continue;
      const c1 = financedIn(seat, r), c2 = financedIn(seat, r + 1);
      if (c1.length < THRESHOLDS.SHADOW_BANK_MIN_COUNTERPARTIES) continue;
      if (c2.length < THRESHOLDS.SHADOW_BANK_MIN_COUNTERPARTIES) continue;
      const span = edges.filter((e) => e.round === r || e.round === r + 1);
      const inflow = span.filter((e) => e.to === seat).reduce((a, e) => a + e.amount, 0);
      const outflow = span.filter((e) => e.from === seat).reduce((a, e) => a + e.amount, 0);
      if (inflow <= outflow) continue;
      const seqs = span.filter((e) => e.from === seat || e.to === seat).map((e) => e.seq);
      return award('SHADOW_BANK', round, [seat], seqs,
        `座位 ${seat} 在第 ${r}–${r + 1} 回合几乎不投入能力，却持续向多方融资并净流入 ${inflow - outflow}`, 'FUZZY');
    }
  }
  return null;
}

// 【最后的担保人】在没有系统强制要求的情况下为他人承担实际风险，并成功维持至少两次（规则书 §17.2）。
// 收紧：只认「以他人的结果为触发条件、由自己付款且如约履行」的正式契约。
function ruleGuarantor(s: Game, facts: RoundFacts[], round: Round): AchievementAward | null {
  const forOthers = (c: NotarizedContract): boolean => {
    const t = c.trigger;
    if (t.kind === 'PLAYER_AWARDED') return t.seat !== c.payer;
    if (t.kind === 'CRISIS_CONTRIBUTION') return t.seat !== c.payer;
    if (t.kind === 'PROJECT_RESULT') {
      const f = facts.find((x) => x.round === t.round);
      if (f === undefined) return false;
      if (t.domain === 'ADMIN') return !f.admin.selected.includes(c.payer);
      return !f.winnerMembers[t.domain].includes(c.payer);
    }
    return false;
  };
  for (const seat of ALL_SEATS) {
    const hits = notarized(s).filter((c) => c.payer === seat && c.status === 'FULFILLED' && forOthers(c));
    if (hits.length < THRESHOLDS.GUARANTOR_MIN_FULFILLED) continue;
    const ids = new Set(hits.map((c) => c.contractId));
    const seqs = s.events.filter((e) => e.type === 'CONTRACT_FULFILLED' && ids.has(e.payload['contractId'] as string)).map((e) => e.seq);
    return award('GUARANTOR_OF_LAST_RESORT', round, [seat], seqs,
      `座位 ${seat} 为他人的结果付了 ${hits.length} 次款，每次都足额履行`, 'NARROW');
  }
  return null;
}

// 【同工不同酬】同一回合两人投入相同能力，资金收益相差至少 100%（规则书 §17.4）。
// 收紧：只算项目收益，不含转账与契约带来的「谈判关系收益」。
function ruleEqualWorkUnequalPay(f: RoundFacts): AchievementAward | null {
  for (const a of ALL_SEATS) {
    for (const b of ALL_SEATS) {
      if (a === b) continue;
      const abA = f.abilityCommitted[String(a)] ?? 0;
      const abB = f.abilityCommitted[String(b)] ?? 0;
      if (abA <= 0 || abA !== abB) continue;
      const gA = f.gains[String(a)] ?? 0, gB = f.gains[String(b)] ?? 0;
      if (gA <= 0 || gA < THRESHOLDS.UNEQUAL_PAY_RATIO * gB) continue;
      return award('EQUAL_WORK_UNEQUAL_PAY', f.round, [a, b], [f.seq],
        `第 ${f.round} 回合座位 ${a} 与 ${b} 各投入 ${abA} 能力，项目收益 ${gA} 对 ${gB}`, 'NARROW');
    }
  }
  return null;
}

// 【公地悲剧】危机失败，但公开承诺的资源总量原本足以完成危机（规则书 §17.3）。
function ruleTragedyOfCommons(f: RoundFacts): AchievementAward | null {
  if (f.crisis.result !== 'FAIL') return null;
  if (f.pledges.funds < f.crisis.fundsTarget || f.pledges.ability < f.crisis.abilityTarget) return null;
  return award('TRAGEDY_OF_COMMONS', f.round, [], [f.seq],
    `第 ${f.round} 回合承诺合计 ${f.pledges.funds} 资金 / ${f.pledges.ability} 能力，足以完成危机，实际仍然失败`, 'EXACT');
}

// 【最后一个傻瓜】危机失败，某人个人贡献超过目标总量的 30%，仍然承担全体处罚（规则书 §17.3）。
function ruleLastFool(f: RoundFacts): AchievementAward | null {
  if (f.crisis.result !== 'FAIL') return null;
  for (const seat of ALL_SEATS) {
    const c = f.crisis.contributions[String(seat)];
    if (c === undefined) continue;
    if (c.funds > THRESHOLDS.LAST_FOOL_SHARE * f.crisis.fundsTarget
      || c.ability > THRESHOLDS.LAST_FOOL_SHARE * f.crisis.abilityTarget) {
      return award('LAST_FOOL', f.round, [seat], [f.seq],
        `第 ${f.round} 回合座位 ${seat} 独自投入 ${c.funds} 资金 / ${c.ability} 能力，危机仍然失败，处罚照样落在他头上`, 'EXACT');
    }
  }
  return null;
}

// 【共同体】12 人在秘密提交前形成完整贡献方案，实际与约定总差额不超过 10%（规则书 §17.3）。
function ruleCommunity(f: RoundFacts): AchievementAward | null {
  if (f.pledges.count !== 12) return null;
  let actualFunds = 0, actualAbility = 0;
  for (const v of Object.values(f.crisis.contributions)) { actualFunds += v.funds; actualAbility += v.ability; }
  const within = (actual: number, pledged: number) =>
    pledged === 0 ? true : Math.abs(actual - pledged) <= THRESHOLDS.COMMUNITY_TOLERANCE * pledged;
  if (!within(actualFunds, f.pledges.funds) || !within(actualAbility, f.pledges.ability)) return null;
  return award('COMMUNITY', f.round, [...ALL_SEATS], [f.seq],
    `第 ${f.round} 回合 12 人全部登记承诺，实际提交 ${actualFunds}/${actualAbility}，与承诺 ${f.pledges.funds}/${f.pledges.ability} 相差不到一成`, 'EXACT');
}

// 【去中介化】：a、b 原本经 m 转手（≥ 2 个回合），后来直接往来且不再经过 m（规则书 §17.4）。
interface DisResult { a: SeatId; b: SeatId; m: SeatId; r3: number; seqs: number[]; }

function findDisintermediation(edges: MoneyEdge[], upto: number): DisResult | null {
  const has = (r: number, from: SeatId, to: SeatId) => edges.some((e) => e.round === r && e.from === from && e.to === to);
  for (const a of ALL_SEATS) {
    for (const b of ALL_SEATS) {
      if (a === b) continue;
      for (const m of ALL_SEATS) {
        if (m === a || m === b) continue;
        const relayRounds: number[] = [];
        for (let r = 1; r <= upto; r++) if (has(r, a, m) && has(r, m, b)) relayRounds.push(r);
        if (relayRounds.length < 2) continue;
        const r1 = relayRounds[0]!, r2 = relayRounds[relayRounds.length - 1]!;
        let directBetween = false;
        for (let r = r1; r <= r2; r++) if (has(r, a, b)) directBetween = true;
        if (directBetween) continue;
        for (let r3 = r2 + 1; r3 <= upto; r3++) {
          if (!has(r3, a, b)) continue;
          let stillRelaying = false;
          for (let r = r3; r <= upto; r++) if (has(r, a, m) || has(r, m, b)) stillRelaying = true;
          if (stillRelaying) continue;
          const seqs = edges
            .filter((e) => (e.from === a && e.to === m) || (e.from === m && e.to === b) || (e.from === a && e.to === b))
            .map((e) => e.seq);
          return { a, b, m, r3, seqs };
        }
      }
    }
  }
  return null;
}

// 【中介再生产】绕开旧中介后，为解决新的信任或信息问题又产生新的中介（规则书 §17.4）。
function findReintermediation(edges: MoneyEdge[], dis: DisResult, upto: number): { m2: SeatId; seqs: number[] } | null {
  const has = (r: number, from: SeatId, to: SeatId) => edges.some((e) => e.round === r && e.from === from && e.to === to);
  for (const m2 of ALL_SEATS) {
    if (m2 === dis.a || m2 === dis.b || m2 === dis.m) continue;
    for (let r = dis.r3 + 1; r <= upto; r++) {
      if (has(r, dis.a, m2) && has(r, m2, dis.b)) {
        const seqs = edges
          .filter((e) => e.round === r && ((e.from === dis.a && e.to === m2) || (e.from === m2 && e.to === dis.b)))
          .map((e) => e.seq);
        return { m2, seqs };
      }
    }
  }
  return null;
}

// ── 自动档：终局判定（GAME_END）────────────────────────────────────────

interface RelayRecord { relayFrom: SeatId; other: SeatId; truthful: boolean; targetRound: number; targetDomain: string; seq: number; }

function relayRecords(state: Game): RelayRecord[] {
  const byId = new Map(memos(state).map((c) => [c.contractId, c]));
  const out: RelayRecord[] = [];
  for (const e of state.events) {
    if (e.type !== 'INTEL_CLAIM_VERIFIED') continue;
    const id = e.payload['contractId'] as string;
    const c = byId.get(id);
    if (c === undefined || c.relayFrom === undefined) continue;
    const other = c.parties[0] === c.relayFrom ? c.parties[1] : c.parties[0];
    out.push({
      relayFrom: c.relayFrom, other, truthful: e.payload['truthful'] === true,
      targetRound: (e.payload['target'] as { round: number }).round,
      targetDomain: (e.payload['target'] as { domain: string }).domain,
      seq: e.seq,
    });
  }
  return out;
}

/**
 * 终局自动档判定（TDD-002 §5.2 中时点为 GAME_END 的部分）。
 * 由 ending.ts 的 finalize 调用；与 evaluateRoundAchievements 共用「一局只解锁一次」的去重。
 */
export function evaluateEndgameAchievements(state: Game, rows: StandingRow[]): AchievementAward[] {
  const done = unlocked(state);
  const facts = readRoundFacts(state);
  const relays = relayRecords(state);
  const out: AchievementAward[] = [];
  const push = (a: AchievementAward | null) => { if (a !== null && !done.has(a.key)) { done.add(a.key); out.push(a); } };

  // 【信息垄断】某人成为至少 4 名玩家主要的未来项目信息来源（规则书 §17.4）
  for (const seat of ALL_SEATS) {
    const mine = relays.filter((r) => r.relayFrom === seat);
    const buyers = new Set(mine.map((r) => r.other));
    if (buyers.size >= THRESHOLDS.INFO_MONOPOLY_MIN_BUYERS) {
      push(award('INFORMATION_MONOPOLY', 0, [seat], mine.map((r) => r.seq),
        `座位 ${seat} 向 ${buyers.size} 名不同玩家转述过未来项目情报`, 'NARROW'));
      break;
    }
  }

  // 【谣言制造者】至少三名玩家根据你提供的错误信息采取行动（规则书 §17.2）
  for (const seat of ALL_SEATS) {
    const lies = relays.filter((r) => r.relayFrom === seat && !r.truthful);
    const victims = new Set(lies.map((r) => r.other));
    if (victims.size >= THRESHOLDS.RUMOR_MIN_VICTIMS) {
      push(award('RUMOR_MONGER', 0, [seat], lies.map((r) => r.seq),
        `座位 ${seat} 向 ${victims.size} 名不同玩家转述过与真值不符的情报`, 'FUZZY'));
      break;
    }
  }

  // 【知识就是力量】通过出售、交换或利用情报，直接促成至少两个项目成功（规则书 §17.2）
  for (const seat of ALL_SEATS) {
    const hits = relays.filter((r) => {
      if (r.relayFrom !== seat || !r.truthful) return false;
      const f = facts.find((x) => x.round === r.targetRound);
      if (f === undefined) return false;
      const d = r.targetDomain;
      if (d === 'ADMIN') return f.projectResult.ADMIN === 'SUCCESS' && f.admin.selected.includes(r.other);
      if (d === 'CRISIS') return f.crisis.result === 'SUCCESS';
      const dom = d as TeamDomain;
      return f.projectResult[dom] === 'SUCCESS' && f.winnerMembers[dom].includes(r.other);
    });
    if (hits.length >= THRESHOLDS.KNOWLEDGE_MIN_HITS) {
      push(award('KNOWLEDGE_IS_POWER', 0, [seat], hits.map((r) => r.seq),
        `座位 ${seat} 转述的 ${hits.length} 条属实情报，都对应到买家在该项目上的成功`, 'NARROW'));
      break;
    }
  }

  const endSeq = state.events.filter((e) => e.type === 'GAME_END').map((e) => e.seq);

  // 【钱不是万能的】全场最终资金最高者因没有资格或履历而无法晋级（规则书 §17.4）
  const maxFunds = Math.max(...rows.map((r) => r.funds));
  const richestFailed = rows.filter((r) => r.funds === maxFunds && !r.qualified);
  if (richestFailed.length > 0) {
    push(award('MONEY_IS_NOT_ENOUGH', 0, richestFailed.map((r) => r.seatId), endSeq,
      `全场资金最高（${maxFunds}）的座位 ${richestFailed.map((r) => r.seatId).join('、')} 没能过线`, 'EXACT'));
  }

  // 【身份不是命运】开局无资格者最终排名高于国王 / 王后 / 主教 / 贵族中至少三人（规则书 §17.4）
  const noble = rows.filter((r) => ['KING', 'QUEEN', 'BISHOP', 'NOBLE'].includes(r.identity));
  for (const r of [...rows].sort((a, b) => a.seatId - b.seatId)) {
    if (startedWithQualification(state, r.seatId)) continue;
    const beaten = noble.filter((n) => n.seatId !== r.seatId && r.overallRank < n.overallRank);
    if (beaten.length >= 3) {
      push(award('BIRTH_IS_NOT_DESTINY', 0, [r.seatId], endSeq,
        `开局无资格的座位 ${r.seatId} 终局排在第 ${r.overallRank}，高于国王 / 王后 / 主教 / 贵族中的 ${beaten.length} 人`, 'EXACT'));
      break;
    }
  }

  // 【从农民到贵族】开局无资格者终局持有专业或组织资格并进入前 6 名（规则书 §17.2）
  for (const r of [...rows].sort((a, b) => a.seatId - b.seatId)) {
    if (startedWithQualification(state, r.seatId) || !r.winner) continue;
    if (!holdsHigh(state, r.seatId)) continue;
    push(award('PEASANT_TO_NOBLE', 0, [r.seatId], endSeq,
      `开局无资格的座位 ${r.seatId} 终局持 ${r.highestQualification} 资格并进入前 6 名`, 'EXACT'));
    break;
  }

  return out;
}

// ── 提名档候选（TDD-002 §6）────────────────────────────────────────────

function cand(key: AchievementKey, subjects: SeatId[], rationale: string, eventSeqs: number[], round?: Round): NominationCandidate {
  const subs = [...new Set(subjects)].sort((a, b) => a - b);
  return {
    candidateId: `${key}:${subs.join('-')}${round !== undefined ? `@${round}` : ''}`,
    subjects: subs,
    ...(round !== undefined ? { round } : {}),
    rationale,
    eventSeqs: [...new Set(eventSeqs)].sort((a, b) => a - b),
  };
}

/** 无向图的连通分量（座位集合），按最小座位号排序输出。 */
function components(pairs: [SeatId, SeatId][]): SeatId[][] {
  const adj = new Map<SeatId, Set<SeatId>>();
  for (const [a, b] of pairs) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  const seen = new Set<SeatId>();
  const out: SeatId[][] = [];
  for (const seat of ALL_SEATS) {
    if (!adj.has(seat) || seen.has(seat)) continue;
    const stack = [seat], comp: SeatId[] = [];
    seen.add(seat);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out.sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
}

function jaccard(a: Set<SeatId>, b: Set<SeatId>): number {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * 提名档候选查询（TDD-002 §6.2）。宁宽勿漏：候选多一个由投票否掉，漏一个这条成就就消失了。
 * 输出确定：候选按 seatId / 回合升序，成就按 achievement-meta 的声明顺序。
 */
export function nominationCandidates(state: Game): Nomination[] {
  const facts = readRoundFacts(state);
  const edges = moneyEdges(state);
  const result: Nomination[] = [];
  const add = (key: AchievementKey, candidates: NominationCandidate[]) => {
    if (candidates.length === 0) return;
    const dedup = new Map(candidates.map((c) => [c.candidateId, c]));
    result.push({ key, name: META[key].name, candidates: [...dedup.values()].sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1)) });
  };

  const teamsOf = (f: RoundFacts, seat: SeatId) =>
    TEAM_DOMAINS.flatMap((d) => f.teams[d].filter((t) => t.members.includes(seat)).map((t) => ({ d, t })));
  const wonIn = (f: RoundFacts, seat: SeatId) =>
    TEAM_DOMAINS.some((d) => f.winnerMembers[d].includes(seat) && f.projectResult[d] === 'SUCCESS')
    || f.admin.selected.includes(seat);

  // 【经纪人】同回合既收钱又付钱给不同的人，且净流入为正
  add('BROKER', ALL_SEATS.flatMap((s) => facts.flatMap((f) => {
    const inn = edges.filter((e) => e.round === f.round && e.to === s);
    const outg = edges.filter((e) => e.round === f.round && e.from === s);
    if (inn.length === 0 || outg.length === 0) return [];
    if (!outg.some((o) => inn.some((i) => i.from !== o.to))) return [];
    const net = inn.reduce((a, e) => a + e.amount, 0) - outg.reduce((a, e) => a + e.amount, 0);
    if (net <= 0) return [];
    return [cand('BROKER', [s], `第 ${f.round} 回合座位 ${s} 一手收一手付，净留下 ${net}`,
      [...inn, ...outg].map((e) => e.seq), f.round)];
  })));

  // 【承包人】连续两回合组不同的人中标
  add('CONTRACTOR', ALL_SEATS.flatMap((s) => facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    const mates = (f2: RoundFacts) => new Set(TEAM_DOMAINS.flatMap((d) =>
      f2.winnerMembers[d].includes(s) && f2.projectResult[d] === 'SUCCESS' ? f2.winnerMembers[d].filter((m) => m !== s) : []));
    const m1 = mates(f), m2 = mates(g);
    if (m1.size === 0 || m2.size === 0) return [];
    if (jaccard(m1, m2) === 1) return [];
    return [cand('CONTRACTOR', [s], `座位 ${s} 在第 ${f.round}、${g.round} 回合各带一支不同的队伍中标`, [f.seq, g.seq], g.round)];
  })));

  // 【掮客】只出资格不出钱不出力，却有可观的资金净流入
  add('MIDDLEMAN', ALL_SEATS.flatMap((s) => {
    const freeRides = facts.flatMap((f) => teamsOf(f, s)
      .filter(({ t }) => t.contributions.some((c) => c.seatId === s && c.funds === 0 && c.ability === 0))
      .map(() => f));
    if (freeRides.length === 0) return [];
    const net = edges.filter((e) => e.to === s).reduce((a, e) => a + e.amount, 0)
      - edges.filter((e) => e.from === s).reduce((a, e) => a + e.amount, 0);
    if (net < THRESHOLDS.MIDDLEMAN_MIN_GAIN) return [];
    return [cand('MIDDLEMAN', [s], `座位 ${s} 有 ${freeRides.length} 次只挂名不投入，全局净流入 ${net}`, freeRides.map((f) => f.seq))];
  }));

  // 【资本家】能力占比低、资金占比高，却反复靠出资拿到项目收益
  add('CAPITALIST', ALL_SEATS.flatMap((s) => {
    const hits = facts.flatMap((f) => TEAM_DOMAINS.flatMap((d) => {
      const t = f.teams[d].find((x) => x.teamId === f.winnerTeamId[d]);
      if (t === undefined || !t.members.includes(s)) return [];
      const totA = t.contributions.reduce((a, c) => a + c.ability, 0);
      const totF = t.contributions.reduce((a, c) => a + c.funds, 0);
      const mine = t.contributions.filter((c) => c.seatId === s);
      const myA = mine.reduce((a, c) => a + c.ability, 0), myF = mine.reduce((a, c) => a + c.funds, 0);
      if (totF <= 0) return [];
      if (totA > 0 && myA / totA >= THRESHOLDS.CAPITALIST_MAX_ABILITY_SHARE) return [];
      if (myF / totF < THRESHOLDS.CAPITALIST_MIN_FUNDS_SHARE) return [];
      return [f];
    }));
    if (hits.length < THRESHOLDS.CAPITALIST_MIN_TIMES) return [];
    return [cand('CAPITALIST', [s], `座位 ${s} 有 ${hits.length} 次以主要出资、极少能力的方式进入中标队`, hits.map((f) => f.seq))];
  }));

  // 【不可替代】同一回合被拉进多支不同队伍（含最终作废的）
  add('IRREPLACEABLE', ALL_SEATS.flatMap((s) => facts.flatMap((f) => {
    const n = teamsOf(f, s).length;
    if (n < THRESHOLDS.IRREPLACEABLE_MIN_TEAMS) return [];
    return [cand('IRREPLACEABLE', [s], `第 ${f.round} 回合有 ${n} 支不同队伍把座位 ${s} 写进了名单`, [f.seq], f.round)];
  })));

  // 【行会】连续两回合同一批 ≥ 3 人共同申报工程项目
  add('GUILD', facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    const out: NominationCandidate[] = [];
    for (const t1 of f.teams.ENGINEERING) {
      for (const t2 of g.teams.ENGINEERING) {
        const shared = t1.members.filter((m) => t2.members.includes(m));
        if (shared.length >= THRESHOLDS.GUILD_MIN_SIZE) {
          out.push(cand('GUILD', shared, `第 ${f.round}、${g.round} 回合同一批 ${shared.length} 人共同申报工程项目`, [f.seq, g.seq], g.round));
        }
      }
    }
    return out;
  }));

  // 【卡特尔】某领域连续两回合只有寥寥几支队伍，且成员高度重合
  add('CARTEL', facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    return TEAM_DOMAINS.flatMap((d) => {
      const l1 = f.teams[d].filter((t) => t.legal), l2 = g.teams[d].filter((t) => t.legal);
      if (l1.length === 0 || l2.length === 0) return [];
      if (l1.length > THRESHOLDS.CARTEL_MAX_TEAMS || l2.length > THRESHOLDS.CARTEL_MAX_TEAMS) return [];
      const s1 = new Set(l1.flatMap((t) => t.members)), s2 = new Set(l2.flatMap((t) => t.members));
      const union = new Set([...s1, ...s2]);
      if (union.size < THRESHOLDS.GUILD_MIN_SIZE) return [];
      if (jaccard(s1, s2) < THRESHOLDS.CARTEL_MIN_JACCARD) return [];
      return [cand('CARTEL', [...union], `${d} 领域第 ${f.round}、${g.round} 回合都只有 ${l1.length}/${l2.length} 支合法队伍，且成员基本没变`, [f.seq, g.seq], g.round)];
    });
  }));

  // 【互助会】连续两回合内的无对价转账（同回合无反向转账、双方无契约）
  add('MUTUAL_AID', facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    const window = edges.filter((e) => e.round === f.round || e.round === g.round);
    const contracted = new Set(state.contracts
      .filter((c) => c.registeredRound === f.round || c.registeredRound === g.round)
      .map((c) => [...c.parties].sort((a, b) => a - b).join('-')));
    const gifts = window.filter((e) =>
      !window.some((x) => x.round === e.round && x.from === e.to && x.to === e.from)
      && !contracted.has([e.from, e.to].sort((a, b) => a - b).join('-')));
    if (gifts.length < THRESHOLDS.MUTUAL_AID_MIN_TRANSFERS) return [];
    return components(gifts.map((e) => [e.from, e.to] as [SeatId, SeatId]))
      .filter((c) => c.length >= THRESHOLDS.GUILD_MIN_SIZE)
      .map((c) => cand('MUTUAL_AID', c, `第 ${f.round}–${g.round} 回合这 ${c.length} 人之间有 ${gifts.length} 笔看不到对价的转账`, gifts.map((e) => e.seq), g.round));
  }));

  // 【精英俱乐部】连续两回合，高级资格持有者优先彼此组队
  add('ELITE_CLUB', facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    const pairs: [SeatId, SeatId][] = [];
    for (const f2 of [f, g]) {
      for (const d of TEAM_DOMAINS) {
        for (const t of f2.teams[d]) {
          const high = t.members.filter((m) => holdsHigh(state, m));
          for (let x = 0; x < high.length; x++) for (let y = x + 1; y < high.length; y++) pairs.push([high[x]!, high[y]!]);
        }
      }
    }
    return components(pairs)
      .filter((c) => c.length >= THRESHOLDS.GUILD_MIN_SIZE)
      .map((c) => cand('ELITE_CLUB', c, `第 ${f.round}–${g.round} 回合这 ${c.length} 名高资格持有者只和彼此组队`, [f.seq, g.seq], g.round));
  }));

  // 【旋转门】取得高级资格之后，队友里高资格者的比例上升
  add('REVOLVING_DOOR', ALL_SEATS.flatMap((s) => {
    const ev = state.events.find((e) => e.type === 'QUALIFICATION_APPLIED'
      && (e.payload as { seatId: SeatId }).seatId === s
      && HIGH_QUALS.includes((e.payload as { kind: Qualification }).kind));
    if (ev === undefined) return [];
    const r = ev.round as number;
    const ratio = (fs: RoundFacts[]) => {
      const mates = fs.flatMap((f) => teamsOf(f, s).flatMap(({ t }) => t.members.filter((m) => m !== s)));
      return mates.length === 0 ? null : mates.filter((m) => holdsHigh(state, m)).length / mates.length;
    };
    const before = ratio(facts.filter((f) => f.round < r)), after = ratio(facts.filter((f) => f.round >= r));
    if (before === null || after === null || after <= before) return [];
    return [cand('REVOLVING_DOOR', [s], `座位 ${s} 第 ${r} 回合取得高级资格后，队友中高资格者的比例从 ${(before * 100).toFixed(0)}% 升到 ${(after * 100).toFixed(0)}%`, [ev.seq], r as Round)];
  }));

  // 【人民阵线】≥ 4 名无高级资格者在 ≥ 2 个回合共同中标
  add('POPULAR_FRONT', facts.flatMap((f, i) => facts.slice(i + 1).flatMap((g) => {
    const low = (f2: RoundFacts) => new Set(ALL_SEATS.filter((s) => wonIn(f2, s) && !holdsHigh(state, s)));
    const both = [...low(f)].filter((s) => low(g).has(s));
    if (both.length < THRESHOLDS.POPULAR_FRONT_MIN_SIZE) return [];
    return [cand('POPULAR_FRONT', both, `这 ${both.length} 名无高级资格者在第 ${f.round}、${g.round} 回合都一起拿下了项目`, [f.seq, g.seq], g.round)];
  })));

  // 【大联盟】/【联盟崩溃】：契约 + 转账 + 同队边构成的连通集团
  const relationPairs = (f: RoundFacts): [SeatId, SeatId][] => {
    const p: [SeatId, SeatId][] = [];
    for (const d of TEAM_DOMAINS) {
      for (const t of f.teams[d]) {
        for (let x = 0; x < t.members.length; x++) for (let y = x + 1; y < t.members.length; y++) p.push([t.members[x]!, t.members[y]!]);
      }
    }
    for (const e of edges.filter((e2) => e2.round === f.round)) p.push([e.from, e.to]);
    for (const c of state.contracts.filter((c2) => c2.registeredRound === f.round)) p.push([c.parties[0], c.parties[1]]);
    return p;
  };
  const coalitions: { comp: SeatId[]; f: RoundFacts; g: RoundFacts }[] = [];
  facts.forEach((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return;
    for (const comp of components([...relationPairs(f), ...relationPairs(g)])) coalitions.push({ comp, f, g });
  });

  add('GRAND_COALITION', coalitions
    .filter((c) => c.comp.length >= THRESHOLDS.GRAND_COALITION_MIN_SIZE)
    .map((c) => cand('GRAND_COALITION', c.comp, `第 ${c.f.round}–${c.g.round} 回合这 ${c.comp.length} 人由契约、转账与同队关系连成一片`, [c.f.seq, c.g.seq], c.g.round)));

  add('COALITION_COLLAPSE', coalitions
    .filter((c) => c.comp.length >= THRESHOLDS.COALITION_COLLAPSE_MIN_SIZE)
    .flatMap((c) => {
      const after = facts.find((f) => f.round === c.g.round + 1);
      const inside = (pairs: [SeatId, SeatId][]) => pairs.filter(([x, y]) => c.comp.includes(x) && c.comp.includes(y)).length;
      const betrayal = state.events.some((e) =>
        (e.type === 'CONTRACT_DEFAULTED' || e.type === 'MEMO_ACCUSED')
        && (e.round as number) >= c.g.round
        && c.comp.includes((e.payload['payer'] ?? e.payload['by']) as SeatId));
      const beforeCount = inside(relationPairs(c.g));
      const afterCount = after === undefined ? 0 : inside(relationPairs(after));
      const dropped = beforeCount > 0 && afterCount <= beforeCount * (1 - THRESHOLDS.COALITION_COLLAPSE_DROP);
      if (!dropped && !betrayal) return [];
      return [cand('COALITION_COLLAPSE', c.comp,
        `第 ${c.f.round}–${c.g.round} 回合的 ${c.comp.length} 人集团` + (dropped ? `，内部往来从 ${beforeCount} 笔掉到 ${afterCount} 笔` : '，内部出现失信或指控'),
        [c.f.seq, c.g.seq], c.g.round)];
    }));

  // 【关系比规则重要】没有对应资格，却连续两回合进了有准入门槛的项目并拿到收益
  add('TIES_OVER_RULES', ALL_SEATS.flatMap((s) => facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    const gated = (f2: RoundFacts) => TEAM_DOMAINS.some((d) =>
      f2.entryLabel[d] !== '无' && f2.winnerMembers[d].includes(s) && f2.projectResult[d] === 'SUCCESS');
    if (!gated(f) || !gated(g)) return [];
    const declared = facts.some((f2) => teamsOf(f2, s).some(({ t }) =>
      t.contributions.some((c) => c.seatId === s && c.qualificationUsed !== undefined)));
    if (declared) return [];
    return [cand('TIES_OVER_RULES', [s], `座位 ${s} 从没用过任何资格，却在第 ${f.round}、${g.round} 回合都进了有门槛的中标队`, [f.seq, g.seq], g.round)];
  })));

  // 【规则比关系重要】连续两回合报了名却因不合法被挡在门外
  add('RULES_OVER_TIES', ALL_SEATS.flatMap((s) => facts.flatMap((f, i) => {
    const g = facts[i + 1];
    if (g === undefined) return [];
    const blocked = (f2: RoundFacts) =>
      TEAM_DOMAINS.some((d) => f2.teams[d].some((t) => t.members.includes(s) && !t.legal))
      || f2.admin.applicants.some((a) => a.seatId === s && !a.eligible);
    if (!blocked(f) || !blocked(g)) return [];
    return [cand('RULES_OVER_TIES', [s], `座位 ${s} 第 ${f.round}、${g.round} 回合都报了名，两次都没能通过合法性过滤`, [f.seq, g.seq], g.round)];
  })));

  // 【入口垄断】某人声明使用的资格成为多支队伍争夺的关键入口
  add('GATEWAY_MONOPOLY', ALL_SEATS.flatMap((s) => facts.flatMap((f) => {
    const carrying = TEAM_DOMAINS.filter((d) => f.entryLabel[d] !== '无'
      && f.teams[d].filter((t) => t.members.includes(s)
        && t.contributions.some((c) => c.seatId === s && c.qualificationUsed !== undefined)).length >= 2);
    if (carrying.length === 0) return [];
    return [cand('GATEWAY_MONOPOLY', [s], `第 ${f.round} 回合有两支以上的队伍靠座位 ${s} 的资格才够得着 ${carrying.join('/')} 项目`, [f.seq], f.round)];
  })));

  // 按 achievement-meta 的声明顺序输出，保证确定性
  const order = Object.keys(META);
  return result.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
