// TDD-001 §6.5 seeded RNG。
// rng(purpose, index) = HMAC-SHA256(seed, `${round}:${domain}:${purpose}:${index}`) → 映射到所需范围。
// seedCommitment = sha256(seed) 开局公开；seed 终局公开，玩家可事后验证每一次掷骰与抽签。
import { hmacSha256Bytes, sha256Hex } from './sha256.js';

export function seedCommitment(seed: string): string {
  return sha256Hex(seed);
}

// 取 HMAC 前 4 字节为 uint32。范围映射用取模（TDD 未规定映射方式；模偏差 < 2^-24，可审计性优先）。
export function drawU32(seed: string, round: number, domain: string, purpose: string, index: number): number {
  const mac = hmacSha256Bytes(seed, `${round}:${domain}:${purpose}:${index}`);
  return ((mac[0]! << 24) | (mac[1]! << 16) | (mac[2]! << 8) | mac[3]!) >>> 0;
}

// 闭区间 [lo, hi] 上的整数
export function drawInt(
  seed: string, round: number, domain: string, purpose: string, index: number,
  lo: number, hi: number,
): number {
  const span = hi - lo + 1;
  return lo + (drawU32(seed, round, domain, purpose, index) % span);
}

// 就地 Fisher-Yates 洗牌；每次交换消耗一个 index。返回消耗的抽取记录（供事件日志）。
export interface ShuffleDraw { purpose: string; index: number; value: number; }

export function shuffleInPlace<T>(
  arr: T[], seed: string, round: number, domain: string, purpose: string,
): ShuffleDraw[] {
  const draws: ShuffleDraw[] = [];
  for (let i = arr.length - 1, idx = 0; i > 0; i--, idx++) {
    const j = drawInt(seed, round, domain, purpose, idx, 0, i);
    draws.push({ purpose, index: idx, value: j });
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return draws;
}
