// 房间：持有一局的全部状态，驱动阶段，把玩家操作转成引擎输入，把引擎事件广播出去。
// 引擎是无 I/O 的纯逻辑包（TDD-001 §3.1）；一切副作用——时钟、持久化、会话——都在这里。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AchievementAward, Ballot, Ending, Game, GameEvent, MemoDraft, Nomination,
  NotarizedDraft, SeatId, Submission, TallyLine, Votes,
} from '@estates/engine';
import {
  accuseMemoContract, beginNegotiation, cancelNotarizedContract, closeBallot, finalize,
  initGame, lockSubmissions, openBallot, pledgeCrisis, rebutMemoContract,
  registerMemoContract, registerNotarizedContract, resolveEpilogue, roundStart, settle,
  transfer, useIntel, verifyIntelClaims,
} from '@estates/engine';
import { mintToken, newNonce } from './tokens.js';

const ALL_SEATS: readonly SeatId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DATA_DIR = process.env['ESTATES_DATA_DIR'] ?? 'data';

export type Fail = { ok: false; reason: string };
export type Ok<T = unknown> = { ok: true } & T;

/** 待确认的契约提案（TDD-001 §9.1 步骤 3：B 确认才生效，NEGOTIATION 结束即丢弃）。 */
export interface Proposal {
  proposalId: string;
  from: SeatId;
  to: SeatId;
  kind: 'NOTARIZED' | 'MEMO';
  notarized?: Omit<NotarizedDraft, 'witnesses'>;
  memo?: Omit<MemoDraft, 'witnesses'>;
  summary: string;                // 给 B 看的一句话
}

/** 最小谈判载体替身（TDD-001 §3.1 的 Negotiation carrier 在系统之外）。 */
export interface Conversation { id: string; round: number; participants: SeatId[]; startedAt: number; endedAt?: number; }

export interface RoomSnapshotMeta {
  version: number;
  deadline: number | null;
  submitted: SeatId[];
  proposals: Proposal[];
  conversations: Conversation[];
  ending: Ending | null;
  ballotOpen: boolean;
  ballot: Ballot | null;
  nominations: Nomination[];
  autoAwards: AchievementAward[];
  nominatedAwards: AchievementAward[];
  tallyLines: TallyLine[];
  votesCast: SeatId[];
}

export class Room {
  state: Game;
  readonly gameId: string;
  readonly secret: string;
  /** 每座位一个 nonce；重发令牌 = 换 nonce，旧令牌与旧 session 立即作废（§7.2）。 */
  nonces: Record<number, string> = {};
  hostNonce = newNonce();
  version = 1;
  deadline: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  accepted: Submission[] = [];
  proposals: Proposal[] = [];
  conversations: Conversation[] = [];
  private proposalSeq = 0;

  ending: Ending | null = null;
  ballot: Ballot | null = null;
  ballotOpen = false;
  nominations: Nomination[] = [];
  autoAwards: AchievementAward[] = [];
  nominatedAwards: AchievementAward[] = [];
  tallyLines: TallyLine[] = [];
  votes: Votes = {};
  votesCast: SeatId[] = [];

  private listeners = new Set<() => void>();

  constructor(gameId: string, seed: string, secret: string) {
    this.gameId = gameId;
    this.secret = secret;
    this.state = initGame(gameId, seed).state;
    for (const s of ALL_SEATS) this.nonces[s] = newNonce();
    // 建局时全部座位默认未连接；兑换令牌时置为 connected（§7.2）
    for (const s of ALL_SEATS) this.state.seats[s].connected = false;
    this.save();
  }

  // ── 令牌 ───────────────────────────────────────────────────────────

  seatToken(seatId: SeatId): string {
    return mintToken(this.secret, { gameId: this.gameId, seatId, nonce: this.nonces[seatId]!, issuedAt: Date.now() });
  }

  hostToken(): string {
    return mintToken(this.secret, { gameId: this.gameId, seatId: 0, nonce: this.hostNonce, issuedAt: Date.now() });
  }

  reissue(seatId: SeatId): string {
    this.nonces[seatId] = newNonce();
    this.state.seats[seatId].connected = false;
    this.emitRaw('SEAT_TOKEN_REISSUED', 'HOST', { seatId });
    this.bump();
    return this.seatToken(seatId);
  }

  nonceValid(seatId: SeatId | 0, nonce: string): boolean {
    return seatId === 0 ? nonce === this.hostNonce : nonce === this.nonces[seatId];
  }

  connect(seatId: SeatId): void {
    if (this.state.seats[seatId].connected) return;
    this.state.seats[seatId].connected = true;
    this.emitRaw('SEAT_CONNECTED', 'PUBLIC', { seatId });
    this.bump();
  }

  // ── 订阅 / 持久化 ──────────────────────────────────────────────────

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(): void {
    this.version += 1;
    this.save();
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(join(DATA_DIR, `${this.gameId}.json`), JSON.stringify({
        gameId: this.gameId, nonces: this.nonces, hostNonce: this.hostNonce,
        state: this.state, accepted: this.accepted, ending: this.ending,
      }, null, 0), 'utf8');
    } catch {
      // 持久化失败不影响进行中的一局；主持端仍有完整的内存状态
    }
  }

  /** 事件日志是 append-only（TDD-001 约束 3）；服务端自身的事件也走同一条日志。 */
  private emitRaw(type: GameEvent['type'], visibility: GameEvent['visibility'], payload: Record<string, unknown>): void {
    this.state.events.push({
      seq: this.state.events.length,
      round: this.state.round,
      phase: this.state.phase,
      type, visibility, payload,
    });
  }

  // ── 阶段推进（TDD-001 §3.2）────────────────────────────────────────

  meta(): RoomSnapshotMeta {
    return {
      version: this.version,
      deadline: this.deadline,
      submitted: this.accepted.map((s) => s.seatId).sort((a, b) => a - b),
      proposals: this.proposals,
      conversations: this.conversations.filter((c) => c.endedAt === undefined),
      ending: this.ending,
      ballotOpen: this.ballotOpen,
      ballot: this.ballot,
      nominations: this.nominations,
      autoAwards: this.autoAwards,
      nominatedAwards: this.nominatedAwards,
      tallyLines: this.tallyLines,
      votesCast: [...this.votesCast].sort((a, b) => a - b),
    };
  }

  setDeadline(seconds: number | null): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (seconds === null || seconds <= 0) { this.deadline = null; this.bump(); return; }
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => { this.timer = null; this.deadline = null; this.advance(); }, seconds * 1000);
    this.bump();
  }

  /** 主持端「下一阶段」。每次只走一步，绝不跳过窗口。 */
  advance(): Ok<{ note: string }> | Fail {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.deadline = null;
    const phase = this.state.phase;
    try {
      if (phase === 'ROUND_START') {
        const r = roundStart(this.state);
        this.state = r.state;
        this.bump();
        return { ok: true, note: `第 ${this.state.round} 回合开始，进入情报阶段` };
      }
      if (phase === 'REVEAL_AND_INTEL') {
        this.state = beginNegotiation(this.state);
        this.bump();
        return { ok: true, note: '进入自由磋商' };
      }
      if (phase === 'NEGOTIATION') {
        // §10.2：NEGOTIATION 结束时，未确认的契约提案一律丢弃
        this.proposals = [];
        for (const c of this.conversations) if (c.endedAt === undefined) c.endedAt = Date.now();
        const r = lockSubmissions(this.state, []);   // 只切阶段，不带提交
        this.state = r.state;
        this.bump();
        return { ok: true, note: '进入秘密提交' };
      }
      if (phase === 'SUBMISSION') {
        // §7.3：未提交的座位视为空提交，不需要出现在 submissions 里
        const r = settle(this.state, this.accepted, this.state.seed);
        this.state = r.state;
        this.accepted = [];
        if (this.state.phase === 'GAME_END') this.finishGame();
        this.bump();
        return { ok: true, note: this.state.phase === 'GAME_END' ? '第 6 回合结算完毕，进入终局' : '结算完毕' };
      }
      return { ok: false, reason: `阶段 ${phase} 没有下一步` };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private finishGame(): void {
    const v = verifyIntelClaims(this.state);
    this.state = v.state;
    const fin = finalize(this.state);
    this.state = fin.state;
    this.ending = fin.ending;
    this.autoAwards = fin.autoAwards;
    this.nominations = fin.nominations;
    this.ballot = fin.ballot;
  }

  // ── 玩家动作 ───────────────────────────────────────────────────────

  private apply(r: { ok: true; state: Game } | { ok: false; reason: string }): Ok | Fail {
    if (!r.ok) return r;
    this.state = r.state;
    this.bump();
    return { ok: true };
  }

  doTransfer(from: SeatId, to: SeatId, amount: number): Ok | Fail {
    return this.apply(transfer(this.state, from, to, amount));
  }

  doIntel(seatId: SeatId, domain: 'WAR' | 'ENGINEERING' | 'COMMERCE' | 'ADMIN' | 'CRISIS'): Ok<{ field?: string; value?: unknown }> | Fail {
    const r = useIntel(this.state, seatId, domain);
    if (!r.ok) return r;
    this.state = r.state;
    this.bump();
    return { ok: true, field: r.field, value: r.value };
  }

  doPledge(seatId: SeatId, funds: number, ability: number): Ok | Fail {
    return this.apply(pledgeCrisis(this.state, seatId, funds, ability));
  }

  doAccuse(seatId: SeatId, contractId: string, statement: string): Ok | Fail {
    return this.apply(accuseMemoContract(this.state, contractId, seatId, statement));
  }

  doRebut(seatId: SeatId, contractId: string, statement: string): Ok | Fail {
    return this.apply(rebutMemoContract(this.state, contractId, seatId, statement));
  }

  doCancel(seatId: SeatId, contractId: string): Ok | Fail {
    const c = this.state.contracts.find((x) => x.contractId === contractId);
    if (c === undefined || !c.parties.includes(seatId)) return { ok: false, reason: '不是这份契约的当事人' };
    // §5.6：取消需双方确认。这里以「对方也点过取消」为准，用提案表暂存第一次点击。
    const key = `CANCEL:${contractId}`;
    const other = c.parties[0] === seatId ? c.parties[1] : c.parties[0];
    const pending = this.proposals.find((p) => p.proposalId === key);
    if (pending === undefined) {
      this.proposals.push({
        proposalId: key, from: seatId, to: other, kind: 'NOTARIZED',
        summary: `对方提出取消契约 ${contractId}`,
      });
      this.bump();
      return { ok: true };
    }
    if (pending.from === seatId) return { ok: false, reason: '已提出取消，等待对方确认' };
    this.proposals = this.proposals.filter((p) => p.proposalId !== key);
    return this.apply(cancelNotarizedContract(this.state, contractId));
  }

  doSubmit(seatId: SeatId, submission: Submission): Ok | Fail {
    if (this.state.phase !== 'SUBMISSION') return { ok: false, reason: `阶段 ${this.state.phase} 不接受提交` };
    if (this.accepted.some((s) => s.seatId === seatId)) return { ok: false, reason: '本回合已提交，提交后不得修改' };
    const r = lockSubmissions(this.state, [{ ...submission, seatId, round: this.state.round }]);
    const rejected = r.rejected.find((x) => x.seatId === seatId);
    if (rejected !== undefined) return { ok: false, reason: rejected.reason };
    this.state = r.state;
    this.accepted.push(...r.accepted);
    this.bump();
    return { ok: true };
  }

  // ── 契约提案（§9.1 步骤 3）──────────────────────────────────────────

  propose(from: SeatId, p: Omit<Proposal, 'proposalId' | 'from'>): Ok<{ proposalId: string }> | Fail {
    if (this.state.phase !== 'NEGOTIATION') return { ok: false, reason: `阶段 ${this.state.phase} 不可登记契约` };
    if (p.to === from) return { ok: false, reason: '当事人不能是同一座位' };
    this.proposalSeq += 1;
    const proposalId = `P${this.proposalSeq}`;
    this.proposals.push({ ...p, proposalId, from });
    this.bump();
    return { ok: true, proposalId };
  }

  /** 见证人 = 当前与双方同在一个未结束谈话中的其他座位（§9.1 步骤 4）。 */
  private witnessesFor(a: SeatId, b: SeatId): SeatId[] {
    const set = new Set<SeatId>();
    for (const c of this.conversations) {
      if (c.endedAt !== undefined || c.round !== this.state.round) continue;
      if (!c.participants.includes(a) || !c.participants.includes(b)) continue;
      for (const p of c.participants) if (p !== a && p !== b) set.add(p);
    }
    return [...set].sort((x, y) => x - y);
  }

  confirm(seatId: SeatId, proposalId: string): Ok<{ contractId?: string }> | Fail {
    const p = this.proposals.find((x) => x.proposalId === proposalId);
    if (p === undefined) return { ok: false, reason: '提案不存在或已失效' };
    if (p.to !== seatId) return { ok: false, reason: '这份提案不是给你的' };
    if (proposalId.startsWith('CANCEL:')) return this.doCancel(seatId, proposalId.slice('CANCEL:'.length));

    const witnesses = this.witnessesFor(p.from, p.to);
    const r = p.kind === 'NOTARIZED'
      ? registerNotarizedContract(this.state, { ...p.notarized!, witnesses })
      : registerMemoContract(this.state, { ...p.memo!, witnesses });
    if (!r.ok) return r;
    this.state = r.state;
    this.proposals = this.proposals.filter((x) => x.proposalId !== proposalId);
    this.bump();
    return { ok: true, contractId: r.contractId };
  }

  reject(seatId: SeatId, proposalId: string): Ok | Fail {
    const p = this.proposals.find((x) => x.proposalId === proposalId);
    if (p === undefined) return { ok: false, reason: '提案不存在或已失效' };
    if (p.to !== seatId && p.from !== seatId) return { ok: false, reason: '与你无关的提案' };
    this.proposals = this.proposals.filter((x) => x.proposalId !== proposalId);
    this.bump();
    return { ok: true };
  }

  // ── 谈话（最小载体替身）────────────────────────────────────────────

  openConversation(seatId: SeatId, others: SeatId[]): Ok<{ id: string }> | Fail {
    if (this.state.phase !== 'NEGOTIATION' && this.state.phase !== 'REVEAL_AND_INTEL') {
      return { ok: false, reason: `阶段 ${this.state.phase} 不在谈判窗口内` };
    }
    const participants = [...new Set([seatId, ...others])].sort((a, b) => a - b);
    if (participants.length < 2) return { ok: false, reason: '谈话至少需要 2 人' };
    const id = `CONV${this.state.events.length}`;
    this.conversations.push({ id, round: this.state.round, participants, startedAt: Date.now() });
    this.emitRaw('CONVERSATION_OPENED', 'PUBLIC', { id, participants });
    this.bump();
    return { ok: true, id };
  }

  closeConversation(seatId: SeatId, id: string): Ok | Fail {
    const c = this.conversations.find((x) => x.id === id);
    if (c === undefined || c.endedAt !== undefined) return { ok: false, reason: '谈话不存在或已结束' };
    if (!c.participants.includes(seatId)) return { ok: false, reason: '你不在这场谈话里' };
    c.endedAt = Date.now();
    this.emitRaw('CONVERSATION_CLOSED', 'PUBLIC', { id, participants: c.participants });
    this.bump();
    return { ok: true };
  }

  // ── 终局投票（TDD-002 §7）──────────────────────────────────────────

  openVote(): Ok | Fail {
    if (this.ballot === null) return { ok: false, reason: '尚未进入终局' };
    const r = openBallot(this.state, this.ballot);
    this.state = r.state;
    this.ballotOpen = true;
    this.bump();
    return { ok: true };
  }

  castVote(seatId: SeatId, picks: Record<string, string>): Ok | Fail {
    if (!this.ballotOpen) return { ok: false, reason: '投票尚未开始或已结束' };
    for (const [q, opt] of Object.entries(picks)) {
      this.votes[q] = { ...(this.votes[q] ?? {}), [seatId]: opt };
    }
    if (!this.votesCast.includes(seatId)) this.votesCast.push(seatId);
    this.bump();
    return { ok: true };
  }

  closeVote(): Ok | Fail {
    if (this.ballot === null || !this.ballotOpen) return { ok: false, reason: '投票尚未开始' };
    const r = closeBallot(this.state, this.ballot, this.votes, this.nominations);
    this.state = r.state;
    this.ballotOpen = false;
    this.tallyLines = r.lines;
    this.nominatedAwards = r.awards;
    const ep = resolveEpilogue(this.state, this.ending!, [...this.autoAwards, ...this.nominatedAwards]);
    this.state = ep.state;
    this.ending = ep.ending;
    this.bump();
    return { ok: true };
  }
}

// ── 房间登记表 ───────────────────────────────────────────────────────

const rooms = new Map<string, Room>();

export function createRoom(seed: string, secret: string): Room {
  const gameId = `G${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const room = new Room(gameId, seed, secret);
  rooms.set(gameId, room);
  return room;
}

export function getRoom(gameId: string): Room | undefined {
  return rooms.get(gameId);
}

export function listRooms(): Room[] {
  return [...rooms.values()];
}

/** 服务端重启后列出磁盘上的存档，供主持端确认（本版不自动恢复运行中的一局）。 */
export function listArchives(): string[] {
  try {
    return readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function readArchive(gameId: string): unknown {
  return JSON.parse(readFileSync(join(DATA_DIR, `${gameId}.json`), 'utf8'));
}
