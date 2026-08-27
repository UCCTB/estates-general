// TDD-001 §10.1 提交校验（SUBMISSION 阶段，逐份即时）。
// 通过后立即锁定：funds -= Σ; lockedFunds += Σ; abilityCommitted = Σ；资格 usedThisRound = true；
// 发出 SUBMISSION_LOCKED。截止后不可修改。
//
// §10.1 之外的输入卫生检查（负数 / 非整数 / 成员列表畸形）按最保守方式处理，
// 处理粒度记录见 docs/tdd-001-issues.md #6。
import type {
  Game, GameEvent, Qualification, SeatId, Submission, SubmissionEntry,
} from './types.js';
import { emitEvent } from './events.js';
import { holdsQualification } from './qualification.js';

export interface LockResult {
  state: Game;
  events: GameEvent[];
  accepted: Submission[];
  rejected: { seatId: SeatId; reason: string }[];
}

const QUALIFICATION_PURCHASE_COST = 20;   // 规则书 §7.1

function isNonNegInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function entryFunds(e: SubmissionEntry): number {
  return 'funds' in e ? e.funds : 0;
}

// 单份提交校验。返回清洗后的提交（可能剔除个别 entry / 字段）或整份拒绝理由。
function validateOne(
  s: Game,
  sub: Submission,
): { ok: true; cleaned: Submission; lockFunds: number; abilitySum: number; usedQuals: Exclude<Qualification, 'NONE'>[] }
  | { ok: false; reason: string } {
  const seat = s.seats[sub.seatId];
  if (sub.round !== s.round) return { ok: false, reason: `round 不匹配：提交 ${sub.round}，当前 ${s.round}` };

  // 输入卫生：数值必须为非负整数
  for (const e of sub.entries) {
    if (!isNonNegInt(e.ability)) return { ok: false, reason: 'ability 非法（须为非负整数）' };
    if ('funds' in e && !isNonNegInt(e.funds)) return { ok: false, reason: 'funds 非法（须为非负整数）' };
    if ('bid' in e && !isNonNegInt(e.bid)) return { ok: false, reason: 'bid 非法（须为非负整数）' };
  }

  const engineeringCard = s.decks.ENGINEERING[s.round - 1]!;
  const cap = engineeringCard.budgetCap!;
  const minBid = Math.ceil(cap * 0.5);

  const entries: SubmissionEntry[] = [];
  for (const e of sub.entries) {
    // §10.1：工程 bid ∈ [ceil(budgetCap×0.5), budgetCap]，否则拒绝该 entry
    if (e.domain === 'ENGINEERING' && (e.bid < minBid || e.bid > cap)) continue;
    // 输入卫生：团队 entry 的 members 须包含提交者本人、无重复（issues #6）；
    // 收款人须为 members 之一（2026-08-27 裁定新增字段，issues #12）
    if ('members' in e) {
      const uniq = new Set(e.members);
      if (uniq.size !== e.members.length || !uniq.has(sub.seatId) || e.members.length < 1) continue;
      if (!uniq.has(e.payee)) continue;
    }
    entries.push(e);
  }

  // qualificationPurchase：需 qualifications 为空，否则拒绝该字段。
  // 2026-08-27 裁定（issues #10）：stamps ≥ 2 改在结算步骤 10 检查（本回合新得的印章算数，
  // 与规则书 §7.1「最早第 3 回合取得」一致；不足则退还 20）。
  // 2026-08-27 裁定（issues #11）：第 6 回合资格已无法生效，直接拒绝该字段。
  let purchase = sub.qualificationPurchase === true;
  if (purchase && (seat.qualifications.length > 0 || s.round === 6)) purchase = false;

  // §10.1：Σ entries.funds + (purchase ? 20 : 0) ≤ funds
  const lockFunds = entries.reduce((acc, e) => acc + entryFunds(e), 0) + (purchase ? QUALIFICATION_PURCHASE_COST : 0);
  if (lockFunds > seat.funds) return { ok: false, reason: `资金不足：需 ${lockFunds}，持有 ${seat.funds}` };

  // §10.1：Σ entries.ability ≤ abilityBase
  const abilitySum = entries.reduce((acc, e) => acc + e.ability, 0);
  if (abilitySum > seat.abilityBase) return { ok: false, reason: `能力超限：投入 ${abilitySum}，基础 ${seat.abilityBase}` };

  // §10.1：每个 qualificationUsed 对应资格持有且未用；同一资格整份提交至多一次
  const usedQuals: Exclude<Qualification, 'NONE'>[] = [];
  for (const e of entries) {
    if (!('qualificationUsed' in e) || e.qualificationUsed === undefined) continue;
    const q = e.qualificationUsed;
    if (q === 'NONE') return { ok: false, reason: 'qualificationUsed 不能为 NONE' };
    if (!holdsQualification(seat, q)) return { ok: false, reason: `未持有资格 ${q}` };
    const st = seat.qualifications.find((x) => x.kind === q)!;
    if (st.usedThisRound) return { ok: false, reason: `资格 ${q} 本回合已使用` };
    if (usedQuals.includes(q)) return { ok: false, reason: `资格 ${q} 在整份提交中重复使用` };
    usedQuals.push(q);
  }

  // §10.1：ADMIN entry 至多一条；CRISIS entry 至多一条
  if (entries.filter((e) => e.domain === 'ADMIN').length > 1) return { ok: false, reason: 'ADMIN entry 多于一条' };
  if (entries.filter((e) => e.domain === 'CRISIS').length > 1) return { ok: false, reason: 'CRISIS entry 多于一条' };

  const cleaned: Submission = { seatId: sub.seatId, round: sub.round, entries };
  if (purchase) cleaned.qualificationPurchase = true;
  return { ok: true, cleaned, lockFunds, abilitySum, usedQuals };
}

// 锁定全部提交。缺席或未提交的座位视为空提交（TDD-001 §7.3），无需出现在 submissions 中。
export function lockSubmissions(state: Game, submissions: Submission[]): LockResult {
  if (state.phase !== 'REVEAL_AND_INTEL' && state.phase !== 'NEGOTIATION' && state.phase !== 'SUBMISSION') {
    throw new Error(`lockSubmissions：阶段 ${state.phase} 不接受提交`);
  }
  const s = structuredClone(state);
  s.phase = 'SUBMISSION';
  const events: GameEvent[] = [];
  const accepted: Submission[] = [];
  const rejected: { seatId: SeatId; reason: string }[] = [];
  // 提交后不得修改（规则书 §9 / TDD-001 §10.1「逐份即时」）：
  // 跨多次 lockSubmissions 调用的去重以事件日志中本回合的 SUBMISSION_LOCKED 为准，
  // 否则同一座位可分批重复锁定资金。
  const seen = new Set<SeatId>();
  for (const e of s.events) {
    if (e.type === 'SUBMISSION_LOCKED' && e.round === s.round) {
      seen.add((e.payload as { seatId: SeatId }).seatId);
    }
  }

  for (const sub of submissions) {
    if (seen.has(sub.seatId)) {
      rejected.push({ seatId: sub.seatId, reason: '本回合已提交，提交后不得修改' });
      continue;
    }
    seen.add(sub.seatId);
    const r = validateOne(s, sub);
    if (!r.ok) {
      rejected.push({ seatId: sub.seatId, reason: r.reason });
      continue;
    }
    const seat = s.seats[sub.seatId];
    seat.funds -= r.lockFunds;
    seat.lockedFunds += r.lockFunds;
    seat.abilityCommitted = r.abilitySum;
    for (const q of r.usedQuals) {
      seat.qualifications.find((x) => x.kind === q)!.usedThisRound = true;
    }
    accepted.push(r.cleaned);
    emitEvent(s, events, 'SUBMISSION_LOCKED', 'PUBLIC', { seatId: sub.seatId }, s.round, 'SUBMISSION');
  }

  return { state: s, events, accepted, rejected };
}
