// 按座位裁剪状态与事件（TDD-001 §8.1 可见性 / §5.1 契约条款私密）。
//
// 两条底线：
//   1. 玩家端拿到的任何字段，都必须是这名玩家在桌上本来就能看到的。
//   2. 主持端拿到全部（含 HOST 事件），但主持端不是玩家。
//
// 待裁定（docs/tdd-001-issues.md #22）：TDD-001 没有规定「其他玩家的余额是否公开」。
// 这里按线下桌游的实情处理——资金筹码摆在桌面上是看得见的，所以公开**持有总额**
// （funds + lockedFunds）；但不拆分「可用 / 已锁定」，否则等于提前泄漏本回合的提交额。
import type {
  Contract, Game, GameEvent, ProjectCard, SeatId,
} from '@estates/engine';

export interface PublicSeatView {
  seatId: SeatId;
  identity: string;
  holdings: number;               // funds + lockedFunds（不拆分，见文件头注释）
  abilityBase: number;
  intel: number;
  qualifications: { kind: string; usedThisRound: boolean; acquiredRound: number }[];
  records: number;
  stamps: number;
  defaults: Game['seats'][1]['defaults'];
  connected: boolean;
}

export interface ContractView {
  contractId: string;
  tier: string;
  parties: [SeatId, SeatId];
  status: string;
  registeredRound: number;
  /** 只有当事人与见证人拿得到条款（§5.1） */
  terms: Contract | null;
}

const ALL_SEATS: readonly SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function publicSeat(state: Game, seatId: SeatId): PublicSeatView {
  const s = state.seats[seatId];
  return {
    seatId,
    identity: s.identity,
    holdings: s.funds + s.lockedFunds,
    abilityBase: s.abilityBase,
    intel: s.intel,
    qualifications: s.qualifications.map((q) => ({ ...q })),
    records: s.records.length,
    stamps: s.stamps.length,
    defaults: s.defaults.map((d) => ({ ...d })),   // 失信记录全部字段公开（§5.5）
    connected: s.connected,
  };
}

/** 本回合公开的 5 张项目卡。行政审查令申请时隐藏、结算时公开（规则书 §14.1）。 */
export function visibleCards(state: Game): { cards: Record<string, ProjectCard>; auditOrder: string | null } {
  const r = state.round - 1;
  const cards: Record<string, ProjectCard> = {};
  for (const d of ['WAR', 'ENGINEERING', 'COMMERCE', 'ADMIN', 'CRISIS'] as const) {
    cards[d] = state.decks[d][r]!;
  }
  const revealed = state.phase === 'SETTLEMENT' || state.phase === 'GAME_END';
  return { cards, auditOrder: revealed ? state.auditOrders[r]! : null };
}

function partiesOf(state: Game, e: GameEvent): SeatId[] {
  const p = e.payload;
  const out: SeatId[] = [];
  const take = (v: unknown) => { if (typeof v === 'number') out.push(v as SeatId); };
  take(p['from']); take(p['to']); take(p['payer']); take(p['payee']); take(p['by']); take(p['seatId']);
  if (Array.isArray(p['parties'])) for (const v of p['parties'] as unknown[]) take(v);
  const cid = p['contractId'];
  if (typeof cid === 'string') {
    const c = state.contracts.find((x) => x.contractId === cid);
    if (c !== undefined) {
      out.push(...c.parties);
      out.push(...c.witnesses);   // 见证人看得到条款（§5.1）
    }
  }
  return out;
}

export function eventVisibleTo(state: Game, e: GameEvent, seatId: SeatId | 'HOST'): boolean {
  if (seatId === 'HOST') return true;
  switch (e.visibility) {
    case 'PUBLIC': return true;
    case 'HOST': return false;
    case 'SEAT': return e.payload['seatId'] === seatId;
    case 'PARTIES': return partiesOf(state, e).includes(seatId);
  }
}

export function visibleEvents(state: Game, seatId: SeatId | 'HOST', sinceSeq = -1): GameEvent[] {
  return state.events.filter((e) => e.seq > sinceSeq && eventVisibleTo(state, e, seatId));
}

export function contractViews(state: Game, seatId: SeatId | 'HOST'): ContractView[] {
  return state.contracts.map((c) => {
    const insider = seatId === 'HOST' || c.parties.includes(seatId) || c.witnesses.includes(seatId);
    return {
      contractId: c.contractId,
      tier: c.tier,
      parties: c.parties,
      status: c.status,
      registeredRound: c.registeredRound,
      terms: insider ? c : null,
    };
  });
}

export interface SeatSnapshot {
  gameId: string;
  round: number;
  phase: string;
  seedCommitment: string;
  /** 终局才公开（§6.5），此前为 null */
  seed: string | null;
  you: Game['seats'][1] | null;
  seats: PublicSeatView[];
  cards: Record<string, ProjectCard>;
  auditOrder: string | null;
  contracts: ContractView[];
  /** 只有自己的情报揭示（SEAT 可见） */
  intelReveals: Game['intelReveals'];
  /** 本回合的公开承诺（TDD-002 §9.2，PUBLIC） */
  pledges: Game['crisisPledges'];
  events: GameEvent[];
  pendingPayouts: Game['pendingPayouts'];
}

export function snapshotFor(state: Game, seatId: SeatId | 'HOST'): SeatSnapshot {
  const { cards, auditOrder } = visibleCards(state);
  return {
    gameId: state.gameId,
    round: state.round,
    phase: state.phase,
    seedCommitment: state.seedCommitment,
    seed: state.phase === 'GAME_END' ? state.seed : null,
    you: seatId === 'HOST' ? null : structuredClone(state.seats[seatId]),
    seats: ALL_SEATS.map((k) => publicSeat(state, k)),
    cards,
    auditOrder,
    contracts: contractViews(state, seatId),
    intelReveals: seatId === 'HOST'
      ? structuredClone(state.intelReveals)
      : state.intelReveals.filter((r) => r.seatId === seatId).map((r) => ({ ...r })),
    pledges: state.crisisPledges.filter((p) => p.round === state.round).map((p) => ({ ...p })),
    events: visibleEvents(state, seatId),
    pendingPayouts: seatId === 'HOST'
      ? structuredClone(state.pendingPayouts)
      : state.pendingPayouts.filter((p) => p.seatId === seatId).map((p) => ({ ...p })),
  };
}
