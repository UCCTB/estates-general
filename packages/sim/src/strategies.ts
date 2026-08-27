// 12 个最简脚本化策略。固定同盟：
//   战争 A 队 = 国王 + 骑士（核心资格 +60）；战争 B 队 = 王后 + 贵族（双组织资格 +60）
//   工程 = 行会师傅 + 工匠（高报价）vs 农民独包（最低合法报价）
//   商业 = 商人 + 市民（出资凑最低门槛，全能力压风险）
//   行政 = 学者 / 书记官个人申请；主教能力不足从不达标（观察指标之一）
//   危机 = 除商人外各座位捐出剩余能力，部分座位捐 10 资金
// 无资格座位在 印章 ≥ 2 且余钱 ≥ 20 时购买基础资格。
// 策略不预测对手行为（落选战争队照常损失 20% 动员资金——这是可观察的设计后果）。
import type {
  Domain, Game, Identity, Qualification, SeatId, Submission, SubmissionEntry,
} from '@estates/engine';
import { entrySatisfiedByOne } from '@estates/engine';

interface Budget { funds: number; ability: number; }

class Planner {
  private budgets = new Map<SeatId, Budget>();
  private entries = new Map<SeatId, SubmissionEntry[]>();
  private purchases = new Set<SeatId>();

  constructor(private state: Game) {
    for (const k of Object.keys(state.seats).map(Number) as SeatId[]) {
      const seat = state.seats[k];
      this.budgets.set(k, { funds: seat.funds, ability: seat.abilityBase });
    }
  }

  seatOf(identity: Identity): SeatId {
    for (const k of Object.keys(this.state.seats).map(Number) as SeatId[]) {
      if (this.state.seats[k].identity === identity) return k;
    }
    throw new Error(`身份不存在：${identity}`);
  }

  budget(seatId: SeatId): Budget {
    return this.budgets.get(seatId)!;
  }

  // 座位当前持有且本回合未占用的资格（策略视角 = 尚未在本计划中声明过）
  heldQual(seatId: SeatId): Qualification | undefined {
    const used = (this.entries.get(seatId) ?? [])
      .flatMap((e) => ('qualificationUsed' in e && e.qualificationUsed !== undefined ? [e.qualificationUsed] : []));
    const q = this.state.seats[seatId].qualifications.find((x) => !used.includes(x.kind));
    return q?.kind;
  }

  add(seatId: SeatId, entry: SubmissionEntry): void {
    const b = this.budget(seatId);
    const funds = 'funds' in entry ? entry.funds : 0;
    if (funds > b.funds || entry.ability > b.ability) throw new Error(`策略超支：seat ${seatId}`);
    b.funds -= funds;
    b.ability -= entry.ability;
    const list = this.entries.get(seatId) ?? [];
    list.push(entry);
    this.entries.set(seatId, list);
  }

  buyQualificationIfSensible(seatId: SeatId): void {
    const seat = this.state.seats[seatId];
    const b = this.budget(seatId);
    if (seat.qualifications.length === 0 && seat.stamps.length >= 2 && b.funds >= 20 && this.state.round < 6) {
      b.funds -= 20;
      this.purchases.add(seatId);
    }
  }

  build(): Submission[] {
    const subs: Submission[] = [];
    for (const k of Object.keys(this.state.seats).map(Number) as SeatId[]) {
      const entries = this.entries.get(k) ?? [];
      const purchase = this.purchases.has(k);
      if (entries.length === 0 && !purchase) continue;
      const sub: Submission = { seatId: k, round: this.state.round, entries };
      if (purchase) sub.qualificationPurchase = true;
      subs.push(sub);
    }
    return subs;
  }
}

function card(state: Game, domain: Domain) {
  return state.decks[domain][state.round - 1]!;
}

export function buildSubmissions(state: Game): Submission[] {
  const p = new Planner(state);
  const round = state.round;

  const KING = p.seatOf('KING'), QUEEN = p.seatOf('QUEEN'), BISHOP = p.seatOf('BISHOP');
  const KNIGHT = p.seatOf('KNIGHT'), NOBLE = p.seatOf('NOBLE'), CLERK = p.seatOf('CLERK');
  const MERCHANT = p.seatOf('MERCHANT'), GUILD = p.seatOf('GUILD_MASTER'), SCHOLAR = p.seatOf('SCHOLAR');
  const BURGHER = p.seatOf('BURGHER'), ARTISAN = p.seatOf('ARTISAN'), PEASANT = p.seatOf('PEASANT');

  // ── 战争 ──────────────────────────────────────────────
  const war = card(state, 'WAR');
  const warTeam = (teamId: string, members: [SeatId, SeatId]) => {
    const [a, b] = members;
    const ab = p.budget(a), bb = p.budget(b);
    const totalAbility = ab.ability + bb.ability;
    const totalFunds = ab.funds + bb.funds;
    if (totalAbility < war.minAbility! || totalFunds < war.minFunds!) return;
    const aFunds = Math.min(ab.funds, war.minFunds!);
    const bFunds = war.minFunds! - aFunds;
    const sorted: SeatId[] = [...members].sort((x, y) => x - y);
    const mk = (seatId: SeatId, funds: number, ability: number): SubmissionEntry => {
      const q = p.heldQual(seatId);
      // 收款人 = 牵头者（成员 a）；收益下一回合到账后由其转分（本模拟器不做转账，全归牵头者）
      const e: SubmissionEntry = { domain: 'WAR', teamId, members: sorted, payee: a, funds, ability };
      if (q !== undefined && q !== 'NONE') (e as { qualificationUsed?: Qualification }).qualificationUsed = q;
      return e;
    };
    p.add(a, mk(a, aFunds, ab.ability));
    p.add(b, mk(b, bFunds, bb.ability));
  };
  warTeam(`war-crown-r${round}`, [KING, KNIGHT]);
  warTeam(`war-court-r${round}`, [QUEEN, NOBLE]);

  // ── 工程 ──────────────────────────────────────────────
  const eng = card(state, 'ENGINEERING');
  const minBid = Math.ceil(eng.budgetCap! * 0.5);
  // 农民独包：全部能力投入，报最低合法价（即便不达标也提交——「农民全投工程」）
  {
    const b = p.budget(PEASANT);
    if (b.ability > 0) {
      const q = p.heldQual(PEASANT);
      const e: SubmissionEntry = {
        domain: 'ENGINEERING', teamId: `eng-peasant-r${round}`, members: [PEASANT], payee: PEASANT,
        ability: b.ability, bid: minBid,
      };
      if (q !== undefined && q !== 'NONE') (e as { qualificationUsed?: Qualification }).qualificationUsed = q;
      p.add(PEASANT, e);
    }
  }
  // 行会队：能力够门槛才投，报预算上限的 80%
  {
    const gb = p.budget(GUILD), abg = p.budget(ARTISAN);
    const totalAbility = gb.ability + abg.ability;
    if (totalAbility >= eng.minAbility!) {
      const bid = Math.max(minBid, Math.floor(eng.budgetCap! * 0.8));
      const teamId = `eng-guild-r${round}`;
      const members: SeatId[] = [GUILD, ARTISAN].sort((x, y) => x - y);
      const gq = p.heldQual(GUILD);
      const ge: SubmissionEntry = { domain: 'ENGINEERING', teamId, members, payee: GUILD, ability: gb.ability, bid };
      if (gq !== undefined && gq !== 'NONE') (ge as { qualificationUsed?: Qualification }).qualificationUsed = gq;
      p.add(GUILD, ge);
      p.add(ARTISAN, { domain: 'ENGINEERING', teamId, members, payee: GUILD, ability: abg.ability, bid });
    }
  }

  // ── 商业 ──────────────────────────────────────────────
  const com = card(state, 'COMMERCE');
  {
    const mb = p.budget(MERCHANT), bb = p.budget(BURGHER);
    const totalAbility = mb.ability + bb.ability;
    // 市民留 10 资金给危机；商人出资优先
    const burgherFundsAvail = Math.max(0, bb.funds - 10);
    if (totalAbility >= com.minAbility! && mb.funds + burgherFundsAvail >= com.minFunds!) {
      const mFunds = Math.min(mb.funds, com.minFunds!);
      const bFunds = com.minFunds! - mFunds;
      const teamId = `com-hansa-r${round}`;
      const members: SeatId[] = [MERCHANT, BURGHER].sort((x, y) => x - y);
      p.add(MERCHANT, { domain: 'COMMERCE', teamId, members, payee: MERCHANT, funds: mFunds, ability: mb.ability });
      p.add(BURGHER, { domain: 'COMMERCE', teamId, members, payee: MERCHANT, funds: bFunds, ability: bb.ability });
    }
  }

  // ── 行政 ──────────────────────────────────────────────
  const adm = card(state, 'ADMIN');
  const applyAdmin = (seatId: SeatId) => {
    const b = p.budget(seatId);
    if (b.ability < adm.minAbility!) return;
    const q = p.heldQual(seatId);
    const usable = q !== undefined && q !== 'NONE' ? q : undefined;
    if (!entrySatisfiedByOne(adm.entry, usable)) return;
    const e: SubmissionEntry = { domain: 'ADMIN', ability: b.ability };
    if (usable !== undefined) (e as { qualificationUsed?: Qualification }).qualificationUsed = usable;
    p.add(seatId, e);
  };
  applyAdmin(SCHOLAR);
  applyAdmin(CLERK);
  applyAdmin(BISHOP);   // 能力 20，永不达标——保留以观察「主教废卡」问题（规则书 §27 Q2）

  // ── 资格购买（危机捐助之前）─────────────────────────────
  for (const seatId of [MERCHANT, SCHOLAR, ARTISAN, PEASANT]) p.buyQualificationIfSensible(seatId);

  // ── 危机 ──────────────────────────────────────────────
  const donors: { seatId: SeatId; funds: number }[] = [
    { seatId: KING, funds: 0 }, { seatId: QUEEN, funds: 10 }, { seatId: BISHOP, funds: 10 },
    { seatId: KNIGHT, funds: 0 }, { seatId: NOBLE, funds: 10 }, { seatId: CLERK, funds: 0 },
    { seatId: GUILD, funds: 0 }, { seatId: SCHOLAR, funds: 0 }, { seatId: BURGHER, funds: 10 },
    { seatId: ARTISAN, funds: 0 }, { seatId: PEASANT, funds: 0 },
    // 商人不捐（搭便车者——规则书 §27 Q7 的观察对象）
  ];
  for (const d of donors) {
    const b = p.budget(d.seatId);
    const funds = Math.min(d.funds, b.funds);
    const ability = b.ability;
    if (funds > 0 || ability > 0) {
      p.add(d.seatId, { domain: 'CRISIS', funds, ability });
    }
  }

  return p.build();
}
