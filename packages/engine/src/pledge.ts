// 公共危机的公开承诺（TDD-002 §9.2 CR-2）。
//
// 引擎不读谈话（TDD-001 约束 1），因此规则书 §15「玩家可在自由磋商阶段自由承诺」
// 这句话，对系统而言只有走结构化渠道才存在。【公地悲剧】要比较「公开承诺的资源总量」
// 与危机目标，【共同体】要比较「约定总量」与实际提交——没有这个渠道，两条成就无法判定。
//
// 承诺**不产生任何资源后果**：不扣款、不锁定、不强制执行。它只是一句被记录下来的话，
// 兑不兑现是信用问题（规则书 §5.5）。这与失信记录的分工一致：引擎记录事实，玩家做判断。
import type { Game, GameEvent, SeatId } from './types.js';
import { emitEvent } from './events.js';

export type PledgeResult =
  | { ok: true; state: Game; events: GameEvent[] }
  | { ok: false; reason: string };

export function pledgeCrisis(state: Game, seatId: SeatId, funds: number, ability: number): PledgeResult {
  if (state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${state.phase} 不可登记承诺` };
  if (!Number.isInteger(funds) || funds < 0) return { ok: false, reason: '承诺资金须为非负整数' };
  if (!Number.isInteger(ability) || ability < 0) return { ok: false, reason: '承诺能力须为非负整数' };
  // 承诺可以超过当前持有量——吹牛也是一种可观测的行为，引擎不替玩家把关。
  // 只挡住明显越界的能力承诺（超过身份卡基础值就不可能兑现，属输入错误而非策略）。
  if (ability > state.seats[seatId].abilityBase) {
    return { ok: false, reason: `承诺能力 ${ability} 超过基础能力 ${state.seats[seatId].abilityBase}` };
  }

  const s = structuredClone(state);
  // 每 (seatId, round) 至多一条，后登记覆盖前一条
  s.crisisPledges = s.crisisPledges.filter((p) => !(p.seatId === seatId && p.round === s.round));
  s.crisisPledges.push({ seatId, round: s.round, funds, ability });

  const events: GameEvent[] = [];
  // 可见性 PUBLIC：承诺的全部意义就在于公开（不公开的承诺对成就判定与他人决策都无价值）
  emitEvent(s, events, 'CRISIS_PLEDGED', 'PUBLIC', { seatId, funds, ability }, s.round, s.phase);
  return { ok: true, state: s, events };
}

// 某回合的承诺汇总（供 achievements.ts 与玩家端展示）
export function pledgeTotals(state: Game, round: number): { funds: number; ability: number; count: number } {
  const rows = state.crisisPledges.filter((p) => p.round === round);
  return {
    funds: rows.reduce((a, p) => a + p.funds, 0),
    ability: rows.reduce((a, p) => a + p.ability, 0),
    count: rows.length,
  };
}
