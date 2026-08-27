// 领域类型 —— TDD-001 §4 逐字转录，字段名不得更改。
// 引擎内部补充的类型（Phase、QualificationRequirement、事件、pendingQualifications）
// 均单独标注出处；其中 TDD 未定义而不得不补的，已记入 docs/tdd-001-issues.md。

// ── TDD-001 §4.1 局与座位 ──────────────────────────────────────────────

export type SeatId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export type Round = 1 | 2 | 3 | 4 | 5 | 6;
export type Domain = 'WAR' | 'ENGINEERING' | 'COMMERCE' | 'CRISIS' | 'ADMIN';

export type Identity =
  | 'KING' | 'QUEEN' | 'BISHOP' | 'KNIGHT' | 'NOBLE' | 'CLERK'
  | 'MERCHANT' | 'GUILD_MASTER' | 'SCHOLAR' | 'BURGHER' | 'ARTISAN' | 'PEASANT';

export type Qualification = 'NONE' | 'BASIC' | 'ENGINEERING' | 'ADMIN' | 'ORG' | 'CORE';

// TDD-001 §3.2 阶段状态机（§4 未单独定义 Phase 类型，取值按 §3.2）
export type Phase =
  | 'ROUND_START' | 'REVEAL_AND_INTEL' | 'NEGOTIATION'
  | 'SUBMISSION' | 'SETTLEMENT' | 'GAME_END';

export interface Game {
  gameId: string;
  seedCommitment: string;         // sha256(seed)，开局公开
  seed: string;                   // 终局公开
  round: Round;
  phase: Phase;
  seats: Record<SeatId, Seat>;
  decks: Record<Domain, ProjectCard[]>;   // 开局洗好、顺序固定
  auditOrders: AuditOrder[];              // 6 张行政审查令，洗好、顺序固定
  contracts: Contract[];
  events: GameEvent[];                    // append-only
  // TDD-001 §6.2 步骤 10 / §6.4 步骤 a 引用但 §4.1 未声明的字段（issues #1）
  pendingQualifications: PendingQualification[];
  // 2026-08-27 裁定（issues #12）：中标收益下一回合到账的在途队列；第 6 回合中标则终局前即时到账
  pendingPayouts: PendingPayout[];
  // 情报揭示历史（TDD-001 §4.5；§4.1 未声明存放位置，同 issues #1 处理）：
  // 用于「同一项目不重复揭示已获知字段」（规则书 §5.3）与终局复盘
  intelReveals: IntelReveal[];
  // TDD-002 §9.2 CR-2：公共危机的公开承诺。不产生任何资源后果，只被记录。
  // 【公地悲剧】【共同体】两条自动档成就的唯一可观测依据。
  crisisPledges: CrisisPledge[];
}

// TDD-002 §9.2 CR-2。每 (seatId, round) 至多一条，后登记覆盖前一条。
export interface CrisisPledge {
  seatId: SeatId;
  round: Round;
  funds: number;
  ability: number;
}

export interface Seat {
  seatId: SeatId;
  identity: Identity;
  funds: number;                  // 可自由支配余额
  lockedFunds: number;            // 本回合提交锁定 + 契约托管
  abilityBase: number;            // 身份卡基础值
  abilityCommitted: number;       // 本回合已投入
  intel: number;                  // 情报权次数
  qualifications: QualificationState[];
  records: ProjectRecord[];       // 项目成功记录
  stamps: Stamp[];                // 履历印章
  defaults: DefaultRecord[];      // 失信记录（公开）
  connected: boolean;
}

export interface QualificationState {
  kind: Exclude<Qualification, 'NONE'>;
  usedThisRound: boolean;
  acquiredRound: Round | 0;       // 0 = 开局持有
}

// TDD-001 §6.2 步骤 10 排队、§6.4 步骤 a 执行的晋升队列元素（TDD 未给出结构，issues #1）
export interface PendingQualification {
  seatId: SeatId;
  kind: Exclude<Qualification, 'NONE' | 'CORE'>;
  viaPurchase: boolean;           // true = 基础资格购买（规则书 §7.1），false = 晋升（§7.2–7.4）
}

// 2026-08-27 裁定（issues #12）：在途收益。seatId = 队伍指定的收款人
export interface PendingPayout {
  seatId: SeatId;
  amount: number;
  source: Domain;
  awardedRound: Round;            // 中标回合；到账在其下一回合开始（第 6 回合为终局前）
}

// ── TDD-001 §4.2 项目卡与审查令 ────────────────────────────────────────

export interface ProjectCard {
  cardId: string;
  domain: Domain;
  name: string;
  // 以下字段按领域取子集；全部为规则书 V1 数值，引擎不改
  teamSize?: [number, number];
  entry: QualificationRequirement;
  minFunds?: number;
  minAbility?: number;
  reward?: number;
  risk?: number;                  // COMMERCE
  budgetCap?: number;             // ENGINEERING
  slots?: number;                 // ADMIN
  rewardIntel?: number;           // ADMIN
  fundsTarget?: number;           // CRISIS
  abilityTarget?: number;         // CRISIS
  failPenalty?: number;           // CRISIS
}

// TDD-001 §4.2 引用了 QualificationRequirement 但未定义（issues #2）。
// 此处按规则书准入列的四种写法建立封闭表示：
//   NONE          = 「无」
//   AT_LEAST_BASIC = 「基础以上」（持有任意资格）
//   ANY_OF        = 逐字列举（如「组织 / 核心」）
//   CORE_OR_TWO_ORG = 北境远征特例「核心，或 2 项组织资格」
// CORE 可满足含 BASIC 的 ANY_OF（规则书 §5.4「核心资格可以满足一般基础准入」），
// 该替代规则在 qualification.ts 的判定函数里实现，不改数据。
export type QualificationRequirement =
  | { kind: 'NONE' }
  | { kind: 'AT_LEAST_BASIC' }
  | { kind: 'ANY_OF'; accepted: Exclude<Qualification, 'NONE'>[] }
  | { kind: 'CORE_OR_TWO_ORG' };

export type AuditOrder = 'RECORD_FIRST' | 'QUALIFICATION_FIRST' | 'PRACTICE_FIRST';

// ── TDD-001 §4.3 提交 ─────────────────────────────────────────────────

export interface Submission {
  seatId: SeatId;
  round: Round;
  entries: SubmissionEntry[];
  qualificationPurchase?: boolean;   // 申请取得基础资格（锁定 20 资金）
}

// payee 为 2026-08-27 裁定新增（TDD §4.3 原文无此字段，待回写）：
// 队伍项目必须一致指定收款人（须为 members 之一）；不一致 → 队伍作废。
// 中标收益不再按比例分配，下一回合开始时全额打给 payee，队内分配走自由转账。
export type SubmissionEntry =
  | { domain: 'ENGINEERING'; teamId: string; members: SeatId[]; payee: SeatId; ability: number; bid: number; qualificationUsed?: Qualification }
  | { domain: 'COMMERCE';    teamId: string; members: SeatId[]; payee: SeatId; funds: number; ability: number }
  | { domain: 'WAR';         teamId: string; members: SeatId[]; payee: SeatId; funds: number; ability: number; qualificationUsed?: Qualification }
  | { domain: 'ADMIN';       ability: number; qualificationUsed?: Qualification }
  | { domain: 'CRISIS';      funds: number; ability: number };

// ── TDD-001 §4.4 契约（阶段 2 实现，类型先建全）────────────────────────

export type ContractTier = 'NOTARIZED' | 'MEMO';

export interface ContractBase {
  contractId: string;
  tier: ContractTier;
  registeredRound: Round;
  registeredAt: number;           // 单调递增序号，决定同触发点执行顺序
  parties: [SeatId, SeatId];      // 当事人；V1 只允许双方
  witnesses: SeatId[];            // 登记时在同一谈话中的第三方，仅记录
  status: ContractStatus;
}

export interface NotarizedContract extends ContractBase {
  tier: 'NOTARIZED';
  trigger: Trigger;               // TDD-001 §5.2
  payer: SeatId;
  payee: SeatId;
  amount: number;
  escrowed: boolean;              // TDD-001 §5.4
  expiresRound: Round;            // 含；到期未触发则 VOID
  feeSplit: [number, number];     // 登记费 5 的分摊，按 parties 顺序，和为 5
}

export interface MemoContract extends ContractBase {
  tier: 'MEMO';
  summary: string;                // 自由文本，≤ 140 字，对系统无语义
  kind: 'GENERAL' | 'INTEL_RELAY';
  intelClaim?: IntelClaim;        // kind = INTEL_RELAY 时必填，TDD-001 §5.8
  // TDD-002 §9.1 CR-1：情报提供方。parties 是无向的，缺了它就分不出谁在卖情报，
  // 【信息垄断】【谣言制造者】【知识就是力量】三条自动档成就都无法判定。
  relayFrom?: SeatId;             // kind = INTEL_RELAY 时必填，须 ∈ parties
  accusations: Accusation[];
}

export type Contract = NotarizedContract | MemoContract;

export type ContractStatus =
  | 'ACTIVE' | 'FULFILLED' | 'DEFAULTED' | 'PARTIAL_DEFAULT'
  | 'VOID' | 'CANCELLED'          // NOTARIZED
  | 'OPEN' | 'DISPUTED';          // MEMO

// TDD-001 §5.2 触发条件枚举（封闭；新增条件必须先改 TDD）
export type Trigger =
  | { kind: 'PROJECT_RESULT';      round: Round; domain: Exclude<Domain, 'CRISIS'>; result: 'SUCCESS' | 'FAIL' | 'NO_AWARD' }
  | { kind: 'PLAYER_AWARDED';      round: Round; domain: Exclude<Domain, 'CRISIS'>; seat: SeatId; awarded: boolean }
  | { kind: 'CRISIS_RESULT';       round: Round; result: 'SUCCESS' | 'FAIL' }
  | { kind: 'CRISIS_CONTRIBUTION'; round: Round; seat: SeatId; resource: 'FUNDS' | 'ABILITY'; atLeast: number }
  | { kind: 'ROUND_START';         round: Round }
  | { kind: 'QUALIFICATION_GAINED'; seat: SeatId; kind_: Exclude<Qualification, 'NONE' | 'CORE'>; byRound: Round };

// TDD-001 §5.7 备忘契约的指控与反驳
export interface Accusation {
  round: Round;
  by: SeatId;                     // 必须是 parties 之一
  statement: string;              // ≤ 140 字
  rebuttal?: { round: Round; statement: string };
}

// ── TDD-001 §4.5 情报揭示与谈话边 ─────────────────────────────────────

export interface IntelReveal {
  seatId: SeatId;
  round: Round;                   // 使用情报权的回合
  target: { round: Round; domain: Domain };
  field: RevealableField;         // 引擎从尚未向该玩家揭示的字段中随机选一
  value: string | number;
}

export type RevealableField = 'name' | 'entry' | 'minFunds' | 'minAbility' | 'reward' | 'risk' | 'slots' | 'auditOrder';

export interface IntelClaim {
  target: { round: Round; domain: Domain };
  field: RevealableField;
  claimedValue: string | number;
}

export interface ConversationEdge {
  round: Round;
  phase: Phase;
  participants: SeatId[];         // ≥ 2
  startedAt: number;
  endedAt?: number;
}

// ── TDD-001 §4.6 记录类 ───────────────────────────────────────────────

export interface ProjectRecord { round: Round; domain: Domain; }
export interface Stamp { round: Round; source: Domain; }          // 每人每回合 ≤ 1
export interface DefaultRecord {                                  // 公开
  round: Round;
  contractId: string;
  payee: SeatId;
  owed: number;
  paid: number;
  shortfall: number;
}

// ── TDD-001 §8.1 事件 ────────────────────────────────────────────────
// 事件类型名与 §8.1 完全一致；引擎不新增类型。payload 结构 §8.1 未规定，为引擎实现细节。

export type EventType =
  | 'TRANSFER'
  | 'CONTRACT_REGISTERED' | 'CONTRACT_CANCELLED' | 'CONTRACT_TRIGGERED'
  | 'CONTRACT_FULFILLED' | 'CONTRACT_DEFAULTED' | 'CONTRACT_VOID'
  | 'MEMO_REGISTERED' | 'MEMO_ACCUSED' | 'MEMO_REBUTTED'
  | 'INTEL_USED' | 'INTEL_REVEALED' | 'INTEL_CLAIM_VERIFIED'
  | 'CONVERSATION_OPENED' | 'CONVERSATION_CLOSED'
  | 'SUBMISSION_LOCKED' | 'RNG_DRAWN'
  | 'PROJECT_RESOLVED' | 'CRISIS_RESOLVED' | 'PAYOUT' | 'PENALTY'
  | 'RECORD_GRANTED' | 'STAMP_GRANTED' | 'QUALIFICATION_QUEUED' | 'QUALIFICATION_APPLIED'
  | 'SEAT_CONNECTED' | 'SEAT_DISCONNECTED' | 'SEAT_TOKEN_REISSUED'
  | 'ACHIEVEMENT_AUTO' | 'ACHIEVEMENT_NOMINATED' | 'GAME_END'
  // TDD-002 新增：§9.2 CR-2 的承诺事件，与 §3 / §7.3 的终局流程事件
  | 'CRISIS_PLEDGED' | 'BALLOT_OPENED' | 'GAME_ENDING_RESOLVED';

export type Visibility = 'PUBLIC' | 'PARTIES' | 'SEAT' | 'HOST';

export interface GameEvent {
  seq: number;
  round: Round | 0;               // 0 = 开局（洗牌等发生在第 1 回合开始前）
  phase: Phase;
  type: EventType;
  visibility: Visibility;
  payload: Record<string, unknown>;
}
