// 契约引擎（TDD-001 §5 / §9，阶段 2）。
// 公证契约：付费登记、封闭枚举触发、单笔定额转账、引擎强制执行、失信公开（G2/G3）。
// 备忘契约：免费登记、只记录不执行、指控/反驳只广播不裁决（G4）。
// 登记发生在 NEGOTIATION 阶段（§3.2）；引擎收到的是双方已确认的最终契约
// （待确认推送与拒绝在 Game Server 层，§9.1 步骤 3）。
import type {
  Domain, Game, GameEvent, IntelClaim, MemoContract, NotarizedContract,
  Phase, Round, SeatId, Trigger,
} from './types.js';
import { emitEvent } from './events.js';
import { holdsQualification } from './qualification.js';

export const CONTRACT_FEE = 5;           // 规则书 §10：每份正式契约登记费 5 资金
export const CONTRACT_AMOUNT_MIN = 1;    // TDD-001 §5.3
export const CONTRACT_AMOUNT_MAX = 200;  // TODO(TDD-001 C.5)：amount 上限 200 待验证
export const MEMO_TEXT_MAX = 140;        // TODO(TDD-001 C.4)：摘要/指控/反驳字数上限 140 待验证

export type ContractResult =
  | { ok: true; state: Game; events: GameEvent[]; contractId: string }
  | { ok: false; reason: string };

const SETTLE_TRIGGER_KINDS = new Set(['PROJECT_RESULT', 'PLAYER_AWARDED', 'CRISIS_RESULT', 'CRISIS_CONTRIBUTION']);

function isSettleClass(t: Trigger): boolean {
  return SETTLE_TRIGGER_KINDS.has(t.kind);
}

function textLen(s: string): number {
  return [...s].length;   // 按码点计数
}

function nextContractId(s: Game): string {
  return `C${String(s.contracts.length + 1).padStart(3, '0')}`;
}

// ── 公证契约登记（§9.1）──────────────────────────────────────────────

export interface NotarizedDraft {
  parties: [SeatId, SeatId];
  payer: SeatId;
  payee: SeatId;
  trigger: Trigger;
  amount: number;
  escrowed: boolean;
  expiresRound: Round;
  feeSplit: [number, number];     // 按 parties 顺序，和为 5
  witnesses?: SeatId[];
}

export function registerNotarizedContract(state: Game, draft: NotarizedDraft): ContractResult {
  if (state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${state.phase} 不可登记契约` };
  const [pa, pb] = draft.parties;
  if (pa === pb) return { ok: false, reason: '当事人不能是同一座位' };
  if (draft.payer === draft.payee) return { ok: false, reason: 'payer 与 payee 不能相同' };
  if (!draft.parties.includes(draft.payer) || !draft.parties.includes(draft.payee)) {
    return { ok: false, reason: 'payer/payee 必须是当事人' };
  }
  if (!Number.isInteger(draft.amount) || draft.amount < CONTRACT_AMOUNT_MIN || draft.amount > CONTRACT_AMOUNT_MAX) {
    return { ok: false, reason: `amount 须为 ${CONTRACT_AMOUNT_MIN}..${CONTRACT_AMOUNT_MAX} 的整数` };
  }
  const [fa, fb] = draft.feeSplit;
  if (!Number.isInteger(fa) || !Number.isInteger(fb) || fa < 0 || fb < 0 || fa + fb !== CONTRACT_FEE) {
    return { ok: false, reason: `登记费分摊须为非负整数且和为 ${CONTRACT_FEE}` };
  }

  // 触发条件与失效回合校验（§9.1 步骤 2）
  const t = draft.trigger;
  if (t.kind === 'ROUND_START') {
    if (t.round <= state.round) return { ok: false, reason: '回合开始类触发回合必须晚于当前回合' };
    if (draft.expiresRound < t.round) return { ok: false, reason: 'expiresRound 不能早于触发回合' };
  } else if (t.kind === 'QUALIFICATION_GAINED') {
    // byRound 为最后检查回合（issues #14：expiresRound 与 byRound 的关系
    // TDD 未规定，保守要求 expiresRound ≥ byRound，作废以 byRound 为准）
    if (t.byRound <= state.round) return { ok: false, reason: 'byRound 必须晚于当前回合' };
    if (draft.expiresRound < t.byRound) return { ok: false, reason: 'expiresRound 不能早于 byRound' };
  } else {
    // 结算类：PROJECT_RESULT / PLAYER_AWARDED / CRISIS_RESULT / CRISIS_CONTRIBUTION
    if (t.round < state.round) return { ok: false, reason: '结算类触发回合不能早于当前回合' };
    if (draft.expiresRound < t.round) return { ok: false, reason: 'expiresRound 不能早于触发回合' };
    if (t.kind === 'CRISIS_CONTRIBUTION' && (!Number.isInteger(t.atLeast) || t.atLeast < 1)) {
      return { ok: false, reason: 'atLeast 须为正整数' };
    }
  }
  // 托管仅对 ROUND_START 提供（§5.4）
  if (draft.escrowed && t.kind !== 'ROUND_START') {
    return { ok: false, reason: '托管仅对 ROUND_START 触发提供' };
  }

  // 资金校验：双方各自的登记费份额；托管时 payer 还须覆盖 amount
  const s = structuredClone(state);
  const seatA = s.seats[pa], seatB = s.seats[pb];
  const escrowNeed = draft.escrowed ? draft.amount : 0;
  const needA = fa + (draft.payer === pa ? escrowNeed : 0);
  const needB = fb + (draft.payer === pb ? escrowNeed : 0);
  if (seatA.funds < needA) return { ok: false, reason: `座位 ${pa} 资金不足（需 ${needA}）` };
  if (seatB.funds < needB) return { ok: false, reason: `座位 ${pb} 资金不足（需 ${needB}）` };

  // 生效：扣登记费（消耗）；托管锁定
  seatA.funds -= fa;
  seatB.funds -= fb;
  if (draft.escrowed) {
    s.seats[draft.payer].funds -= draft.amount;
    s.seats[draft.payer].lockedFunds += draft.amount;
  }

  const contract: NotarizedContract = {
    contractId: nextContractId(s),
    tier: 'NOTARIZED',
    registeredRound: s.round,
    registeredAt: s.contracts.length,
    parties: draft.parties,
    witnesses: draft.witnesses ?? [],
    status: 'ACTIVE',
    trigger: draft.trigger,
    payer: draft.payer,
    payee: draft.payee,
    amount: draft.amount,
    escrowed: draft.escrowed,
    expiresRound: draft.expiresRound,
    feeSplit: draft.feeSplit,
  };
  s.contracts.push(contract);

  // §9.1 步骤 5：存在/当事人公开，条款仅当事人（与见证人——见证人可见性由 Server 按 witnesses 转发）
  const events: GameEvent[] = [];
  emitEvent(s, events, 'CONTRACT_REGISTERED', 'PUBLIC',
    { contractId: contract.contractId, parties: contract.parties, tier: 'NOTARIZED' }, s.round, s.phase);
  emitEvent(s, events, 'CONTRACT_REGISTERED', 'PARTIES', {
    contractId: contract.contractId, parties: contract.parties, tier: 'NOTARIZED',
    trigger: contract.trigger, payer: contract.payer, payee: contract.payee,
    amount: contract.amount, escrowed: contract.escrowed,
    expiresRound: contract.expiresRound, feeSplit: contract.feeSplit,
    witnesses: contract.witnesses,
  }, s.round, s.phase);

  return { ok: true, state: s, events, contractId: contract.contractId };
}

// ── 取消（§5.6：双方确认取消，触发前；托管退回，登记费不退）─────────────
// 取消窗口 TDD 未规定，保守限定在 NEGOTIATION（issues #15）。双方确认由 Server 层保证。

export function cancelNotarizedContract(state: Game, contractId: string): ContractResult {
  if (state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${state.phase} 不可取消契约` };
  const s = structuredClone(state);
  const c = s.contracts.find((x) => x.contractId === contractId);
  if (c === undefined || c.tier !== 'NOTARIZED') return { ok: false, reason: '契约不存在' };
  if (c.status !== 'ACTIVE') return { ok: false, reason: `状态 ${c.status} 不可取消` };
  c.status = 'CANCELLED';
  if (c.escrowed) {
    s.seats[c.payer].lockedFunds -= c.amount;
    s.seats[c.payer].funds += c.amount;
  }
  const events: GameEvent[] = [];
  emitEvent(s, events, 'CONTRACT_CANCELLED', 'PUBLIC', { contractId }, s.round, s.phase);
  return { ok: true, state: s, events, contractId };
}

// ── 备忘契约（§5.7 / §9.2）────────────────────────────────────────────

export interface MemoDraft {
  parties: [SeatId, SeatId];
  summary: string;
  kind: 'GENERAL' | 'INTEL_RELAY';
  intelClaim?: IntelClaim;
  witnesses?: SeatId[];
}

export function registerMemoContract(state: Game, draft: MemoDraft): ContractResult {
  if (state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${state.phase} 不可登记契约` };
  const [pa, pb] = draft.parties;
  if (pa === pb) return { ok: false, reason: '当事人不能是同一座位' };
  if (textLen(draft.summary) > MEMO_TEXT_MAX) return { ok: false, reason: `摘要超过 ${MEMO_TEXT_MAX} 字` };
  if (draft.kind === 'INTEL_RELAY') {
    const ic = draft.intelClaim;
    if (ic === undefined || ic.target === undefined || ic.field === undefined || ic.claimedValue === undefined) {
      return { ok: false, reason: 'INTEL_RELAY 需要完整的 intelClaim（target / field / claimedValue）' };
    }
  }

  const s = structuredClone(state);
  const contract: MemoContract = {
    contractId: nextContractId(s),
    tier: 'MEMO',
    registeredRound: s.round,
    registeredAt: s.contracts.length,
    parties: draft.parties,
    witnesses: draft.witnesses ?? [],
    status: 'OPEN',
    summary: draft.summary,
    kind: draft.kind,
    accusations: [],
  };
  if (draft.kind === 'INTEL_RELAY') contract.intelClaim = draft.intelClaim!;
  s.contracts.push(contract);

  const events: GameEvent[] = [];
  // PUBLIC 只含存在性信息（§5.1：存在/当事人公开，条款私密）；kind 属条款级，只进 PARTIES
  emitEvent(s, events, 'MEMO_REGISTERED', 'PUBLIC',
    { contractId: contract.contractId, parties: contract.parties, tier: 'MEMO' }, s.round, s.phase);
  emitEvent(s, events, 'MEMO_REGISTERED', 'PARTIES', {
    contractId: contract.contractId, parties: contract.parties, kind: contract.kind,
    summary: contract.summary,
    ...(contract.intelClaim !== undefined ? { intelClaim: contract.intelClaim } : {}),
  }, s.round, s.phase);
  return { ok: true, state: s, events, contractId: contract.contractId };
}

// 指控：每人每回合最多 1 次；仅当事人；NEGOTIATION 阶段；立即广播全体；引擎不裁决（§5.7）
export function accuseMemoContract(state: Game, contractId: string, by: SeatId, statement: string): ContractResult {
  if (state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${state.phase} 不可指控` };
  if (textLen(statement) > MEMO_TEXT_MAX) return { ok: false, reason: `指控超过 ${MEMO_TEXT_MAX} 字` };
  const already = state.events.some((e) =>
    e.type === 'MEMO_ACCUSED' && e.round === state.round && (e.payload['by'] as SeatId) === by);
  if (already) return { ok: false, reason: '每人每回合最多发出 1 次指控' };

  const s = structuredClone(state);
  const c = s.contracts.find((x) => x.contractId === contractId);
  if (c === undefined || c.tier !== 'MEMO') return { ok: false, reason: '备忘契约不存在' };
  if (!c.parties.includes(by)) return { ok: false, reason: '只有当事人可以指控' };
  c.accusations.push({ round: s.round, by, statement });
  c.status = 'DISPUTED';
  const events: GameEvent[] = [];
  emitEvent(s, events, 'MEMO_ACCUSED', 'PUBLIC',
    { contractId, by, statement, seq: c.accusations.length - 1 }, s.round, s.phase);
  return { ok: true, state: s, events, contractId };
}

// 反驳：针对自己的最近一条未反驳指控；每人每回合最多 1 次；不改变状态（§5.7）
export function rebutMemoContract(state: Game, contractId: string, by: SeatId, statement: string): ContractResult {
  if (state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${state.phase} 不可反驳` };
  if (textLen(statement) > MEMO_TEXT_MAX) return { ok: false, reason: `反驳超过 ${MEMO_TEXT_MAX} 字` };
  const already = state.events.some((e) =>
    e.type === 'MEMO_REBUTTED' && e.round === state.round && (e.payload['by'] as SeatId) === by);
  if (already) return { ok: false, reason: '每人每回合最多 1 次反驳' };

  const s = structuredClone(state);
  const c = s.contracts.find((x) => x.contractId === contractId);
  if (c === undefined || c.tier !== 'MEMO') return { ok: false, reason: '备忘契约不存在' };
  if (!c.parties.includes(by)) return { ok: false, reason: '只有当事人可以反驳' };
  const target = [...c.accusations].reverse().find((a) => a.by !== by && a.rebuttal === undefined);
  if (target === undefined) return { ok: false, reason: '没有可反驳的指控' };
  target.rebuttal = { round: s.round, statement };
  const events: GameEvent[] = [];
  // 广播带序号（§5.7），seq = 被反驳指控在该契约 accusations 中的下标，与 MEMO_ACCUSED 对齐
  emitEvent(s, events, 'MEMO_REBUTTED', 'PUBLIC',
    { contractId, by, statement, seq: c.accusations.indexOf(target) }, s.round, s.phase);
  return { ok: true, state: s, events, contractId };
}

// ── 执行与作废（settle 步骤 8 / roundStart 步骤 b 共用）───────────────

// 条件付款与失信（§5.4 / §5.5）：托管契约转付托管；条件付款按可用余额支付，
// 不足则 DEFAULTED / PARTIAL_DEFAULT + 公开失信记录；短缺不结转、不追偿、无负余额（NG2）。
export function executeContract(s: Game, out: GameEvent[], c: NotarizedContract, round: Round, phase: Phase): void {
  emitEvent(s, out, 'CONTRACT_TRIGGERED', 'PARTIES',
    { contractId: c.contractId, trigger: c.trigger }, round, phase);
  const payerSeat = s.seats[c.payer];
  const payeeSeat = s.seats[c.payee];
  if (c.escrowed) {
    payerSeat.lockedFunds -= c.amount;
    payeeSeat.funds += c.amount;
    c.status = 'FULFILLED';
    emitEvent(s, out, 'CONTRACT_FULFILLED', 'PUBLIC',
      { contractId: c.contractId, payer: c.payer, payee: c.payee, amount: c.amount, escrowed: true }, round, phase);
    return;
  }
  const paid = Math.min(payerSeat.funds, c.amount);
  payerSeat.funds -= paid;
  payeeSeat.funds += paid;
  if (paid === c.amount) {
    c.status = 'FULFILLED';
    emitEvent(s, out, 'CONTRACT_FULFILLED', 'PUBLIC',
      { contractId: c.contractId, payer: c.payer, payee: c.payee, amount: c.amount }, round, phase);
  } else {
    c.status = paid === 0 ? 'DEFAULTED' : 'PARTIAL_DEFAULT';
    const record = { round, contractId: c.contractId, payee: c.payee, owed: c.amount, paid, shortfall: c.amount - paid };
    payerSeat.defaults.push(record);
    // 失信记录全部字段公开（§5.5）：同时揭示「谁失信」与「谁选择了信任失信者」
    emitEvent(s, out, 'CONTRACT_DEFAULTED', 'PUBLIC',
      { ...record, payer: c.payer, status: c.status }, round, phase);
  }
}

export function voidContract(s: Game, out: GameEvent[], c: NotarizedContract, round: Round, phase: Phase, reason: string): void {
  c.status = 'VOID';
  if (c.escrowed) {
    s.seats[c.payer].lockedFunds -= c.amount;
    s.seats[c.payer].funds += c.amount;
  }
  emitEvent(s, out, 'CONTRACT_VOID', 'PUBLIC', { contractId: c.contractId, reason }, round, phase);
}

function activeNotarized(s: Game, cls: 'SETTLE' | 'ROUND_START'): NotarizedContract[] {
  return (s.contracts.filter((c) =>
    c.tier === 'NOTARIZED' && c.status === 'ACTIVE'
    && (cls === 'SETTLE' ? isSettleClass(c.trigger) : !isSettleClass(c.trigger)),
  ) as NotarizedContract[]).sort((a, b) => a.registeredAt - b.registeredAt);
}

// settle 步骤 8 使用的事实来源（步骤 1–5 的结果）
export interface SettleFacts {
  round: Round;
  projectResult: Record<Exclude<Domain, 'CRISIS'>, 'SUCCESS' | 'FAIL' | 'NO_AWARD'>;
  awardedSeats: Record<Exclude<Domain, 'CRISIS'>, SeatId[]>;   // 中标队 members / 录取名单
  crisisResult: 'SUCCESS' | 'FAIL';
  crisisContributions: Partial<Record<SeatId, { funds: number; ability: number }>>;
}

function settleTriggerMatches(t: Trigger, facts: SettleFacts): boolean {
  switch (t.kind) {
    case 'PROJECT_RESULT':
      return t.round === facts.round && facts.projectResult[t.domain] === t.result;
    case 'PLAYER_AWARDED':
      return t.round === facts.round && facts.awardedSeats[t.domain].includes(t.seat) === t.awarded;
    case 'CRISIS_RESULT':
      return t.round === facts.round && facts.crisisResult === t.result;
    case 'CRISIS_CONTRIBUTION': {
      if (t.round !== facts.round) return false;
      const c = facts.crisisContributions[t.seat];
      const actual = t.resource === 'FUNDS' ? (c?.funds ?? 0) : (c?.ability ?? 0);
      return actual >= t.atLeast;
    }
    default:
      return false;
  }
}

// settle 步骤 8：结算类触发按 registeredAt 升序执行；expiresRound = 本回合未触发 → VOID；
// 第 6 回合结算后所有仍 ACTIVE 的契约一律 VOID（托管退回，不计失信，§5.6 / §10.2）。
export function step8Execute(s: Game, out: GameEvent[], facts: SettleFacts): void {
  for (const c of activeNotarized(s, 'SETTLE')) {
    if (settleTriggerMatches(c.trigger, facts)) executeContract(s, out, c, facts.round, 'SETTLEMENT');
  }
  for (const c of activeNotarized(s, 'SETTLE')) {
    if (c.expiresRound === facts.round) voidContract(s, out, c, facts.round, 'SETTLEMENT', 'EXPIRED');
  }
  if (facts.round === 6) {
    for (const c of s.contracts) {
      if (c.tier === 'NOTARIZED' && c.status === 'ACTIVE') {
        voidContract(s, out, c, facts.round, 'SETTLEMENT', 'GAME_END');
      }
    }
  }
}

// roundStart 步骤 b：回合开始类契约判定（在步骤 a 之后，资格已生效；在途收益已到账）。
// ROUND_START：到期回合执行（托管转付 / 条件付款）。
// QUALIFICATION_GAINED：检查资格状态，满足即执行；byRound = 本回合仍未满足 → VOID。
export function stepBRoundStartContracts(s: Game, out: GameEvent[], round: Round): void {
  for (const c of activeNotarized(s, 'ROUND_START')) {
    const t = c.trigger;
    if (t.kind === 'ROUND_START') {
      if (t.round === round) executeContract(s, out, c, round, 'ROUND_START');
    } else if (t.kind === 'QUALIFICATION_GAINED') {
      if (holdsQualification(s.seats[t.seat], t.kind_)) {
        executeContract(s, out, c, round, 'ROUND_START');
      } else if (t.byRound === round) {
        voidContract(s, out, c, round, 'ROUND_START', 'QUALIFICATION_NOT_GAINED');
      }
    }
  }
  for (const c of activeNotarized(s, 'ROUND_START')) {
    if (c.expiresRound === round) voidContract(s, out, c, round, 'ROUND_START', 'EXPIRED');
  }
}
