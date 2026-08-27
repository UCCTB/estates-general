// 情报权（规则书 §5.3 / TDD-001 §4.5）与情报转述终局验证（§5.8）。
// 使用：REVEAL_AND_INTEL 阶段，消耗 1 次，指定下一回合某领域，
// 引擎从尚未向该玩家揭示的字段中随机选一揭示（SEAT 可见）。
// 同一项目不重复揭示已获知字段；字段耗尽则拒绝且不消耗（§10.2）。
import type {
  AuditOrder, Domain, Game, GameEvent, ProjectCard, QualificationRequirement,
  RevealableField, Round, SeatId,
} from './types.js';
import { emitEvent } from './events.js';
import { drawU32 } from './rng.js';

export type IntelResult =
  | { ok: true; state: Game; events: GameEvent[]; field: RevealableField; value: string | number }
  | { ok: false; reason: string };

// 准入的规范字符串（用于揭示与转述比对；与数据表注释的规则书行文一致）
export function entryToString(entry: QualificationRequirement): string {
  switch (entry.kind) {
    case 'NONE': return '无';
    case 'AT_LEAST_BASIC': return '基础以上';
    case 'ANY_OF': return entry.accepted.join('/');
    case 'CORE_OR_TWO_ORG': return '核心，或 2 项组织资格';
  }
}

// 卡面某字段的真值；字段对该卡不存在（或 auditOrder 非 ADMIN）返回 undefined。
// RevealableField 枚举（§4.5）与规则书 §5.3 清单按语义对应：危机卡的「资金要求/能力要求」
// 即 fundsTarget/abilityTarget，映射到 minFunds/minAbility 揭示（issues #17）。
export function fieldValue(
  card: ProjectCard, auditOrders: AuditOrder[], targetRound: Round, field: RevealableField,
): string | number | undefined {
  switch (field) {
    case 'name': return card.name;
    case 'entry': return entryToString(card.entry);
    case 'minFunds': return card.minFunds ?? card.fundsTarget;
    case 'minAbility': return card.minAbility ?? card.abilityTarget;
    case 'reward': return card.reward;
    case 'risk': return card.risk;
    case 'slots': return card.slots;
    case 'auditOrder': return card.domain === 'ADMIN' ? auditOrders[targetRound - 1] : undefined;
  }
}

const ALL_FIELDS: RevealableField[] = ['name', 'entry', 'minFunds', 'minAbility', 'reward', 'risk', 'slots', 'auditOrder'];

export function useIntel(state: Game, seatId: SeatId, targetDomain: Domain): IntelResult {
  if (state.phase !== 'REVEAL_AND_INTEL') return { ok: false, reason: `阶段 ${state.phase} 不可使用情报权` };
  if (state.seats[seatId].intel < 1) return { ok: false, reason: '情报权次数不足' };
  if (state.round >= 6) return { ok: false, reason: '第 6 回合没有下一回合可侦知' };
  const targetRound = (state.round + 1) as Round;
  const card = state.decks[targetDomain][targetRound - 1]!;

  // 候选 = 该卡实际存在的可揭示字段 − 已向该玩家揭示过的字段（规则书 §5.3）
  const revealed = new Set(
    state.intelReveals
      .filter((r) => r.seatId === seatId && r.target.round === targetRound && r.target.domain === targetDomain)
      .map((r) => r.field));
  const candidates = ALL_FIELDS.filter((f) =>
    !revealed.has(f) && fieldValue(card, state.auditOrders, targetRound, f) !== undefined);
  if (candidates.length === 0) return { ok: false, reason: '该项目字段已全部向你揭示，情报权不消耗' };

  const s = structuredClone(state);
  // index 取全局揭示计数，保证同回合多次使用各自独立；抽取记录 HOST 可见
  // （RNG_DRAWN 若公开会缩小字段候选空间，泄漏未揭示信息）
  const idx = s.intelReveals.length;
  const pick = candidates[drawU32(s.seed, s.round, targetDomain, 'INTEL', idx) % candidates.length]!;
  const value = fieldValue(card, s.auditOrders, targetRound, pick)!;

  s.seats[seatId].intel -= 1;
  s.intelReveals.push({ seatId, round: s.round, target: { round: targetRound, domain: targetDomain }, field: pick, value });

  const events: GameEvent[] = [];
  emitEvent(s, events, 'RNG_DRAWN', 'HOST',
    { round: s.round, domain: targetDomain, purpose: 'INTEL', index: idx, value: pick }, s.round, s.phase);
  emitEvent(s, events, 'INTEL_USED', 'PUBLIC',
    { seatId, target: { round: targetRound, domain: targetDomain } }, s.round, s.phase);
  emitEvent(s, events, 'INTEL_REVEALED', 'SEAT',
    { seatId, target: { round: targetRound, domain: targetDomain }, field: pick, value }, s.round, s.phase);
  return { ok: true, state: s, events, field: pick, value };
}

// 终局验证（§5.8）：GAME_END 之后批量比对 INTEL_RELAY 的 claimedValue 与真值，
// 供【谣言制造者】【知识就是力量】自动判定与复盘。局中不揭示（保住撒谎玩法）。
export function verifyIntelClaims(state: Game): { state: Game; events: GameEvent[] } {
  if (state.phase !== 'GAME_END') throw new Error(`verifyIntelClaims：阶段 ${state.phase} 未到终局`);
  const s = structuredClone(state);
  const events: GameEvent[] = [];
  const alreadyVerified = new Set(
    s.events.filter((e) => e.type === 'INTEL_CLAIM_VERIFIED').map((e) => e.payload['contractId'] as string));
  for (const c of s.contracts) {
    if (c.tier !== 'MEMO' || c.kind !== 'INTEL_RELAY' || c.intelClaim === undefined) continue;
    if (alreadyVerified.has(c.contractId)) continue;
    const claim = c.intelClaim;
    const card = s.decks[claim.target.domain][claim.target.round - 1]!;
    const actual = fieldValue(card, s.auditOrders, claim.target.round, claim.field);
    const truthful = actual !== undefined && String(actual) === String(claim.claimedValue);
    // relayFrom（TDD-002 §9.1）在此处随核验结果一并公开：局中它属条款级私密，
    // 终局揭示真伪时「是谁说的」才有意义。
    emitEvent(s, events, 'INTEL_CLAIM_VERIFIED', 'PUBLIC', {
      contractId: c.contractId, parties: c.parties,
      relayFrom: c.relayFrom ?? null,
      target: claim.target, field: claim.field,
      claimedValue: claim.claimedValue, actualValue: actual ?? null, truthful,
    }, 6, 'GAME_END');
  }
  return { state: s, events };
}
