// 座位令牌（TDD-001 §7）。
//   token     = base64url( gameId ‖ seatId ‖ nonce(128 bit) )
//   signature = HMAC-SHA256(serverSecret, token)
//   magicLink = https://<host>/join/<token>.<signature>
// 令牌绑定 (gameId, seatId)，不绑定人：局内一切状态挂在 Game.seats[seatId] 上，
// 令牌只是打开座位的钥匙。有效期 = 建局时间 + 6 小时（TODO(TDD-001 C.3)：待验证）。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SeatId } from '@estates/engine';

export const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;   // TODO(TDD-001 C.3)

export interface TokenPayload { gameId: string; seatId: SeatId | 0; nonce: string; issuedAt: number; }

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function newNonce(): string {
  return b64url(randomBytes(16));   // 128 bit
}

/** seatId = 0 表示主持端令牌（牵头玩家自己另有座位 1 的玩家令牌）。 */
export function mintToken(secret: string, p: TokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(p), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(secret: string, raw: string, now: number): TokenPayload | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const expect = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let p: TokenPayload;
  try {
    p = JSON.parse(fromB64url(body).toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof p.gameId !== 'string' || typeof p.nonce !== 'string' || typeof p.issuedAt !== 'number') return null;
  if (now - p.issuedAt > TOKEN_TTL_MS) return null;   // §7.1 到期自动失效
  return p;
}
