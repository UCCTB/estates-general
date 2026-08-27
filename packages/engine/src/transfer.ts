// 玩家间转账（TDD-001 约束 2：即时、无条件、无手续费）。
// 冻结窗口（§3.2）：仅 REVEAL_AND_INTEL 与 NEGOTIATION 开放；
// ROUND_START / SUBMISSION / SETTLEMENT 冻结。
// TRANSFER 事件可见性：TDD 未标注；转账是双方行为，按 PARTIES 记录
// （资金流图 §8.2 为引擎/主持侧查询，不需要全体可见）。
import type { Game, GameEvent, SeatId } from './types.js';
import { emitEvent } from './events.js';

export type TransferResult =
  | { ok: true; state: Game; events: GameEvent[] }
  | { ok: false; reason: string };

export function transfer(state: Game, from: SeatId, to: SeatId, amount: number): TransferResult {
  if (state.phase !== 'REVEAL_AND_INTEL' && state.phase !== 'NEGOTIATION') {
    return { ok: false, reason: `阶段 ${state.phase} 转账冻结` };
  }
  if (from === to) return { ok: false, reason: '不能给自己转账' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: '金额须为正整数' };
  if (state.seats[from].funds < amount) return { ok: false, reason: `资金不足：持有 ${state.seats[from].funds}` };

  const s = structuredClone(state);
  s.seats[from].funds -= amount;
  s.seats[to].funds += amount;
  const events: GameEvent[] = [];
  emitEvent(s, events, 'TRANSFER', 'PARTIES', { from, to, amount }, s.round, s.phase);
  return { ok: true, state: s, events };
}
