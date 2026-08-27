// 座位令牌（TDD-001 §7）。
//   token     = base64url( gameId ‖ seatId ‖ nonce(128 bit) )
//   signature = HMAC-SHA256(serverSecret, token)
//   magicLink = https://<host>/join/<token>.<signature>
// 令牌绑定 (gameId, seatId)，不绑定人：局内一切状态挂在 Game.seats[seatId] 上，
// 令牌只是打开座位的钥匙。有效期 = 建局时间 + 6 小时（TODO(TDD-001 C.3)：待验证）。
//
// HMAC 用 engine 里那份纯 TypeScript 实现（sha256.ts），不用 node:crypto——
// 这样同一份令牌代码在 Node 与浏览器里逐字节同结果，浏览器沙盒才跑得起同一个 router。
import { hmacSha256Bytes, type SeatId } from '@estates/engine';

export const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;   // TODO(TDD-001 C.3)

export interface TokenPayload { gameId: string; seatId: SeatId | 0; nonce: string; issuedAt: number; }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += B64[c & 63]!;
  }
  return out;
}

function fromB64url(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

/** 常量时间比较，避免用签名比对的耗时反推出正确签名（替代 node:crypto 的 timingSafeEqual）。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newNonce(): string {
  const buf = new Uint8Array(16);   // 128 bit
  globalThis.crypto.getRandomValues(buf);
  return b64url(buf);
}

/** seatId = 0 表示主持端令牌（牵头玩家自己另有座位 1 的玩家令牌）。 */
export function mintToken(secret: string, p: TokenPayload): string {
  const body = b64url(new TextEncoder().encode(JSON.stringify(p)));
  return `${body}.${b64url(hmacSha256Bytes(secret, body))}`;
}

export function verifyToken(secret: string, raw: string, now: number): TokenPayload | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot), sig = raw.slice(dot + 1);
  if (!constantTimeEqual(sig, b64url(hmacSha256Bytes(secret, body)))) return null;
  let p: TokenPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof p.gameId !== 'string' || typeof p.nonce !== 'string' || typeof p.issuedAt !== 'number') return null;
  if (now - p.issuedAt > TOKEN_TTL_MS) return null;   // §7.1 到期自动失效
  return p;
}
