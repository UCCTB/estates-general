// 情报权（规则书 §5.3 / TDD-001 §4.5 / §10.2）与情报转述终局验证（§5.8）。
import { describe, expect, it } from 'vitest';
import type { Game } from '../src/types.js';
import { fieldValue, useIntel, verifyIntelClaims } from '../src/intel.js';
import { registerMemoContract } from '../src/contracts.js';
import { beginNegotiation } from '../src/phases.js';
import { lockSubmissions } from '../src/validate.js';
import { settle } from '../src/settle.js';
import { roundStart } from '../src/roundStart.js';
import { readyState, seatByIdentity } from './helpers.js';

describe('useIntel', () => {
  it('消耗 1 次，揭示下一回合该领域卡的一个真实字段（SEAT 可见）', () => {
    const s = readyState();
    const scholar = seatByIdentity(s, 'SCHOLAR');   // 情报权 5
    const r = useIntel(s, scholar, 'COMMERCE');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.seats[scholar].intel).toBe(4);
    const card = r.state.decks.COMMERCE[1]!;   // 第 2 回合的卡
    expect(r.value).toBe(fieldValue(card, r.state.auditOrders, 2, r.field));
    const revealed = r.events.find((e) => e.type === 'INTEL_REVEALED')!;
    expect(revealed.visibility).toBe('SEAT');
    expect(r.events.some((e) => e.type === 'INTEL_USED' && e.visibility === 'PUBLIC')).toBe(true);
    expect(r.state.intelReveals).toHaveLength(1);
  });

  it('同一项目不重复揭示；字段耗尽 → 拒绝且不消耗（§10.2）', () => {
    // 主教情报权 4；工程卡可揭示字段仅 name/entry/minAbility 共 3 个
    let s: Game = readyState();
    const bishop = seatByIdentity(s, 'BISHOP');
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = useIntel(s, bishop, 'ENGINEERING');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      seen.push(r.field);
      s = r.state;
    }
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual(['entry', 'minAbility', 'name']);
    const r4 = useIntel(s, bishop, 'ENGINEERING');
    expect(r4.ok).toBe(false);
    if (r4.ok) return;
    expect(r4.reason).toContain('不消耗');
    expect(s.seats[bishop].intel).toBe(4 - 3);   // 第 4 次未消耗
  });

  it('ADMIN 目标含 auditOrder；揭示值与卡面/审查令直读一致（独立对拍，不经 fieldValue）', () => {
    const s = readyState();
    const scholar = seatByIdentity(s, 'SCHOLAR');
    s.seats[scholar].intel = 10;   // 行政卡可揭示字段 6 个，超出学者初始 5 次
    let cur: Game = s;
    const got = new Map<string, string | number>();
    for (;;) {
      const r = useIntel(cur, scholar, 'ADMIN');
      if (!r.ok) break;
      got.set(r.field, r.value);
      cur = r.state;
    }
    expect(got.size).toBe(6);   // name/entry/minAbility/reward/slots/auditOrder
    const card = s.decks.ADMIN[1]!;   // 第 2 回合行政卡（直读数据，不调用被测函数）
    expect(got.get('name')).toBe(card.name);
    expect(got.get('minAbility')).toBe(card.minAbility);
    expect(got.get('reward')).toBe(card.reward);
    expect(got.get('slots')).toBe(card.slots);
    expect(got.get('auditOrder')).toBe(s.auditOrders[1]);   // 下一回合的审查令，直读牌堆
    expect(typeof got.get('entry')).toBe('string');
  });

  it('危机卡的资金/能力要求可经 minFunds/minAbility 揭示（issues #17 映射）', () => {
    const s = readyState();
    const scholar = seatByIdentity(s, 'SCHOLAR');
    s.seats[scholar].intel = 10;
    let cur: Game = s;
    const got = new Map<string, string | number>();
    for (;;) {
      const r = useIntel(cur, scholar, 'CRISIS');
      if (!r.ok) break;
      got.set(r.field, r.value);
      cur = r.state;
    }
    const card = s.decks.CRISIS[1]!;
    expect(got.get('minFunds')).toBe(card.fundsTarget);
    expect(got.get('minAbility')).toBe(card.abilityTarget);
  });

  it('阶段与回合边界：谈判阶段拒绝；第 6 回合拒绝；次数不足拒绝', () => {
    const s = readyState();
    const scholar = seatByIdentity(s, 'SCHOLAR');
    expect(useIntel(beginNegotiation(s), scholar, 'WAR').ok).toBe(false);
    const s6 = readyState();
    s6.round = 6;
    expect(useIntel(s6, scholar, 'WAR').ok).toBe(false);
    const knight = seatByIdentity(s, 'KNIGHT');   // 情报权 0
    expect(useIntel(s, knight, 'WAR').ok).toBe(false);
  });
});

describe('verifyIntelClaims（§5.8：局中不揭示，终局批量比对）', () => {
  it('诚实转述 truthful=true；伪造 truthful=false；重复调用不重复发事件', () => {
    let s = beginNegotiation(readyState());
    const scholar = seatByIdentity(s, 'SCHOLAR');
    const merchant = seatByIdentity(s, 'MERCHANT');
    const bishop = seatByIdentity(s, 'BISHOP');
    const queen = seatByIdentity(s, 'QUEEN');
    const honestValue = s.decks.COMMERCE[1]!.minFunds!;
    const honest = registerMemoContract(s, {
      parties: [scholar, merchant], summary: '下回合商业最低出资', kind: 'INTEL_RELAY',
      intelClaim: { target: { round: 2, domain: 'COMMERCE' }, field: 'minFunds', claimedValue: honestValue },
      relayFrom: scholar,
    });
    expect(honest.ok).toBe(true);
    if (!honest.ok) return;
    s = honest.state;
    const lie = registerMemoContract(s, {
      parties: [bishop, queen], summary: '下回合战争要 999 资金', kind: 'INTEL_RELAY',
      intelClaim: { target: { round: 2, domain: 'WAR' }, field: 'minFunds', claimedValue: 999 },
      relayFrom: bishop,
    });
    expect(lie.ok).toBe(true);
    if (!lie.ok) return;
    s = lie.state;

    // 跑完 6 回合到 GAME_END
    for (let r = 1; r <= 6; r++) {
      const lock = lockSubmissions(s, []);
      s = settle(lock.state, lock.accepted, s.seed).state;
      if (r < 6) s = beginNegotiation(roundStart(s).state);
    }
    expect(s.phase).toBe('GAME_END');

    const v = verifyIntelClaims(s);
    const verdicts = v.events.filter((e) => e.type === 'INTEL_CLAIM_VERIFIED');
    expect(verdicts).toHaveLength(2);
    const byContract = new Map(verdicts.map((e) => [e.payload['contractId'], e.payload['truthful']]));
    expect(byContract.get('C001')).toBe(true);
    expect(byContract.get('C002')).toBe(false);
    // 幂等：已验证的不再发
    const again = verifyIntelClaims(v.state);
    expect(again.events).toHaveLength(0);
  });
});
