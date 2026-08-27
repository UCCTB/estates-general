// 终局判定（规则书 §2 / §15.1）：过线三条件、危机印章计入上限、四级排名链、前 6 截断、抽签记录。
import { describe, expect, it } from 'vitest';
import type { Game, Qualification, SeatId, Stamp } from '../src/types.js';
import { finalStanding } from '../src/finalStanding.js';
import { freshState } from './helpers.js';

function endedState(): Game {
  const s = freshState('test-seed');
  s.phase = 'GAME_END';
  // 清空身份带来的初始资源，逐座位精确构造
  for (const k of Object.keys(s.seats).map(Number) as SeatId[]) {
    const seat = s.seats[k];
    seat.funds = 0;
    seat.qualifications = [];
    seat.stamps = [];
    seat.records = [];
  }
  return s;
}

function outfit(s: Game, seatId: SeatId, funds: number, qual: Qualification | null, stamps: Stamp[], records = 0): void {
  const seat = s.seats[seatId];
  seat.funds = funds;
  if (qual !== null && qual !== 'NONE') seat.qualifications = [{ kind: qual, usedThisRound: false, acquiredRound: 0 }];
  seat.stamps = stamps;
  for (let i = 0; i < records; i++) seat.records.push({ round: 1, domain: 'WAR' });
}

const S2 = (a: Stamp['source'], b: Stamp['source']): Stamp[] => [{ round: 1, source: a }, { round: 2, source: b }];

describe('finalStanding（规则书 §2）', () => {
  it('未到终局抛错', () => {
    const s = freshState('test-seed');
    expect(() => finalStanding(s)).toThrow('未到终局');
  });

  it('过线三条件逐一否决；危机印章整场只计 1 枚（§15.1）', () => {
    const s = endedState();
    outfit(s, 1, 50, 'BASIC', S2('WAR', 'WAR'));            // 全满足 → 过线
    outfit(s, 2, 49, 'BASIC', S2('WAR', 'WAR'));            // 资金差 1 → 否
    outfit(s, 3, 100, null, S2('WAR', 'WAR'));              // 无资格 → 否
    outfit(s, 4, 100, 'BASIC', S2('CRISIS', 'CRISIS'));     // 两枚危机印章只计 1 → 否
    outfit(s, 5, 100, 'BASIC', S2('CRISIS', 'ENGINEERING'));// 危机 1 + 普通 1 = 2 → 过线
    const { rows, passCount } = finalStanding(s);
    const row = (k: SeatId) => rows.find((r) => r.seatId === k)!;
    expect(row(1).qualified).toBe(true);
    expect(row(2).qualified).toBe(false);
    expect(row(3).qualified).toBe(false);
    expect(row(4).qualified).toBe(false);
    expect(row(4).stampsEffective).toBe(1);
    expect(row(5).qualified).toBe(true);
    expect(passCount).toBe(2);
  });

  it('排名链：资金 → 记录 → 资格等级；前 6 截断（过线仍淘汰）；抽签记 RNG_DRAWN', () => {
    const s = endedState();
    outfit(s, 1, 50, 'BASIC', S2('WAR', 'WAR'));                   // 最末
    outfit(s, 5, 100, 'BASIC', S2('WAR', 'WAR'), 0);               // 100 资金组：记录 0
    outfit(s, 6, 100, 'CORE', S2('WAR', 'WAR'), 2);                // 100 资金组：记录 2，核心
    outfit(s, 7, 100, 'BASIC', S2('WAR', 'WAR'), 2);               // 100 资金组：记录 2，基础
    outfit(s, 8, 90, 'BASIC', S2('WAR', 'WAR'));
    outfit(s, 9, 80, 'BASIC', S2('WAR', 'WAR'));
    outfit(s, 10, 70, 'BASIC', S2('WAR', 'WAR'));
    const { rows, events, passCount } = finalStanding(s);
    const row = (k: SeatId) => rows.find((r) => r.seatId === k)!;
    expect(passCount).toBe(7);
    // 100 资金组内：记录 2 者在前；同记录比资格等级（核心 > 基础）
    expect(row(6).rank).toBe(1);
    expect(row(7).rank).toBe(2);
    expect(row(5).rank).toBe(3);
    expect(row(8).rank).toBe(4);
    expect(row(9).rank).toBe(5);
    expect(row(10).rank).toBe(6);
    // 第 7 名：过线仍淘汰（规则书 §2）
    expect(row(1).rank).toBe(7);
    expect(row(1).qualified).toBe(true);
    expect(row(1).winner).toBe(false);
    expect(row(10).winner).toBe(true);
    // 平局抽签 key 逐个记入事件日志（TDD-001 §6.5）。
    // TDD-002 §9.3 CR-3：key 覆盖全部 12 席（index = seatId − 1），
    // 因此不随过线人数变化，重放同一 seed 必得同一结果。
    expect(events.filter((e) => e.type === 'RNG_DRAWN' && e.payload['purpose'] === 'FINAL_RANK')).toHaveLength(12);
    // overallRank 全席唯一，过线者在前
    const ranks = rows.map((r) => r.overallRank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const r of rows) {
      if (r.qualified) expect(r.overallRank).toBe(r.rank);
      else expect(r.overallRank).toBeGreaterThan(passCount);
    }
  });

  it('完全平局由 seed 派生抽签决定，且结果确定', () => {
    const s = endedState();
    outfit(s, 3, 60, 'BASIC', S2('WAR', 'WAR'), 1);
    outfit(s, 4, 60, 'BASIC', S2('WAR', 'WAR'), 1);
    const a = finalStanding(s);
    const b = finalStanding(s);
    expect(a.rows.find((r) => r.seatId === 3)!.rank).not.toBeNull();
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    const ranks = [3, 4].map((k) => a.rows.find((r) => r.seatId === k as SeatId)!.rank);
    expect([...ranks].sort()).toEqual([1, 2]);
  });
});
