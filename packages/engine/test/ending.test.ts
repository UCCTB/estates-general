// 终局叙事查表与终局投票（TDD-002 §4 / §7）。
// 覆盖：12 档时代结局、7 个特殊组合（含三人次序无关）、普通双人表、三级回退、
// 后记的权重排序与 1–3 条上限、计票的并列不解锁 / 弃权计入分母 / 9 票门槛。
import { describe, expect, it } from 'vitest';
import type { Game, Identity, SeatId } from '../src/types.js';
import type { StandingRow } from '../src/finalStanding.js';
import {
  NO_UNLOCK, buildBallot, buildEpilogue, eraEnding, polityEnding, tally,
  type Ballot, type Votes,
} from '../src/ending.js';
import type { AchievementAward, Nomination } from '../src/achievements.js';
import { META, type AchievementKey } from '../src/data/achievement-meta.js';
import { ERA_ENDINGS } from '../src/data/endings-era.js';
import { POLITY_PAIRS } from '../src/data/endings-polity.js';
import { SPECIAL_TRIOS } from '../src/data/endings-special.js';

function row(seatId: SeatId, identity: Identity, rank: number): StandingRow {
  return {
    seatId, identity, funds: 100, stampsTotal: 2, stampsEffective: 2, recordsTotal: 2,
    highestQualification: 'BASIC', qualified: true, rank, winner: rank <= 6, overallRank: rank,
  };
}

function ranked(...identities: Identity[]): StandingRow[] {
  return identities.map((id, i) => row((i + 1) as SeatId, id, i + 1));
}

describe('第一层：时代结局（规则书 §19）', () => {
  it('Q = 0..12 逐档命中原表', () => {
    for (let q = 0; q <= 12; q++) {
      expect(eraEnding(q).name).toBe(ERA_ENDINGS[q]!.name);
    }
    expect(eraEnding(0).name).toBe('大空位');
    expect(eraEnding(12).name).toBe('众人皆贵，唯有六席');
  });

  it('越界抛错，不静默兜底', () => {
    expect(() => eraEnding(13)).toThrow();
  });
});

describe('第二层：政体结局（规则书 §20 / §21 / TDD-002 §4.3）', () => {
  it('特殊前三名组合覆盖普通双人结局，且与三人内部次序无关', () => {
    // 国王 + 主教 + 贵族：若只看 (国王, 主教) 会是「王座与祭坛」，特殊组合应覆盖它
    expect(polityEnding(ranked('KING', 'BISHOP', 'NOBLE')).name).toBe('王座、祭坛与纹章');
    expect(polityEnding(ranked('NOBLE', 'KING', 'BISHOP')).name).toBe('王座、祭坛与纹章');
    expect(polityEnding(ranked('BISHOP', 'NOBLE', 'KING')).kind).toBe('SPECIAL');
  });

  it('主教第一时使用变体名「卡诺莎体系」', () => {
    expect(polityEnding(ranked('BISHOP', 'KING', 'NOBLE')).name).toBe('卡诺莎体系');
    expect(polityEnding(ranked('KING', 'BISHOP', 'NOBLE')).name).toBe('王座、祭坛与纹章');
  });

  it('7 个特殊组合各命中一次', () => {
    for (const trio of SPECIAL_TRIOS) {
      const r = polityEnding(ranked(...trio.members));
      expect(r.kind).toBe('SPECIAL');
      const expected = trio.variantWhenFirst === trio.members[0] ? trio.variantName : trio.name;
      expect(r.name).toBe(expected);
    }
  });

  it('普通双人表逐条命中（63 条）', () => {
    expect(POLITY_PAIRS).toHaveLength(63);
    for (const p of POLITY_PAIRS) {
      // 只放两人，避免撞上特殊三人组合
      const r = polityEnding(ranked(p.first, p.second));
      expect(r.kind).toBe('PAIR');
      expect(r.name).toBe(p.name);
    }
  });

  it('只有一人过线时用独胜结局；无独胜条目则回退', () => {
    expect(polityEnding(ranked('KING'))).toMatchObject({ name: '朕即秩序', kind: 'SOLO' });
    expect(polityEnding(ranked('PEASANT'))).toMatchObject({ name: '无人再为领主耕田', kind: 'SOLO' });
    // 商人没有独胜条目 → 通则回退
    expect(polityEnding(ranked('MERCHANT'))).toMatchObject({ kind: 'FALLBACK', fallback: true });
  });

  it('规则书未列出的胜者组合走通则回退，并明确标记 fallback', () => {
    // 王后 + 工匠：§20.3 没有这一条
    const r = polityEnding(ranked('QUEEN', 'ARTISAN'));
    expect(r.kind).toBe('FALLBACK');
    expect(r.fallback).toBe(true);
    expect(r.name).toBe('宫廷之治');
  });

  it('无人过线时没有政体结局', () => {
    const r = polityEnding([]);
    expect(r.kind).toBe('NONE');
    expect(r.name).toBe('');
  });
});

describe('第三层：社会史后记（规则书 §22 / TDD-002 §4.4）', () => {
  const mk = (key: AchievementKey): AchievementAward => ({
    key, name: META[key].name, tier: META[key].tier, round: 0, subjects: [],
    evidence: { eventSeqs: [], note: '', approx: 'EXACT' },
  });

  it('按结构权重降序取前 3，权重相同按规则书出现顺序', () => {
    // 权重 1 / 2 / 3 各一条 + 一条权重 3，应取三条权重高的
    const out = buildEpilogue([
      mk('BROKER'),              // 权重 1（且无后记文案时会被过滤，这里有）
      mk('SHADOW_BANK'),         // 权重 2
      mk('TRAGEDY_OF_COMMONS'),  // 权重 3
      mk('MONEY_IS_NOT_ENOUGH'), // 权重 3
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((x) => x.key)).toEqual(['TRAGEDY_OF_COMMONS', 'MONEY_IS_NOT_ENOUGH', 'SHADOW_BANK']);
  });

  it('候选池为空时后记为空，不是错误', () => {
    expect(buildEpilogue([])).toEqual([]);
  });

  it('规则书 §22 原文的 5 条后记逐字保留', () => {
    const byKey = Object.fromEntries(buildEpilogue([mk('TRAGEDY_OF_COMMONS')]).map((x) => [x.key, x]));
    expect(byKey['TRAGEDY_OF_COMMONS']!.text).toBe('他们能够分配整个王国，却无法共同阻止瘟疫。');
    expect(byKey['TRAGEDY_OF_COMMONS']!.source).toBe('规则书 §22');
  });
});

describe('终局投票（TDD-002 §7）', () => {
  const nomination: Nomination = {
    key: 'BROKER', name: META.BROKER.name,
    candidates: [
      { candidateId: 'BROKER:3', subjects: [3], rationale: '一手收一手付', eventSeqs: [] },
      { candidateId: 'BROKER:7', subjects: [7], rationale: '同样一手收一手付', eventSeqs: [] },
    ],
  };
  const ballot: Ballot = buildBallot([nomination]);
  const qNom = 'NOM:BROKER';
  const qEqual = 'VOTE:EQUAL_VALUE_UNEQUAL_POWER';
  const seats = (n: number, pick: string): Partial<Record<SeatId, string>> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, pick]));

  it('票面含每条提名 + 两条投票档，提名题带「本局不解锁」选项', () => {
    expect(ballot.questions.map((q) => q.id)).toEqual([qNom, 'VOTE:DOUBLE_AGENT', qEqual]);
    expect(ballot.questions[0]!.options.map((o) => o.id)).toContain(NO_UNLOCK);
  });

  it('相对多数当选', () => {
    const votes: Votes = { [qNom]: { ...seats(3, 'BROKER:3'), 4: 'BROKER:7' } };
    const line = tally(ballot, votes, [nomination]).find((l) => l.questionId === qNom)!;
    expect(line.winner).toBe('BROKER:3');
    expect(line.award?.subjects).toEqual([3]);
    expect(line.abstain).toBe(8);
  });

  it('票数并列 → 不解锁（引擎不用抽签裁决社会判断）', () => {
    const votes: Votes = { [qNom]: { 1: 'BROKER:3', 2: 'BROKER:3', 3: 'BROKER:7', 4: 'BROKER:7' } };
    const line = tally(ballot, votes, [nomination]).find((l) => l.questionId === qNom)!;
    expect(line.winner).toBeNull();
    expect(line.award).toBeNull();
  });

  it('「本局不解锁」票数过半于领先候选时不解锁', () => {
    const votes: Votes = { [qNom]: { ...seats(5, NO_UNLOCK), 6: 'BROKER:3' } };
    const line = tally(ballot, votes, [nomination]).find((l) => l.questionId === qNom)!;
    expect(line.winner).toBeNull();
  });

  it('全员弃权 → 不解锁，弃权计入分母', () => {
    const line = tally(ballot, {}, [nomination]).find((l) => l.questionId === qNom)!;
    expect(line.abstain).toBe(12);
    expect(line.award).toBeNull();
  });

  it('【等值不等势】赞成 ≥ 9 票才解锁（规则书 §17.4 明文）', () => {
    const eight = tally(ballot, { [qEqual]: seats(8, 'YES') }, []).find((l) => l.questionId === qEqual)!;
    expect(eight.award).toBeNull();
    const nine = tally(ballot, { [qEqual]: seats(9, 'YES') }, []).find((l) => l.questionId === qEqual)!;
    expect(nine.award?.key).toBe('EQUAL_VALUE_UNEQUAL_POWER');
  });

  it('计票是纯函数：同输入重复调用输出一致', () => {
    const votes: Votes = { [qNom]: seats(4, 'BROKER:7') };
    const a = JSON.stringify(tally(ballot, votes, [nomination]));
    const b = JSON.stringify(tally(ballot, votes, [nomination]));
    expect(a).toBe(b);
  });
});
