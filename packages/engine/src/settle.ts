// TDD-001 §6.2 SETTLEMENT 流水线。纯函数：settle(state, submissions, seed) → { state, events }。
// 结果段（步骤 1–5）只产生 Result 对象，不动钱；资金段（6–8）只依据 Result 动钱；随后记录段（9–11）。
// 步骤 8（公证契约）为阶段 2 内容，本阶段留空桩。
import type {
  AuditOrder, Domain, Game, GameEvent, ProjectCard, Qualification, Round, SeatId, Submission,
} from './types.js';
import { emitEvent } from './events.js';
import { drawInt, drawU32 } from './rng.js';
import { entrySatisfiedByOne, entrySatisfiedByTeam } from './qualification.js';
import { flushPendingPayouts } from './payouts.js';
import { step8Execute, type SettleFacts } from './contracts.js';
import { entryToString } from './intel.js';
import { emitRoundFacts, type FactsTeam, type ProjectDomain, type TeamDomain } from './roundFacts.js';
import { evaluateRoundAchievements } from './achievements.js';
import { pledgeTotals } from './pledge.js';
import { WAR_BONUS_CAP, WAR_QUALIFICATION_BONUS } from './data/war-bonus.js';

// ── 内部结构 ─────────────────────────────────────────────────────────

interface Ctx {
  s: Game;
  out: GameEvent[];
  seed: string;
  round: Round;
  subs: Map<SeatId, Submission>;
}

export interface TeamContribution {
  seatId: SeatId;
  funds: number;
  ability: number;
  qualificationUsed?: Qualification;
}

export interface Team {
  teamId: string;
  members: SeatId[];              // 升序
  contributions: TeamContribution[];
  formed: boolean;                // 成队：members 集合一致且全员各恰有一条同 teamId entry
  legal: boolean;                 // 通过本领域全部过滤条件（步骤 1–3 回填，供 TDD-002 查询）
  bid: number | null;             // ENGINEERING：全员一致才有值（issues #5）
  payee: SeatId | null;           // 全员一致指定的收款人（2026-08-27 裁定，不一致 → 作废）
  totalFunds: number;
  totalAbility: number;
  usedQuals: Qualification[];
}

export interface EngineeringResult { card: ProjectCard; teams: Team[]; winner: Team | null; payout: number; }
export interface WarResult { card: ProjectCard; teams: Team[]; winner: Team | null; payout: number; }
export interface CommerceResult {
  card: ProjectCard; teams: Team[]; winner: Team | null;
  result: 'SUCCESS' | 'FAIL' | 'NO_AWARD'; payout: number;
  effectiveRisk: number | null; dice: number | null;
}
export interface AdminApplicant { seatId: SeatId; ability: number; qualificationUsed?: Qualification; eligible: boolean; }
export interface AdminResult {
  card: ProjectCard; auditOrder: AuditOrder;
  applicants: AdminApplicant[]; selected: SeatId[];
  payoutEach: number; intelEach: number;
}
export interface CrisisResult {
  card: ProjectCard; result: 'SUCCESS' | 'FAIL';
  contributions: Partial<Record<SeatId, { funds: number; ability: number }>>;
  totalFunds: number; totalAbility: number;
}
export interface SettleResults {
  engineering: EngineeringResult;
  war: WarResult;
  commerce: CommerceResult;
  admin: AdminResult;
  crisis: CrisisResult;
}

const QUALIFICATION_PURCHASE_COST = 20;   // 规则书 §7.1

// ── 队伍组建 ─────────────────────────────────────────────────────────
// 成队条件（TDD-001 §4.3）：所有 members 都提交了同一 teamId 且 members 集合一致。
// 2026-08-27 裁定：收款人（payee）也须全员一致，「达不成统一意见就没法竞标」。
// 任一成员未提交、集合不一致或 payee 不一致 → 队伍作废，各成员按落选处理（§10.2）。
// 工程另要求全员 bid 一致（issues #5，与 payee 一致性同理）。

type TeamEntry = { seatId: SeatId; members: SeatId[]; payee: SeatId; funds: number; ability: number; bid?: number; qualificationUsed?: Qualification };

function collectTeams(ctx: Ctx, domain: 'ENGINEERING' | 'WAR' | 'COMMERCE'): Team[] {
  const groups = new Map<string, TeamEntry[]>();
  for (const sub of ctx.subs.values()) {
    for (const e of sub.entries) {
      if (e.domain !== domain) continue;
      const te: TeamEntry = {
        seatId: sub.seatId,
        members: [...new Set(e.members)].sort((a, b) => a - b),
        payee: e.payee,
        funds: 'funds' in e ? e.funds : 0,
        ability: e.ability,
      };
      if ('bid' in e) te.bid = e.bid;
      if ('qualificationUsed' in e && e.qualificationUsed !== undefined) te.qualificationUsed = e.qualificationUsed;
      const list = groups.get(e.teamId) ?? [];
      list.push(te);
      groups.set(e.teamId, list);
    }
  }

  const teams: Team[] = [];
  for (const [teamId, list] of groups) {
    const submitters = list.map((x) => x.seatId);
    const memberSet = list[0]!.members;
    const sameSets = list.every((x) => x.members.length === memberSet.length && x.members.every((m, i) => m === memberSet[i]));
    const noDup = new Set(submitters).size === submitters.length;
    const allSubmitted = sameSets && memberSet.every((m) => submitters.includes(m)) && submitters.every((m) => memberSet.includes(m));
    // 收款人一致性（2026-08-27 裁定）：不一致 → 作废
    const samePayee = list.every((x) => x.payee === list[0]!.payee);
    let formed = sameSets && noDup && allSubmitted && samePayee;

    let bid: number | null = null;
    if (domain === 'ENGINEERING') {
      const bids = list.map((x) => x.bid ?? -1);
      if (bids.every((b) => b === bids[0] && b >= 0)) bid = bids[0]!;
      else formed = false;
    }

    const contributions: TeamContribution[] = list.map((x) => {
      const c: TeamContribution = { seatId: x.seatId, funds: x.funds, ability: x.ability };
      if (x.qualificationUsed !== undefined) c.qualificationUsed = x.qualificationUsed;
      return c;
    });

    teams.push({
      teamId,
      members: memberSet,
      contributions,
      formed,
      legal: false,
      bid,
      payee: samePayee ? list[0]!.payee : null,
      totalFunds: contributions.reduce((a, c) => a + c.funds, 0),
      totalAbility: contributions.reduce((a, c) => a + c.ability, 0),
      usedQuals: contributions.flatMap((c) => (c.qualificationUsed !== undefined ? [c.qualificationUsed] : [])),
    });
  }
  // teamId 升序，保证抽签 index 分配与遍历顺序确定
  teams.sort((a, b) => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
  return teams;
}

// 平局抽签：为每个候选按 canonical 顺序抽一个 u32 作为终极 tiebreak key，逐次记 RNG_DRAWN。
// 仅当候选 ≥ 2 时抽取（≤ 1 无平局可言）。
function drawTiebreakKeys(ctx: Ctx, domain: Domain, purpose: string, count: number): number[] {
  const keys: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = count >= 2 ? drawU32(ctx.seed, ctx.round, domain, purpose, i) : 0;
    keys.push(v);
    if (count >= 2) {
      emitEvent(ctx.s, ctx.out, 'RNG_DRAWN', 'PUBLIC',
        { round: ctx.round, domain, purpose, index: i, value: v }, ctx.round, 'SETTLEMENT');
    }
  }
  return keys;
}

// ── 结果段 ───────────────────────────────────────────────────────────

// 步骤 1：工程与生产（规则书 §12 最低报价制）
export function step1Engineering(ctx: Ctx): EngineeringResult {
  const card = ctx.s.decks.ENGINEERING[ctx.round - 1]!;
  const teams = collectTeams(ctx, 'ENGINEERING');
  const minBid = Math.ceil(card.budgetCap! * 0.5);
  const legal = teams.filter((t) =>
    t.formed
    && entrySatisfiedByTeam(card.entry, t.usedQuals)
    && t.totalAbility >= card.minAbility!
    && t.bid !== null && t.bid >= minBid && t.bid <= card.budgetCap!,
  );
  for (const t of legal) t.legal = true;
  const keys = drawTiebreakKeys(ctx, 'ENGINEERING', 'ENG', legal.length);
  const ranked = legal
    .map((t, i) => ({ t, key: keys[i]! }))
    .sort((a, b) => (a.t.bid! - b.t.bid!) || (b.t.totalAbility - a.t.totalAbility) || (a.key - b.key));
  const winner = ranked[0]?.t ?? null;
  const payout = winner ? winner.bid! : 0;
  emitEvent(ctx.s, ctx.out, 'PROJECT_RESOLVED', 'PUBLIC', {
    domain: 'ENGINEERING', card: card.name,
    result: winner ? 'SUCCESS' : 'NO_AWARD',
    winnerTeamId: winner?.teamId ?? null,
    winnerMembers: winner?.members ?? [],
    payee: winner?.payee ?? null,
    payout,
    bids: legal.map((t) => ({ teamId: t.teamId, bid: t.bid, totalAbility: t.totalAbility })),
  }, ctx.round, 'SETTLEMENT');
  return { card, teams, winner, payout };
}

// 步骤 2：王权与战争（规则书 §11 动员值竞争；中标后必定成功，不掷骰）
export function step2War(ctx: Ctx): WarResult {
  const card = ctx.s.decks.WAR[ctx.round - 1]!;
  const teams = collectTeams(ctx, 'WAR');
  const [minSize, maxSize] = card.teamSize!;
  const legal = teams.filter((t) =>
    t.formed
    && t.members.length >= minSize && t.members.length <= maxSize   // 规则书 §11.3 人数列（issues #7）
    && entrySatisfiedByTeam(card.entry, t.usedQuals)
    && t.totalFunds >= card.minFunds!
    && t.totalAbility >= card.minAbility!,
  );
  for (const t of legal) t.legal = true;
  const bonus = (t: Team) => Math.min(
    WAR_BONUS_CAP,
    t.usedQuals.reduce((a, q) => a + (WAR_QUALIFICATION_BONUS[q] ?? 0), 0),
  );
  const mobilization = (t: Team) => t.totalAbility + bonus(t);
  const keys = drawTiebreakKeys(ctx, 'WAR', 'WAR', legal.length);
  const ranked = legal
    .map((t, i) => ({ t, key: keys[i]! }))
    .sort((a, b) => (mobilization(b.t) - mobilization(a.t)) || (a.key - b.key));
  const winner = ranked[0]?.t ?? null;
  emitEvent(ctx.s, ctx.out, 'PROJECT_RESOLVED', 'PUBLIC', {
    domain: 'WAR', card: card.name,
    result: winner ? 'SUCCESS' : 'NO_AWARD',
    winnerTeamId: winner?.teamId ?? null,
    winnerMembers: winner?.members ?? [],
    payee: winner?.payee ?? null,
    payout: winner ? card.reward! : 0,
    mobilizations: legal.map((t) => ({ teamId: t.teamId, mobilization: mobilization(t) })),
  }, ctx.round, 'SETTLEMENT');
  return { card, teams, winner, payout: winner ? card.reward! : 0 };
}

// 步骤 3：商业与运输（规则书 §13 出资竞争 + §13.1 风险判定）
export function step3Commerce(ctx: Ctx): CommerceResult {
  const card = ctx.s.decks.COMMERCE[ctx.round - 1]!;
  const teams = collectTeams(ctx, 'COMMERCE');
  const legal = teams.filter((t) =>
    t.formed && t.totalFunds >= card.minFunds! && t.totalAbility >= card.minAbility!,
  );
  for (const t of legal) t.legal = true;
  const keys = drawTiebreakKeys(ctx, 'COMMERCE', 'COM', legal.length);
  const ranked = legal
    .map((t, i) => ({ t, key: keys[i]! }))
    .sort((a, b) => (b.t.totalFunds - a.t.totalFunds) || (b.t.totalAbility - a.t.totalAbility) || (a.key - b.key));
  const winner = ranked[0]?.t ?? null;

  let result: CommerceResult['result'] = 'NO_AWARD';
  let effectiveRisk: number | null = null;
  let dice: number | null = null;
  if (winner) {
    effectiveRisk = Math.max(0, card.risk! - Math.floor((winner.totalAbility - card.minAbility!) / 20));
    dice = drawInt(ctx.seed, ctx.round, 'COMMERCE', 'COM_DICE', 0, 1, 6);
    emitEvent(ctx.s, ctx.out, 'RNG_DRAWN', 'PUBLIC',
      { round: ctx.round, domain: 'COMMERCE', purpose: 'COM_DICE', index: 0, value: dice }, ctx.round, 'SETTLEMENT');
    result = dice <= effectiveRisk ? 'FAIL' : 'SUCCESS';
  }
  const payout = result === 'SUCCESS' ? card.reward! : 0;
  emitEvent(ctx.s, ctx.out, 'PROJECT_RESOLVED', 'PUBLIC', {
    domain: 'COMMERCE', card: card.name, result,
    winnerTeamId: winner?.teamId ?? null,
    winnerMembers: winner?.members ?? [],
    payee: winner?.payee ?? null,
    payout, effectiveRisk, dice,
  }, ctx.round, 'SETTLEMENT');
  return { card, teams, winner, result, payout, effectiveRisk, dice };
}

// 步骤 4：知识与行政（规则书 §14 个人职位选拔；审查令三种排序）
export function step4Admin(ctx: Ctx): AdminResult {
  const card = ctx.s.decks.ADMIN[ctx.round - 1]!;
  const auditOrder = ctx.s.auditOrders[ctx.round - 1]!;

  const applicants: AdminApplicant[] = [];
  for (const sub of ctx.subs.values()) {
    for (const e of sub.entries) {
      if (e.domain !== 'ADMIN') continue;
      const a: AdminApplicant = { seatId: sub.seatId, ability: e.ability, eligible: false };
      if (e.qualificationUsed !== undefined) a.qualificationUsed = e.qualificationUsed;
      applicants.push(a);
    }
  }
  applicants.sort((a, b) => a.seatId - b.seatId);

  const eligible = applicants.filter((a) =>
    entrySatisfiedByOne(card.entry, a.qualificationUsed) && a.ability >= card.minAbility!,
  );
  for (const a of eligible) a.eligible = true;

  const seatOf = (id: SeatId) => ctx.s.seats[id];
  const adminRecords = (id: SeatId) => seatOf(id).records.filter((r) => r.domain === 'ADMIN').length;
  const totalRecords = (id: SeatId) => seatOf(id).records.length;
  // 资格档位（规则书 §14.1「资格优先」）：行政 → 项目卡明确列举的其他高级资格 → 基础 → 无。
  // 2026-08-27 裁定（issues #4）：门槛没有资格限制的项目不存在「高级档」——
  // 核心/组织/工程资格只有在 entry 明确列举时才享受第二档，否则一律末档。
  const qualTier = (a: AdminApplicant): number => {
    const q = a.qualificationUsed;
    if (q === 'ADMIN') return 0;
    if ((q === 'CORE' || q === 'ORG' || q === 'ENGINEERING')
      && card.entry.kind === 'ANY_OF' && card.entry.accepted.includes(q)) return 1;
    if (q === 'BASIC') return 2;
    return 3;
  };

  const keys = drawTiebreakKeys(ctx, 'ADMIN', 'ADM', eligible.length);
  const cmp = (x: { a: AdminApplicant; key: number }, y: { a: AdminApplicant; key: number }): number => {
    switch (auditOrder) {
      case 'RECORD_FIRST':          // 履历优先：行政成功记录 → 全部成功记录 → 投入能力 → 抽签
        return (adminRecords(y.a.seatId) - adminRecords(x.a.seatId))
          || (totalRecords(y.a.seatId) - totalRecords(x.a.seatId))
          || (y.a.ability - x.a.ability)
          || (x.key - y.key);
      case 'QUALIFICATION_FIRST':   // 资格优先：资格档位 → 投入能力 → 抽签
        return (qualTier(x.a) - qualTier(y.a))
          || (y.a.ability - x.a.ability)
          || (x.key - y.key);
      case 'PRACTICE_FIRST':        // 实务优先：投入能力 → 行政成功记录 → 资格 → 抽签
        return (y.a.ability - x.a.ability)
          || (adminRecords(y.a.seatId) - adminRecords(x.a.seatId))
          || (qualTier(x.a) - qualTier(y.a))
          || (x.key - y.key);
    }
  };
  const ranked = eligible.map((a, i) => ({ a, key: keys[i]! })).sort(cmp);
  const selected = ranked.slice(0, card.slots!).map((x) => x.a.seatId);

  emitEvent(ctx.s, ctx.out, 'PROJECT_RESOLVED', 'PUBLIC', {
    domain: 'ADMIN', card: card.name, auditOrder,
    result: selected.length > 0 ? 'SUCCESS' : 'NO_AWARD',
    selected, payoutEach: card.reward!, intelEach: card.rewardIntel!,
  }, ctx.round, 'SETTLEMENT');

  return { card, auditOrder, applicants, selected, payoutEach: card.reward!, intelEach: card.rewardIntel! };
}

// 步骤 5：教会与公共危机（规则书 §15 双目标汇总）
export function step5Crisis(ctx: Ctx): CrisisResult {
  const card = ctx.s.decks.CRISIS[ctx.round - 1]!;
  const contributions: Partial<Record<SeatId, { funds: number; ability: number }>> = {};
  let totalFunds = 0, totalAbility = 0;
  for (const sub of ctx.subs.values()) {
    for (const e of sub.entries) {
      if (e.domain !== 'CRISIS') continue;
      contributions[sub.seatId] = { funds: e.funds, ability: e.ability };
      totalFunds += e.funds;
      totalAbility += e.ability;
    }
  }
  const result = totalFunds >= card.fundsTarget! && totalAbility >= card.abilityTarget! ? 'SUCCESS' : 'FAIL';
  // 结算后公开每名玩家的实际贡献（规则书 §15 / TDD-001 §6.2 步骤 9）
  emitEvent(ctx.s, ctx.out, 'CRISIS_RESOLVED', 'PUBLIC', {
    card: card.name, result, totalFunds, totalAbility,
    fundsTarget: card.fundsTarget!, abilityTarget: card.abilityTarget!,
    contributions: Object.fromEntries(Object.entries(contributions).map(([k, v]) => [k, { ...v }])),
  }, ctx.round, 'SETTLEMENT');
  return { card, result, contributions, totalFunds, totalAbility };
}

// ── 资金段 ───────────────────────────────────────────────────────────

// 步骤 6：入账。2026-08-27 裁定（issues #12，取代 TDD §6.2「按 ability 比例分配」与附录 C.1）：
// 中标收益不拆分，全额记入在途队列，下一回合开始时打给队伍指定的收款人（payee）；
// 队内分配走自由转账，不分是内部信用问题，引擎不介入。
// 注意副作用：本回合的危机处罚（步骤 7）打不到尚未到账的中标收益。
// 落选返还仍当回合执行：工程无资金；商业全退；战争退 80%（逐成员 floor，issues #9）。
// 危机资金无论成败全部消耗。本回合提交锁定清零（资格购买的 20 留至步骤 10 处理）。
export function step6Income(ctx: Ctx, r: SettleResults): void {
  const payRefund = (seatId: SeatId, amount: number, source: Domain) => {
    if (amount <= 0) return;
    ctx.s.seats[seatId].funds += amount;
    emitEvent(ctx.s, ctx.out, 'PAYOUT', 'PUBLIC',
      { kind: 'REFUND', seatId, amount, source }, ctx.round, 'SETTLEMENT');
  };
  const queuePayout = (team: Team, amount: number, source: Domain) => {
    if (amount <= 0) return;
    ctx.s.pendingPayouts.push({ seatId: team.payee!, amount, source, awardedRound: ctx.round });
  };

  // 工程中标：payout = 中标报价，记入在途
  if (r.engineering.winner) queuePayout(r.engineering.winner, r.engineering.payout, 'ENGINEERING');

  // 战争：中标全额投入，reward 记入在途；落选退 80%（含不成队 / 不合法队伍，§10.2）
  for (const t of r.war.teams) {
    if (t === r.war.winner) continue;
    for (const c of t.contributions) payRefund(c.seatId, Math.floor(c.funds * 0.8), 'WAR');
  }
  if (r.war.winner) queuePayout(r.war.winner, r.war.payout, 'WAR');

  // 商业：落选资金全退；中标资金消耗，SUCCESS 时 reward 记入在途
  for (const t of r.commerce.teams) {
    if (t === r.commerce.winner) continue;
    for (const c of t.contributions) payRefund(c.seatId, c.funds, 'COMMERCE');
  }
  if (r.commerce.winner && r.commerce.result === 'SUCCESS') {
    queuePayout(r.commerce.winner, r.commerce.payout, 'COMMERCE');
  }

  // 行政：个人项目无收款人协商问题，payoutEach 当回合入账（情报权入账在步骤 9）
  for (const seatId of r.admin.selected) {
    ctx.s.seats[seatId].funds += r.admin.payoutEach;
    emitEvent(ctx.s, ctx.out, 'PAYOUT', 'PUBLIC',
      { kind: 'REWARD', seatId, amount: r.admin.payoutEach, source: 'ADMIN' }, ctx.round, 'SETTLEMENT');
  }

  // 危机：无论成败资金全部消耗，不返还（规则书 §15）

  // 本回合提交锁定清零（资格购买的 20 除外，留至步骤 10 处理）
  for (const sub of ctx.subs.values()) {
    const seat = ctx.s.seats[sub.seatId];
    const entryLock = sub.entries.reduce((a, e) => a + ('funds' in e ? e.funds : 0), 0);
    seat.lockedFunds -= entryLock;
  }
}

// 步骤 7：扣款。危机 FAIL：每人 funds = max(0, funds − failPenalty)。
export function step7Deductions(ctx: Ctx, r: SettleResults): void {
  if (r.crisis.result !== 'FAIL') return;
  const penalty = r.crisis.card.failPenalty!;
  for (const seatId of Object.keys(ctx.s.seats).map(Number) as SeatId[]) {
    const seat = ctx.s.seats[seatId];
    const deducted = Math.min(seat.funds, penalty);
    seat.funds -= deducted;
    emitEvent(ctx.s, ctx.out, 'PENALTY', 'PUBLIC',
      { seatId, amount: deducted, penalty, source: 'CRISIS' }, ctx.round, 'SETTLEMENT');
  }
}

// 步骤 8：公证契约（TDD-001 §6.2 步骤 8、§5.4/§5.5）。
// 收集本回合结算类触发（PROJECT_RESULT / PLAYER_AWARDED / CRISIS_RESULT / CRISIS_CONTRIBUTION），
// 对 ACTIVE 且匹配的契约按 registeredAt 升序执行；到期未触发 → VOID；
// 第 6 回合结算后所有仍 ACTIVE 的契约一律 VOID（托管退回，不计失信）。
// 注意时序：中标收益在下一回合才到账（issues #12），本步骤的条件付款只能动用现有余额——
// 想以中标收益偿付的债务应使用 ROUND_START(下一回合) 触发（roundStart 先到账再执行契约）。
// PLAYER_AWARDED 的「中标」= 出现在中标队 members / 录取名单（§5.2）；商业 FAIL 仍算中标。
export function step8NotarizedContracts(ctx: Ctx, r: SettleResults): void {
  const facts: SettleFacts = {
    round: ctx.round,
    projectResult: {
      ENGINEERING: r.engineering.winner ? 'SUCCESS' : 'NO_AWARD',
      WAR: r.war.winner ? 'SUCCESS' : 'NO_AWARD',
      COMMERCE: r.commerce.result,
      ADMIN: r.admin.selected.length > 0 ? 'SUCCESS' : 'NO_AWARD',
    },
    awardedSeats: {
      ENGINEERING: r.engineering.winner?.members ?? [],
      WAR: r.war.winner?.members ?? [],
      COMMERCE: r.commerce.winner?.members ?? [],
      ADMIN: r.admin.selected,
    },
    crisisResult: r.crisis.result,
    crisisContributions: r.crisis.contributions,
  };
  step8Execute(ctx.s, ctx.out, facts);
}

// 步骤 9：记录。项目成功记录（中标队有效参与者，§6.3）；履历印章（每人每回合 ≤ 1，
// 危机来源标记 source = CRISIS，终局最多 1 枚计入晋级）；行政录取者 intel 入账。
export function step9Records(ctx: Ctx, r: SettleResults): void {
  // 有效参与（TDD-001 §6.3）：实际贡献 ≥ 10 资金或 ≥ 20 能力；仅提供资格不计
  const effective = (c: TeamContribution) => c.funds >= 10 || c.ability >= 20;

  // 各座位本回合获得的记录领域，按结算顺序（工程 → 战争 → 商业 → 行政）
  const grantedDomains = new Map<SeatId, Domain[]>();
  const grantRecord = (seatId: SeatId, domain: Domain) => {
    ctx.s.seats[seatId].records.push({ round: ctx.round, domain });
    const list = grantedDomains.get(seatId) ?? [];
    list.push(domain);
    grantedDomains.set(seatId, list);
    emitEvent(ctx.s, ctx.out, 'RECORD_GRANTED', 'PUBLIC', { seatId, domain }, ctx.round, 'SETTLEMENT');
  };

  if (r.engineering.winner) {
    for (const c of r.engineering.winner.contributions) if (effective(c)) grantRecord(c.seatId, 'ENGINEERING');
  }
  if (r.war.winner) {
    for (const c of r.war.winner.contributions) if (effective(c)) grantRecord(c.seatId, 'WAR');
  }
  if (r.commerce.winner && r.commerce.result === 'SUCCESS') {
    for (const c of r.commerce.winner.contributions) if (effective(c)) grantRecord(c.seatId, 'COMMERCE');
  }
  for (const seatId of r.admin.selected) grantRecord(seatId, 'ADMIN');   // 录取即有效参与（§6.3）

  // 履历印章：本回合至少 1 次有效参与得 1 枚（规则书 §6.2）；危机 SUCCESS 且贡献达标同样计入
  // （规则书 §15.1：贡献 ≥ 10 资金或 ≥ 20 能力）。来源优先取普通项目领域（危机印章终局计数受限）。
  for (const seatId of Object.keys(ctx.s.seats).map(Number) as SeatId[]) {
    const domains = grantedDomains.get(seatId) ?? [];
    const contrib = r.crisis.contributions[seatId];
    const crisisEligible = r.crisis.result === 'SUCCESS'
      && contrib !== undefined && (contrib.funds >= 10 || contrib.ability >= 20);
    if (domains.length === 0 && !crisisEligible) continue;
    const source: Domain = domains[0] ?? 'CRISIS';
    ctx.s.seats[seatId].stamps.push({ round: ctx.round, source });
    emitEvent(ctx.s, ctx.out, 'STAMP_GRANTED', 'PUBLIC', { seatId, source }, ctx.round, 'SETTLEMENT');
  }

  // 行政录取者的情报权入账
  for (const seatId of r.admin.selected) {
    ctx.s.seats[seatId].intel += r.admin.intelEach;
  }
}

// 步骤 10：排队。基础资格购买（stamps ≥ 2 且已锁定 20，校验在提交阶段完成）；
// 专业/组织/行政晋升（持基础资格期间对应领域记录 ≥ 2，规则书 §7.2–7.4）。
// 写入 pendingQualifications，ROUND_START 步骤 a 执行。
export function step10QueueQualifications(ctx: Ctx): void {
  // 购买基础资格。2026-08-27 裁定（issues #10）：印章在结算时点数（含本回合步骤 9 新得的），
  // 与规则书 §7.1「最早第 3 回合取得」一致；印章不足则退还锁定的 20（判定依赖步骤 9，
  // 故此处例外地在记录段动钱）。
  for (const sub of ctx.subs.values()) {
    if (sub.qualificationPurchase !== true) continue;
    const seat = ctx.s.seats[sub.seatId];
    seat.lockedFunds -= QUALIFICATION_PURCHASE_COST;
    if (seat.stamps.length >= 2) {
      ctx.s.pendingQualifications.push({ seatId: sub.seatId, kind: 'BASIC', viaPurchase: true });
      emitEvent(ctx.s, ctx.out, 'QUALIFICATION_QUEUED', 'PUBLIC',
        { seatId: sub.seatId, kind: 'BASIC', viaPurchase: true }, ctx.round, 'SETTLEMENT');
    } else {
      seat.funds += QUALIFICATION_PURCHASE_COST;
      emitEvent(ctx.s, ctx.out, 'PAYOUT', 'PUBLIC',
        { kind: 'REFUND', seatId: sub.seatId, amount: QUALIFICATION_PURCHASE_COST, source: 'QUALIFICATION_PURCHASE' },
        ctx.round, 'SETTLEMENT');
    }
  }

  // 晋升：持有基础资格，且持有期间对应领域成功记录 ≥ 2。
  // 领域 → 目标资格：工程 → ENGINEERING（§7.2）、行政 → ADMIN（§7.3）、战争 → ORG（§7.4）。
  // 同时满足多路晋升时按规则书章节顺序取先者，只排队一项（issues #8）。
  const UPGRADE_PATHS: [Domain, 'ENGINEERING' | 'ADMIN' | 'ORG'][] = [
    ['ENGINEERING', 'ENGINEERING'],
    ['ADMIN', 'ADMIN'],
    ['WAR', 'ORG'],
  ];
  for (const seatId of Object.keys(ctx.s.seats).map(Number) as SeatId[]) {
    const seat = ctx.s.seats[seatId];
    const basic = seat.qualifications.find((q) => q.kind === 'BASIC');
    if (!basic) continue;
    if (ctx.s.pendingQualifications.some((p) => p.seatId === seatId)) continue;
    for (const [domain, target] of UPGRADE_PATHS) {
      const count = seat.records.filter((rec) => rec.domain === domain && rec.round >= basic.acquiredRound).length;
      if (count >= 2) {
        ctx.s.pendingQualifications.push({ seatId, kind: target, viaPurchase: false });
        emitEvent(ctx.s, ctx.out, 'QUALIFICATION_QUEUED', 'PUBLIC',
          { seatId, kind: target, viaPurchase: false }, ctx.round, 'SETTLEMENT');
        break;
      }
    }
  }
}

// 把本回合的结算事实落成一条 HOST 事件（roundFacts.ts 说明了为什么需要它）。
// 全部字段都是结算已完成后的事实，不含任何仍需保密的信息。
function writeRoundFacts(ctx: Ctx, r: SettleResults): void {
  const toFactsTeam = (t: Team): FactsTeam => ({
    teamId: t.teamId,
    members: [...t.members],
    formed: t.formed,
    legal: t.legal,
    payee: t.payee,
    bid: t.bid,
    contributions: t.contributions.map((c) => ({
      seatId: c.seatId, funds: c.funds, ability: c.ability,
      ...(c.qualificationUsed !== undefined ? { qualificationUsed: c.qualificationUsed } : {}),
    })),
  });

  const seatIds = Object.keys(ctx.s.seats).map(Number) as SeatId[];
  const abilityCommitted: Record<string, number> = {};
  const gains: Record<string, number> = {};
  for (const id of seatIds) {
    abilityCommitted[String(id)] = ctx.s.seats[id].abilityCommitted;
    gains[String(id)] = 0;
  }
  const addGain = (id: SeatId, n: number) => { gains[String(id)] = (gains[String(id)] ?? 0) + n; };

  // 中标收益按 payee 计（在途，下一回合到账，但归属本回合）
  if (r.engineering.winner?.payee != null) addGain(r.engineering.winner.payee, r.engineering.payout);
  if (r.war.winner?.payee != null) addGain(r.war.winner.payee, r.war.payout);
  if (r.commerce.winner?.payee != null && r.commerce.result === 'SUCCESS') {
    addGain(r.commerce.winner.payee, r.commerce.payout);
  }
  // 落选返还与行政报酬当回合入账
  for (const t of r.war.teams) {
    if (t === r.war.winner) continue;
    for (const c of t.contributions) addGain(c.seatId, Math.floor(c.funds * 0.8));
  }
  for (const t of r.commerce.teams) {
    if (t === r.commerce.winner) continue;
    for (const c of t.contributions) addGain(c.seatId, c.funds);
  }
  for (const id of r.admin.selected) addGain(id, r.admin.payoutEach);

  const teams: Record<TeamDomain, FactsTeam[]> = {
    ENGINEERING: r.engineering.teams.map(toFactsTeam),
    WAR: r.war.teams.map(toFactsTeam),
    COMMERCE: r.commerce.teams.map(toFactsTeam),
  };
  const projectResult: Record<ProjectDomain, 'SUCCESS' | 'FAIL' | 'NO_AWARD'> = {
    ENGINEERING: r.engineering.winner ? 'SUCCESS' : 'NO_AWARD',
    WAR: r.war.winner ? 'SUCCESS' : 'NO_AWARD',
    COMMERCE: r.commerce.result,
    ADMIN: r.admin.selected.length > 0 ? 'SUCCESS' : 'NO_AWARD',
  };
  const entryLabel: Record<ProjectDomain, string> = {
    ENGINEERING: entryToString(r.engineering.card.entry),
    WAR: entryToString(r.war.card.entry),
    COMMERCE: entryToString(r.commerce.card.entry),
    ADMIN: entryToString(r.admin.card.entry),
  };
  const pledges = pledgeTotals(ctx.s, ctx.round);

  emitRoundFacts(ctx.s, ctx.out, {
    round: ctx.round,
    teams,
    winnerTeamId: {
      ENGINEERING: r.engineering.winner?.teamId ?? null,
      WAR: r.war.winner?.teamId ?? null,
      COMMERCE: r.commerce.winner?.teamId ?? null,
    },
    winnerMembers: {
      ENGINEERING: r.engineering.winner?.members ?? [],
      WAR: r.war.winner?.members ?? [],
      COMMERCE: r.commerce.result === 'SUCCESS' ? (r.commerce.winner?.members ?? []) : (r.commerce.winner?.members ?? []),
    },
    projectResult,
    entryLabel,
    admin: { applicants: r.admin.applicants.map((a) => ({ ...a })), selected: [...r.admin.selected] },
    crisis: {
      result: r.crisis.result,
      contributions: Object.fromEntries(
        Object.entries(r.crisis.contributions).map(([k, v]) => [k, { funds: v!.funds, ability: v!.ability }])),
      fundsTarget: r.crisis.card.fundsTarget!,
      abilityTarget: r.crisis.card.abilityTarget!,
    },
    abilityCommitted,
    gains,
    pledges: { count: pledges.count, funds: pledges.funds, ability: pledges.ability },
  });
}

// 步骤 11：收尾。写入本回合结算事实（HOST 审计记录，roundFacts.ts）、跑自动档成就查询
// （TDD-001 §8.3 / TDD-002 §5）；公开日志即本次事件列表；
// 解冻转账由 Game Server 在进入下一回合 REVEAL_AND_INTEL 时执行（引擎无 I/O）。
export function step11Wrapup(ctx: Ctx, r: SettleResults): void {
  writeRoundFacts(ctx, r);
  evaluateRoundAchievements(ctx.s, ctx.out, ctx.round);

  if (ctx.round === 6) {
    // 第 6 回合没有下一回合：在途收益终局前即时到账（issues #12），保证过线判定含此资金
    flushPendingPayouts(ctx.s, ctx.out, ctx.round, 'SETTLEMENT');
    ctx.s.phase = 'GAME_END';
    emitEvent(ctx.s, ctx.out, 'GAME_END', 'PUBLIC', { seed: ctx.seed }, ctx.round, 'GAME_END');
  } else {
    ctx.s.round = (ctx.round + 1) as Round;
    ctx.s.phase = 'ROUND_START';
  }
}

// ── 主函数 ───────────────────────────────────────────────────────────

export function settle(
  state: Game,
  submissions: Submission[],
  seed: string,
): { state: Game; events: GameEvent[]; results: SettleResults } {
  // 步骤 0：校验与锁定断言（校验与锁定实际发生在 SUBMISSION 阶段，见 validate.ts）
  if (state.phase !== 'SUBMISSION') throw new Error(`settle：阶段 ${state.phase} 不可结算`);
  if (seed !== state.seed) throw new Error('settle：seed 与 state.seed 不一致');
  const seatIds = new Set<SeatId>();
  for (const sub of submissions) {
    if (sub.round !== state.round) throw new Error(`settle：提交回合 ${sub.round} ≠ 当前回合 ${state.round}`);
    if (seatIds.has(sub.seatId)) throw new Error(`settle：座位 ${sub.seatId} 重复提交`);
    seatIds.add(sub.seatId);
  }
  // 锁定一致性断言（TDD-001 §6.2 步骤 0）：每座位的锁定资金与已投能力
  // 必须与传入的被接受提交严格对应，未经 lockSubmissions 的提交不得进入结算。
  // 锁定 = 本回合提交锁定 + ACTIVE 公证契约的托管额（§5.4）。
  {
    const bySeat = new Map(submissions.map((sub) => [sub.seatId, sub]));
    const escrowBySeat = new Map<SeatId, number>();
    for (const c of state.contracts) {
      if (c.tier === 'NOTARIZED' && c.status === 'ACTIVE' && c.escrowed) {
        escrowBySeat.set(c.payer, (escrowBySeat.get(c.payer) ?? 0) + c.amount);
      }
    }
    for (const seatId of Object.keys(state.seats).map(Number) as SeatId[]) {
      const sub = bySeat.get(seatId);
      const expectedLock = (escrowBySeat.get(seatId) ?? 0)
        + (sub === undefined ? 0
          : sub.entries.reduce((a, e) => a + ('funds' in e ? e.funds : 0), 0)
            + (sub.qualificationPurchase === true ? QUALIFICATION_PURCHASE_COST : 0));
      const expectedAbility = sub === undefined ? 0
        : sub.entries.reduce((a, e) => a + e.ability, 0);
      const seat = state.seats[seatId];
      if (seat.lockedFunds !== expectedLock) {
        throw new Error(`settle：座位 ${seatId} 锁定资金 ${seat.lockedFunds} 与提交 ${expectedLock} 不一致（提交未经锁定？）`);
      }
      if (seat.abilityCommitted !== expectedAbility) {
        throw new Error(`settle：座位 ${seatId} 已投能力 ${seat.abilityCommitted} 与提交 ${expectedAbility} 不一致（提交未经锁定？）`);
      }
    }
  }

  const s = structuredClone(state);
  s.phase = 'SETTLEMENT';
  const out: GameEvent[] = [];
  // 按 seatId 规范化提交顺序，保证结果与调用方传入顺序无关
  const ordered = [...submissions].sort((a, b) => a.seatId - b.seatId);
  const ctx: Ctx = {
    s, out, seed, round: s.round,
    subs: new Map(ordered.map((sub) => [sub.seatId, sub])),
  };

  // 结果段（1–5）：只产生 Result，不动钱
  const results: SettleResults = {
    engineering: step1Engineering(ctx),
    war: step2War(ctx),
    commerce: step3Commerce(ctx),
    admin: step4Admin(ctx),
    crisis: step5Crisis(ctx),
  };

  // 资金段（6–8）
  step6Income(ctx, results);
  step7Deductions(ctx, results);
  step8NotarizedContracts(ctx, results);

  // 记录段（9–11）
  step9Records(ctx, results);
  step10QueueQualifications(ctx);
  step11Wrapup(ctx, results);

  return { state: s, events: out, results };
}
