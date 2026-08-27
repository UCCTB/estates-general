// 终局判定（规则书 §2 胜利条件）。终局叙事（时代/政体/后记查表）见 ending.ts（TDD-002）。
// 过线：资金 ≥ 50、至少 1 项有效资格、至少 2 枚履历印章（公共危机来源印章整场最多 1 枚计入，规则书 §15.1）。
// 排名：最终资金 → 普通项目成功总次数 → 资格等级 → 抽签。前 6 名胜出。
// 平局抽签的每次 rng 调用记入事件日志（TDD-001 §6.5）；GAME_END 后 seed 已公开，事件 PUBLIC。
import type { Game, GameEvent, Identity, Qualification, SeatId } from './types.js';
import { drawU32 } from './rng.js';
import { qualificationLevel } from './qualification.js';
import { emitEvent } from './events.js';

export interface StandingRow {
  seatId: SeatId;
  identity: Identity;
  funds: number;
  stampsTotal: number;
  stampsEffective: number;      // 危机印章计数上限 1 之后的数量
  recordsTotal: number;
  highestQualification: Qualification;
  qualified: boolean;           // 过线
  rank: number | null;          // 过线者名次（1 起）；未过线为 null
  winner: boolean;              // 最终前 6 名
  // TDD-002 §9.3 CR-3：全席唯一名次（1..12）。过线者在前，未过线者一律在后，
  // 未过线者内部用同一套排序键。【身份不是命运】需要跨过线线比较排名。
  overallRank: number;
}

export function finalStanding(state: Game): {
  state: Game; events: GameEvent[]; rows: StandingRow[]; passCount: number;
} {
  if (state.phase !== 'GAME_END') throw new Error(`finalStanding：阶段 ${state.phase} 未到终局`);
  const s = structuredClone(state);
  const events: GameEvent[] = [];

  const seatIds = (Object.keys(s.seats).map(Number) as SeatId[]).sort((a, b) => a - b);
  const rows: StandingRow[] = seatIds.map((seatId) => {
    const seat = s.seats[seatId];
    const crisisStamps = seat.stamps.filter((st) => st.source === 'CRISIS').length;
    const stampsEffective = seat.stamps.length - crisisStamps + Math.min(1, crisisStamps);
    const highestQualification = seat.qualifications.reduce<Qualification>(
      (best, q) => (qualificationLevel(q.kind) > qualificationLevel(best) ? q.kind : best), 'NONE');
    return {
      seatId,
      identity: seat.identity,
      funds: seat.funds,
      stampsTotal: seat.stamps.length,
      stampsEffective,
      recordsTotal: seat.records.length,
      highestQualification,
      qualified: seat.funds >= 50 && seat.qualifications.length >= 1 && stampsEffective >= 2,
      rank: null,
      winner: false,
      overallRank: 0,
    };
  });

  // 抽签 key 覆盖全部 12 席（TDD-002 §9.3）：index 固定为 seatId − 1，
  // 因此 key 不随过线人数变化，重放同一 seed 必得同一结果。
  const keys = new Map<SeatId, number>();
  rows.forEach((r) => {
    const idx = r.seatId - 1;
    const v = drawU32(s.seed, 6, 'SETUP', 'FINAL_RANK', idx);
    keys.set(r.seatId, v);
    emitEvent(s, events, 'RNG_DRAWN', 'PUBLIC',
      { round: 6, domain: 'SETUP', purpose: 'FINAL_RANK', index: idx, value: v }, 6, 'GAME_END');
  });

  const byMerit = (a: StandingRow, b: StandingRow): number =>
    (b.funds - a.funds)
    || (b.recordsTotal - a.recordsTotal)
    || (qualificationLevel(b.highestQualification) - qualificationLevel(a.highestQualification))
    || ((keys.get(a.seatId) ?? 0) - (keys.get(b.seatId) ?? 0));

  const qualifiedRows = rows.filter((r) => r.qualified).sort(byMerit);
  qualifiedRows.forEach((r, i) => {
    r.rank = i + 1;
    r.winner = i < 6;
    r.overallRank = i + 1;
  });

  // 未过线者排在全部过线者之后，内部用同一套排序键
  rows.filter((r) => !r.qualified).sort(byMerit).forEach((r, i) => {
    r.overallRank = qualifiedRows.length + i + 1;
  });

  return { state: s, events, rows, passCount: qualifiedRows.length };
}
