// 回放一致性（阶段 1 Done 标准）：同 seed 跑两次，输出逐字节相同；不同 seed 输出不同。
import { describe, expect, it } from 'vitest';
import { runGame } from '../src/run.js';

describe('模拟器回放', () => {
  it('同 seed 两次输出逐字节相同', () => {
    expect(runGame('demo')).toBe(runGame('demo'));
  });

  it('跑完 6 回合并输出终局与指标', () => {
    const out = runGame('demo');
    expect(out).toContain('--- 回合 6 ---');
    expect(out).toContain('=== 终局 ===');
    expect(out).toContain('过线人数 Q =');
    expect(out).toContain('=== 观察指标');
    expect(out).not.toContain('[校验拒绝]');   // 脚本策略不应产生非法提交
  });

  it('不同 seed 牌序不同（抽样验证非退化）', () => {
    expect(runGame('demo')).not.toBe(runGame('demo2'));
  });
});
