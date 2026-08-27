// 测试辅助：建局、按身份找座位、把指定卡换到当前回合位。
import type { Domain, Game, Identity, SeatId } from '../src/types.js';
import { initGame } from '../src/init.js';
import { roundStart } from '../src/roundStart.js';

export function freshState(seed = 'test-seed'): Game {
  return initGame('test-game', seed).state;
}

// 建局并进入第 1 回合的可提交状态
export function readyState(seed = 'test-seed'): Game {
  return roundStart(freshState(seed)).state;
}

export function seatByIdentity(state: Game, identity: Identity): SeatId {
  for (const k of Object.keys(state.seats).map(Number) as SeatId[]) {
    if (state.seats[k].identity === identity) return k;
  }
  throw new Error(`身份不存在：${identity}`);
}

// 把 cardId 指定的卡交换到 decks[domain][state.round - 1]（测试用；state 为纯数据可直接改）
export function setRoundCard(state: Game, domain: Domain, cardId: string): void {
  const deck = state.decks[domain];
  const idx = deck.findIndex((c) => c.cardId === cardId);
  if (idx < 0) throw new Error(`卡不存在：${cardId}`);
  const cur = state.round - 1;
  const tmp = deck[cur]!;
  deck[cur] = deck[idx]!;
  deck[idx] = tmp;
}

export function sumFunds(state: Game): number {
  return (Object.keys(state.seats).map(Number) as SeatId[])
    .reduce((a, k) => a + state.seats[k].funds + state.seats[k].lockedFunds, 0);
}
