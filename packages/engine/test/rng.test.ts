// SHA-256 / HMAC-SHA256 已知向量（NIST FIPS 180-4 示例、RFC 4231）与 RNG 派生性质。
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256Hex } from '../src/sha256.js';
import { drawInt, drawU32, seedCommitment, shuffleInPlace } from '../src/rng.js';

describe('sha256', () => {
  it('空串', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('abc', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('两块消息', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
  it('长度恰跨填充边界（55/56/64 字节）', () => {
    // 与 Node crypto 预先计算的参考值一致
    expect(sha256Hex('a'.repeat(55))).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318');
    expect(sha256Hex('a'.repeat(56))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a');
    expect(sha256Hex('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
  });
});

describe('hmac-sha256', () => {
  it('RFC 4231 Test Case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('经典向量：key 与消息', () => {
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
  it('超过 64 字节的 key 先做哈希（RFC 4231 Test Case 6）', () => {
    const key = new Uint8Array(131).fill(0xaa);
    expect(hmacSha256Hex(key, 'Test Using Larger Than Block-Size Key - Hash Key First'))
      .toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });
});

describe('rng（TDD-001 §6.5）', () => {
  it('seedCommitment = sha256(seed)', () => {
    expect(seedCommitment('demo')).toBe(sha256Hex('demo'));
  });
  it('同参数确定；不同参数（round/domain/purpose/index）各自独立', () => {
    const a = drawU32('s', 1, 'WAR', 'WAR', 0);
    expect(drawU32('s', 1, 'WAR', 'WAR', 0)).toBe(a);
    expect(drawU32('s', 2, 'WAR', 'WAR', 0)).not.toBe(a);
    expect(drawU32('s', 1, 'COMMERCE', 'WAR', 0)).not.toBe(a);
    expect(drawU32('s', 1, 'WAR', 'ENG', 0)).not.toBe(a);
    expect(drawU32('s', 1, 'WAR', 'WAR', 1)).not.toBe(a);
  });
  it('drawInt 落在闭区间', () => {
    for (let i = 0; i < 200; i++) {
      const d = drawInt('seed', 3, 'COMMERCE', 'COM_DICE', i, 1, 6);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(6);
    }
  });
  it('洗牌确定且为置换', () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [1, 2, 3, 4, 5, 6];
    shuffleInPlace(a, 'x', 0, 'WAR', 'DECK_SHUFFLE');
    shuffleInPlace(b, 'x', 0, 'WAR', 'DECK_SHUFFLE');
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
