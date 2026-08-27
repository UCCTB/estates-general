// TDD-001 §6.4 ROUND_START 程序。纯函数：roundStart(state) → { state, events }。
// a  执行 pendingQualifications；所有 qualifications.usedThisRound = false；abilityCommitted = 0
// b  回合开始类契约判定（ROUND_START / QUALIFICATION_GAINED）——阶段 2，留空桩
// c  公开本回合 5 张项目卡；进入 REVEAL_AND_INTEL
import type { Game, GameEvent, SeatId } from './types.js';
import { emitEvent } from './events.js';
import { flushPendingPayouts } from './payouts.js';
import { stepBRoundStartContracts } from './contracts.js';

export function roundStart(state: Game): { state: Game; events: GameEvent[] } {
  if (state.phase !== 'ROUND_START') throw new Error(`roundStart：阶段 ${state.phase} 不可开始回合`);
  const s = structuredClone(state);
  const events: GameEvent[] = [];

  // 步骤 a（前置）：上回合中标收益到账（2026-08-27 裁定，issues #12：
  // 收益在下一回合开始时全额打给队伍指定的收款人，队内分配走本回合的自由转账）
  flushPendingPayouts(s, events, s.round, 'ROUND_START');

  // 步骤 a：执行晋升队列；重置资格使用与能力投入（能力恢复至身份卡基础值，规则书 §5.2）
  for (const p of s.pendingQualifications) {
    const seat = s.seats[p.seatId];
    if (!p.viaPurchase) {
      // 晋升：基础资格升级为专业 / 行政 / 组织资格（规则书 §7.2–7.4），替换原基础资格
      seat.qualifications = seat.qualifications.filter((q) => q.kind !== 'BASIC');
    }
    seat.qualifications.push({ kind: p.kind, usedThisRound: false, acquiredRound: s.round });
    emitEvent(s, events, 'QUALIFICATION_APPLIED', 'PUBLIC',
      { seatId: p.seatId, kind: p.kind, viaPurchase: p.viaPurchase }, s.round, 'ROUND_START');
  }
  s.pendingQualifications = [];

  for (const seatId of Object.keys(s.seats).map(Number) as SeatId[]) {
    const seat = s.seats[seatId];
    for (const q of seat.qualifications) q.usedThisRound = false;
    seat.abilityCommitted = 0;
  }

  // 步骤 b：回合开始类契约判定（TDD-001 §6.4 b / §5.2 ROUND_START / QUALIFICATION_GAINED，
  // 按 registeredAt 升序执行；托管转入 payee；byRound / expiresRound 到期未触发 → VOID）。
  // 在步骤 a 之后：本回合刚生效的资格能触发 QUALIFICATION_GAINED；
  // 在收益到账之后：上回合中标收益可用于偿付本回合到期的契约（「以未来收益为偿付来源」）。
  stepBRoundStartContracts(s, events, s.round);

  // 步骤 c：公开本回合 5 张项目卡（卡面即 decks[domain][round-1]，以状态呈现；
  // §8.1 无对应事件类型，不发事件），进入 REVEAL_AND_INTEL
  s.phase = 'REVEAL_AND_INTEL';

  return { state: s, events };
}
