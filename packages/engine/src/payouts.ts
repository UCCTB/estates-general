// 在途收益到账（2026-08-27 裁定，issues #12）：
// 中标收益在中标的下一回合开始时全额打给队伍指定的收款人（payee）；
// 第 6 回合中标则在终局（GAME_END 前）即时到账。队内分配走自由转账，引擎不介入。
import type { Game, GameEvent, Phase, Round } from './types.js';
import { emitEvent } from './events.js';

export function flushPendingPayouts(s: Game, out: GameEvent[], round: Round, phase: Phase): void {
  for (const p of s.pendingPayouts) {
    s.seats[p.seatId].funds += p.amount;
    emitEvent(s, out, 'PAYOUT', 'PUBLIC',
      { kind: 'REWARD', seatId: p.seatId, amount: p.amount, source: p.source, awardedRound: p.awardedRound },
      round, phase);
  }
  s.pendingPayouts = [];
}
