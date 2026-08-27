// 建局：发身份（规则书 §4 随机抽取）、洗五套项目牌堆（规则书 §8）、洗行政审查令（规则书 §14.1）。
// 全部随机性来自 seeded RNG（TDD-001 §6.5），开局公开 seedCommitment。
import type { Domain, Game, GameEvent, ProjectCard, SeatId, Seat } from './types.js';
import { IDENTITY_CARDS } from './data/identities.js';
import { WAR_PROJECTS } from './data/war-projects.js';
import { ENGINEERING_PROJECTS } from './data/engineering-projects.js';
import { COMMERCE_PROJECTS } from './data/commerce-projects.js';
import { ADMIN_PROJECTS } from './data/admin-projects.js';
import { CRISIS_PROJECTS } from './data/crisis-projects.js';
import { AUDIT_ORDER_DECK } from './data/audit-orders.js';
import { seedCommitment, shuffleInPlace, type ShuffleDraw } from './rng.js';
import { emitEvent } from './events.js';

const DECK_SOURCES: Record<Domain, readonly ProjectCard[]> = {
  WAR: WAR_PROJECTS,
  ENGINEERING: ENGINEERING_PROJECTS,
  COMMERCE: COMMERCE_PROJECTS,
  CRISIS: CRISIS_PROJECTS,
  ADMIN: ADMIN_PROJECTS,
};

const ALL_SEATS: readonly SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function initGame(gameId: string, seed: string): { state: Game; events: GameEvent[] } {
  const events: GameEvent[] = [];

  // 身份发牌：洗混身份卡，座位 k 拿第 k 张（洗牌发生在第 1 回合前，rng round = 0）
  const identityDeck = [...IDENTITY_CARDS];
  const identityDraws = shuffleInPlace(identityDeck, seed, 0, 'SETUP', 'IDENTITY_DRAW');

  const seats = {} as Record<SeatId, Seat>;
  for (const seatId of ALL_SEATS) {
    const card = identityDeck[seatId - 1]!;
    seats[seatId] = {
      seatId,
      identity: card.identity,
      funds: card.funds,
      lockedFunds: 0,
      abilityBase: card.ability,
      abilityCommitted: 0,
      intel: card.intel,
      qualifications: card.initialQualification === 'NONE'
        ? []
        : [{ kind: card.initialQualification, usedThisRound: false, acquiredRound: 0 }],
      records: [],
      stamps: [],
      defaults: [],
      connected: true,
    };
  }

  // 洗五套项目牌堆与审查令
  const decks = {} as Record<Domain, ProjectCard[]>;
  const deckDraws: { domain: string; draws: ShuffleDraw[] }[] = [{ domain: 'SETUP', draws: identityDraws }];
  for (const domain of Object.keys(DECK_SOURCES) as Domain[]) {
    const deck = [...DECK_SOURCES[domain]];
    deckDraws.push({ domain, draws: shuffleInPlace(deck, seed, 0, domain, 'DECK_SHUFFLE') });
    decks[domain] = deck;
  }
  const auditOrders = [...AUDIT_ORDER_DECK];
  deckDraws.push({ domain: 'ADMIN', draws: shuffleInPlace(auditOrders, seed, 0, 'ADMIN', 'AUDIT_SHUFFLE') });

  const state: Game = {
    gameId,
    seedCommitment: seedCommitment(seed),
    seed,
    round: 1,
    phase: 'ROUND_START',
    seats,
    decks,
    auditOrders,
    contracts: [],
    events: [],
    pendingQualifications: [],
    pendingPayouts: [],
    intelReveals: [],
    crisisPledges: [],
  };

  // 洗牌抽取记入事件日志（TDD-001 §6.5：记录每次 rng 调用）。
  // 可见性 HOST：初始牌序是公开数据，若这些抽取对玩家可见，任何人开局即可重放洗牌
  // 得到全部 30 张卡与 6 张审查令的顺序，情报权（规则书 §5.3）与审查令隐藏（§14.1）将失效。
  // 玩家的可验证性由 seedCommitment（开局公开）+ seed（终局公开，§6.5）保证。
  for (const { domain, draws } of deckDraws) {
    for (const d of draws) {
      emitEvent(state, events, 'RNG_DRAWN', 'HOST',
        { round: 0, domain, purpose: d.purpose, index: d.index, value: d.value }, 0, 'ROUND_START');
    }
  }

  return { state, events };
}
