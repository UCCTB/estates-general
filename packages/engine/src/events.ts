// 事件发射辅助。所有状态变化以 append-only 事件表达（TDD-001 §8.1）。
// seq 取 state.events.length，保证全局单调；事件同时进入 state.events 与本次调用的返回列表。
import type { EventType, Game, GameEvent, Phase, Round, Visibility } from './types.js';

export function emitEvent(
  s: Game,
  out: GameEvent[],
  type: EventType,
  visibility: Visibility,
  payload: Record<string, unknown>,
  round: Round | 0,
  phase: Phase,
): GameEvent {
  const e: GameEvent = { seq: s.events.length, round, phase, type, visibility, payload };
  s.events.push(e);
  out.push(e);
  return e;
}
