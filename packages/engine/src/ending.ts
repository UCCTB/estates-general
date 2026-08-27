// 终局叙事（TDD-002 §3 / §4）与终局投票（§7）。纯函数。
// 三层：时代结局（过线人数）→ 政体结局（胜者组合）→ 社会史后记（本局解锁的成就）。
// 成就完全不影响胜负（规则书 §17.1 / §25）：本模块只读 finalStanding 的结果，不改排名。
import type { Game, GameEvent, Identity, SeatId } from './types.js';
import { emitEvent } from './events.js';
import { finalStanding, type StandingRow } from './finalStanding.js';
import {
  evaluateEndgameAchievements, nominationCandidates,
  type AchievementAward, type Nomination,
} from './achievements.js';
import { META, type AchievementKey, THRESHOLDS } from './data/achievement-meta.js';
import { ERA_ENDINGS } from './data/endings-era.js';
import { POLITY_PAIRS, POLITY_SOLO, FALLBACK_POLITY } from './data/endings-polity.js';
import { SPECIAL_TRIOS } from './data/endings-special.js';
import { EPILOGUES } from './data/epilogues.js';

// ── 结局结构 ─────────────────────────────────────────────────────────

export type PolityKind = 'SPECIAL' | 'PAIR' | 'SOLO' | 'FALLBACK' | 'NONE';

export interface EpilogueItem { key: AchievementKey; name: string; text: string; source: string; }

export interface Ending {
  passCount: number;
  era: { name: string; note: string };
  polity: { name: string; note: string; kind: PolityKind };
  /** 规则书 §20 未列出该胜者组合，走了 TDD-002 §4.3 的通则回退 */
  polityFallback: boolean;
  /** 规则书 §23 第五步的建议标题：《时代结局——政体结局》 */
  title: string;
  epilogue: EpilogueItem[];
}

// ── 第一 / 第二层：查表（TDD-002 §4.1 / §4.2 / §4.3）───────────────────

export function eraEnding(passCount: number): { name: string; note: string } {
  const row = ERA_ENDINGS[passCount];
  if (row === undefined) throw new Error(`eraEnding：过线人数 ${passCount} 越界`);
  return { name: row.name, note: row.note };
}

export function polityEnding(ranked: StandingRow[]): {
  name: string; note: string; kind: PolityKind; fallback: boolean;
} {
  if (ranked.length === 0) {
    return { name: '', note: '没有人完成制度要求，本局没有政体结局', kind: 'NONE', fallback: false };
  }
  const first = ranked[0]!.identity;

  // 1. 特殊前三名组合（规则书 §21）。按表中列出的顺序逐项匹配，第一个命中即用——
  //    保证同一前三名在任何实现下得到同一结局。
  if (ranked.length >= 3) {
    const top3 = new Set<Identity>(ranked.slice(0, 3).map((r) => r.identity));
    if (top3.size === 3) {
      for (const trio of SPECIAL_TRIOS) {
        if (trio.members.every((m) => top3.has(m))) {
          const useVariant = trio.variantWhenFirst !== undefined && trio.variantWhenFirst === first;
          return {
            name: useVariant ? trio.variantName! : trio.name,
            note: trio.note,
            kind: 'SPECIAL',
            fallback: false,
          };
        }
      }
    }
  }

  // 2. 普通双人结局（规则书 §20）
  if (ranked.length >= 2) {
    const second = ranked[1]!.identity;
    const hit = POLITY_PAIRS.find((p) => p.first === first && p.second === second);
    if (hit !== undefined) return { name: hit.name, note: '', kind: 'PAIR', fallback: false };
  } else {
    // 3. 独胜结局（规则书 §20 各节末条）
    const solo = POLITY_SOLO[first];
    if (solo !== undefined) return { name: solo, note: '独自过线', kind: 'SOLO', fallback: false };
  }

  // 4. 回退（TDD-002 §4.3）：规则书只列「常见结局」，132 组里有 69 组没有条目。
  return {
    name: FALLBACK_POLITY[first],
    note: '规则书 §20 未列出这一胜者组合，使用第一名身份的通则结局',
    kind: 'FALLBACK',
    fallback: true,
  };
}

// ── 第三层：社会史后记（TDD-002 §4.4）──────────────────────────────────

const ORDER = Object.keys(META) as AchievementKey[];

export function buildEpilogue(awards: AchievementAward[]): EpilogueItem[] {
  const items = awards
    .map((a) => ({ a, line: EPILOGUES[a.key] }))
    .filter((x): x is { a: AchievementAward; line: NonNullable<typeof x.line> } => x.line !== undefined)
    .sort((x, y) =>
      (META[y.a.key].weight - META[x.a.key].weight)
      || (ORDER.indexOf(x.a.key) - ORDER.indexOf(y.a.key)));
  return items.slice(0, 3).map(({ a, line }) => ({
    key: a.key, name: META[a.key].name, text: line.text, source: line.source,
  }));
}

// ── finalize：终局程序步骤 1–4（TDD-002 §3）───────────────────────────

export interface FinalizeResult {
  state: Game;
  events: GameEvent[];
  rows: StandingRow[];
  passCount: number;
  ending: Ending;                 // epilogue 此时为空，待投票确认后由 resolveEpilogue 定稿
  autoAwards: AchievementAward[]; // 含本局此前各回合已解锁的
  nominations: Nomination[];
  ballot: Ballot;
}

export function finalize(state: Game): FinalizeResult {
  if (state.phase !== 'GAME_END') throw new Error(`finalize：阶段 ${state.phase} 未到终局`);

  const st = finalStanding(state);
  const s = st.state;
  const events = [...st.events];

  // 终局时点的自动档判定，逐条落成 ACHIEVEMENT_AUTO
  for (const a of evaluateEndgameAchievements(s, st.rows)) {
    emitEvent(s, events, 'ACHIEVEMENT_AUTO', 'PUBLIC', { ...a }, 6, 'GAME_END');
  }

  const ranked = [...st.rows].filter((r) => r.qualified).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const era = eraEnding(st.passCount);
  const polity = polityEnding(ranked);
  const ending: Ending = {
    passCount: st.passCount,
    era,
    polity: { name: polity.name, note: polity.note, kind: polity.kind },
    polityFallback: polity.fallback,
    title: polity.name === '' ? `《${era.name}》` : `《${era.name}——${polity.name}》`,
    epilogue: [],
  };

  const autoAwards = s.events
    .filter((e) => e.type === 'ACHIEVEMENT_AUTO')
    .map((e) => e.payload as unknown as AchievementAward);
  const nominations = nominationCandidates(s);

  return { state: s, events, rows: st.rows, passCount: st.passCount, ending, autoAwards, nominations, ballot: buildBallot(nominations) };
}

// ── 终局投票（TDD-002 §7）─────────────────────────────────────────────

export const NO_UNLOCK = 'NONE';

export interface BallotOption { id: string; label: string; subjects: SeatId[]; }
export interface BallotQuestion {
  id: string;
  key: AchievementKey;
  name: string;
  kind: 'NOMINATION' | 'SEAT_PICK' | 'YES_NO';
  prompt: string;
  options: BallotOption[];
}
export interface Ballot { questions: BallotQuestion[]; }

/** 选票：questionId → (seatId → optionId)。未出现的座位视为弃权。 */
export type Votes = Record<string, Partial<Record<SeatId, string>>>;

const ALL_SEATS: readonly SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function buildBallot(nominations: Nomination[]): Ballot {
  const questions: BallotQuestion[] = [];

  for (const n of nominations) {
    questions.push({
      id: `NOM:${n.key}`,
      key: n.key,
      name: n.name,
      kind: 'NOMINATION',
      prompt: `【${n.name}】本局应当授予谁？`,
      options: [
        ...n.candidates.map((c) => ({
          id: c.candidateId,
          label: `座位 ${c.subjects.join('、')}${c.round !== undefined ? `（第 ${c.round} 回合）` : ''}：${c.rationale}`,
          subjects: c.subjects,
        })),
        { id: NO_UNLOCK, label: '本局不解锁', subjects: [] },
      ],
    });
  }

  // 投票档（规则书 §17.2 / §17.4）：引擎给不出候选，直接交给全员
  questions.push({
    id: 'VOTE:DOUBLE_AGENT',
    key: 'DOUBLE_AGENT',
    name: META.DOUBLE_AGENT.name,
    kind: 'SEAT_PICK',
    prompt: '【双重身份】谁同时站在两个利益明显不同的集团里，并且两边都维持住了？',
    options: [
      ...ALL_SEATS.map((s) => ({ id: `SEAT:${s}`, label: `座位 ${s}`, subjects: [s] })),
      { id: NO_UNLOCK, label: '本局不解锁', subjects: [] },
    ],
  });
  questions.push({
    id: 'VOTE:EQUAL_VALUE_UNEQUAL_POWER',
    key: 'EQUAL_VALUE_UNEQUAL_POWER',
    name: META.EQUAL_VALUE_UNEQUAL_POWER.name,
    kind: 'YES_NO',
    prompt: '【等值不等势】开局十二种「价值 100」的身份，实际并不等势——你同意吗？',
    options: [
      { id: 'YES', label: '同意', subjects: [] },
      { id: 'NO', label: '不同意', subjects: [] },
    ],
  });

  return { questions };
}

export interface TallyLine {
  questionId: string;
  key: AchievementKey;
  counts: Record<string, number>;
  abstain: number;
  winner: string | null;          // 胜出选项 id；并列或 NO_UNLOCK 时为 null
  award: AchievementAward | null;
}

/**
 * 计票（TDD-002 §7.2）。每席一票，弃权计入分母但不计入任何选项。
 * 提名档与【双重身份】相对多数当选，**并列则不解锁**——引擎不用抽签裁决社会判断。
 * 【等值不等势】按规则书 §17.4 的明文门槛：赞成 ≥ 9 票。
 */
export function tally(ballot: Ballot, votes: Votes, nominations: Nomination[] = []): TallyLine[] {
  const byKey = new Map(nominations.map((n) => [n.key, n]));
  return ballot.questions.map((q) => {
    const cast = votes[q.id] ?? {};
    const counts: Record<string, number> = {};
    for (const o of q.options) counts[o.id] = 0;
    let abstain = 0;
    for (const seat of ALL_SEATS) {
      const pick = cast[seat];
      if (pick === undefined || !(pick in counts)) { abstain += 1; continue; }
      counts[pick] = (counts[pick] ?? 0) + 1;
    }

    if (q.kind === 'YES_NO') {
      const yes = counts['YES'] ?? 0;
      const pass = yes >= THRESHOLDS.EQUAL_VALUE_MIN_VOTES;
      return {
        questionId: q.id, key: q.key, counts, abstain,
        winner: pass ? 'YES' : null,
        award: pass ? nominatedAward(q.key, [], `全员投票：${yes} 票同意（门槛 ${THRESHOLDS.EQUAL_VALUE_MIN_VOTES}）`) : null,
      };
    }

    const scored = q.options.filter((o) => o.id !== NO_UNLOCK).map((o) => ({ o, n: counts[o.id] ?? 0 }));
    const top = Math.max(0, ...scored.map((x) => x.n));
    const leaders = scored.filter((x) => x.n === top && x.n > 0);
    const noneVotes = counts[NO_UNLOCK] ?? 0;
    if (top === 0 || leaders.length !== 1 || noneVotes > top) {
      return { questionId: q.id, key: q.key, counts, abstain, winner: null, award: null };
    }
    const win = leaders[0]!.o;
    const nom = byKey.get(q.key);
    const c = nom?.candidates.find((x) => x.candidateId === win.id);
    return {
      questionId: q.id, key: q.key, counts, abstain, winner: win.id,
      award: nominatedAward(q.key, win.subjects, c?.rationale ?? win.label, c?.eventSeqs ?? []),
    };
  });
}

function nominatedAward(key: AchievementKey, subjects: SeatId[], note: string, eventSeqs: number[] = []): AchievementAward {
  return {
    key, name: META[key].name, tier: META[key].tier,
    round: 0, subjects: [...subjects].sort((a, b) => a - b),
    // 投票确认的成就不是引擎判定的事实，approx 记 FUZZY：它反映的是全员的判断
    evidence: { eventSeqs, note, approx: 'FUZZY' },
  };
}

// ── 终局程序步骤 5–6：定稿并广播 ───────────────────────────────────────

export function openBallot(state: Game, ballot: Ballot): { state: Game; events: GameEvent[] } {
  const s = structuredClone(state);
  const events: GameEvent[] = [];
  emitEvent(s, events, 'BALLOT_OPENED', 'PUBLIC', { questions: ballot.questions.length }, 6, 'GAME_END');
  return { state: s, events };
}

export function closeBallot(state: Game, ballot: Ballot, votes: Votes, nominations: Nomination[]): {
  state: Game; events: GameEvent[]; lines: TallyLine[]; awards: AchievementAward[];
} {
  const s = structuredClone(state);
  const events: GameEvent[] = [];
  const lines = tally(ballot, votes, nominations);
  const awards = lines.map((l) => l.award).filter((a): a is AchievementAward => a !== null);
  for (const a of awards) {
    emitEvent(s, events, 'ACHIEVEMENT_NOMINATED', 'PUBLIC', { ...a }, 6, 'GAME_END');
  }
  return { state: s, events, lines, awards };
}

export function resolveEpilogue(state: Game, ending: Ending, allAwards: AchievementAward[]): {
  state: Game; events: GameEvent[]; ending: Ending;
} {
  const s = structuredClone(state);
  const events: GameEvent[] = [];
  const final: Ending = { ...ending, epilogue: buildEpilogue(allAwards) };
  emitEvent(s, events, 'GAME_ENDING_RESOLVED', 'PUBLIC', { ...final }, 6, 'GAME_END');
  return { state: s, events, ending: final };
}
