// 每回合结算事实的审计记录（TDD-002 §5 / §6 的查询基础）。
//
// 为什么需要它：自动档与提名档的判定要看「所有申报队伍的名单与各自投入」「行政申请者
// 与其声明使用的资格」「每人本回合投入了多少能力、拿到了多少项目收益」。这些在
// TDD-001 §8.1 现有的 PUBLIC 事件里都取不到——PROJECT_RESOLVED 只公开中标队。
//
// 处理方式：在 SETTLEMENT 步骤 11 追加一条 `PROJECT_RESOLVED` / visibility = HOST 的
// 汇总事件（payload.detail = 'ROUND_FACTS'）。选择 HOST 而不是 PUBLIC，是因为落选队伍
// 各成员的具体出资额、行政申请者的具体能力投入，规则书没有规定要向全体公开；
// TDD-001 §8.2 也把三张图定位为「引擎 / 主持侧查询」。事件类型沿用 §8.1 的既有枚举，
// 不新增类型。此项已记入 docs/tdd-001-issues.md #20，待人工确认。
import type { Domain, Game, GameEvent, Qualification, Round, SeatId } from './types.js';

export type TeamDomain = 'ENGINEERING' | 'WAR' | 'COMMERCE';
export type ProjectDomain = Exclude<Domain, 'CRISIS'>;

export interface FactsContribution {
  seatId: SeatId;
  funds: number;
  ability: number;
  qualificationUsed?: Qualification;
}

export interface FactsTeam {
  teamId: string;
  members: SeatId[];
  formed: boolean;
  legal: boolean;                 // 通过本领域全部过滤条件
  payee: SeatId | null;
  bid: number | null;
  contributions: FactsContribution[];
}

export interface FactsApplicant {
  seatId: SeatId;
  ability: number;
  qualificationUsed?: Qualification;
  eligible: boolean;
}

export interface RoundFacts {
  round: Round;
  teams: Record<TeamDomain, FactsTeam[]>;
  winnerTeamId: Record<TeamDomain, string | null>;
  winnerMembers: Record<TeamDomain, SeatId[]>;
  projectResult: Record<ProjectDomain, 'SUCCESS' | 'FAIL' | 'NO_AWARD'>;
  /** 各领域项目卡准入的规范串（'无' / '基础以上' / 'ADMIN/CORE' …），供【入口垄断】判定 */
  entryLabel: Record<ProjectDomain, string>;
  admin: { applicants: FactsApplicant[]; selected: SeatId[] };
  crisis: {
    result: 'SUCCESS' | 'FAIL';
    contributions: Record<string, { funds: number; ability: number }>;
    fundsTarget: number;
    abilityTarget: number;
  };
  /** 本回合各座位投入的总能力（结算后才公开，避免提交阶段泄漏） */
  abilityCommitted: Record<string, number>;
  /** 本回合归属各座位的项目收益：在途中标收益按 payee 计 + 行政报酬 + 落选返还 */
  gains: Record<string, number>;
  /** 承诺汇总（TDD-002 §9.2 CR-2） */
  pledges: { count: number; funds: number; ability: number };
  seq: number;                    // 该事件在日志中的 seq，作为 evidence 引用
}

const FACTS_MARK = 'ROUND_FACTS';

export function isRoundFactsEvent(e: GameEvent): boolean {
  return e.type === 'PROJECT_RESOLVED' && e.visibility === 'HOST' && e.payload['detail'] === FACTS_MARK;
}

export function emitRoundFacts(s: Game, out: GameEvent[], facts: Omit<RoundFacts, 'seq'>): void {
  const e: GameEvent = {
    seq: s.events.length,
    round: facts.round,
    phase: 'SETTLEMENT',
    type: 'PROJECT_RESOLVED',
    visibility: 'HOST',
    payload: { detail: FACTS_MARK, ...(JSON.parse(JSON.stringify(facts)) as Record<string, unknown>) },
  };
  s.events.push(e);
  out.push(e);
}

/** 从事件日志还原全部回合的结算事实，按回合升序。 */
export function readRoundFacts(state: Game): RoundFacts[] {
  const out: RoundFacts[] = [];
  for (const e of state.events) {
    if (!isRoundFactsEvent(e)) continue;
    const { detail: _detail, ...rest } = e.payload as Record<string, unknown>;
    out.push({ ...(rest as unknown as Omit<RoundFacts, 'seq'>), seq: e.seq });
  }
  return out.sort((a, b) => a.round - b.round);
}
