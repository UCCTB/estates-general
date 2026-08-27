// 阶段推进辅助（TDD-001 §3.2）。阶段计时与广播属 Game Server；
// 引擎只提供合法的状态迁移：REVEAL_AND_INTEL → NEGOTIATION（契约登记窗口开启）。
// SUBMISSION 由 lockSubmissions 进入，SETTLEMENT/ROUND_START/GAME_END 由 settle 推进。
import type { Game } from './types.js';

export function beginNegotiation(state: Game): Game {
  if (state.phase !== 'REVEAL_AND_INTEL') {
    throw new Error(`beginNegotiation：阶段 ${state.phase} 不可进入谈判`);
  }
  const s = structuredClone(state);
  s.phase = 'NEGOTIATION';
  return s;
}
