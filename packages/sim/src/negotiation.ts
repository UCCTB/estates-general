// 谈判脚本（阶段 2）：确定性的契约 / 转账 / 情报行为，让契约机制产生可观测输出。
// 剧本：
//   情报阶段：学者每回合侦察下一回合商业卡（有次数就用）
//   r1：国王给骑士登记托管军饷（下回合 5）；贵族-农民登记借贷备忘（GENERAL）；
//       学者向商人卖真情报（INTEL_RELAY 诚实）；主教向王后卖假情报（INTEL_RELAY 伪造）
//   每回合 r<6：贵族放贷农民——转账 15，登记「下回合开始农民还 20」（高杠杆：农民常还不上 → 失信）
//   每回合：贵族投资商人——转账 10，登记「本回合商业成功商人付 15」（结算类触发；
//       注意收益下一回合才到账，商人可能被迫部分失信——设计后果的活样本）
//   农民首次失信后：贵族在备忘上指控一次，农民反驳一次
//   每回合末：12 席按各自即将提交的危机贡献登记公开承诺（TDD-002 §9.2 CR-2），
//       国王额外虚报 30 资金——一个照着规则书 §17.3 造出来的搭便车样本
import type { Game, MemoContract, Round, SeatId } from '@estates/engine';
import {
  accuseMemoContract, pledgeCrisis, rebutMemoContract, registerMemoContract,
  registerNotarizedContract, transfer, useIntel,
} from '@estates/engine';
import { buildSubmissions } from './strategies.js';

function seatOf(state: Game, identity: string): SeatId {
  for (const k of Object.keys(state.seats).map(Number) as SeatId[]) {
    if (state.seats[k].identity === identity) return k;
  }
  throw new Error(`身份不存在：${identity}`);
}

// 情报阶段（REVEAL_AND_INTEL）
export function runIntelPhase(state: Game, log: string[]): Game {
  let s = state;
  const scholar = seatOf(s, 'SCHOLAR');
  if (s.round < 6 && s.seats[scholar].intel > 0) {
    const r = useIntel(s, scholar, 'COMMERCE');
    if (r.ok) {
      s = r.state;
      log.push(`  [情报] 学者侦察下回合商业：${r.field} = ${r.value}（剩 ${s.seats[scholar].intel} 次）`);
    }
  }
  return s;
}

// 谈判阶段（NEGOTIATION）
export function runNegotiation(state: Game, log: string[]): Game {
  let s = state;
  const round = s.round;
  const NOBLE = seatOf(s, 'NOBLE'), PEASANT = seatOf(s, 'PEASANT'), MERCHANT = seatOf(s, 'MERCHANT');
  const KING = seatOf(s, 'KING'), KNIGHT = seatOf(s, 'KNIGHT');
  const SCHOLAR = seatOf(s, 'SCHOLAR'), BISHOP = seatOf(s, 'BISHOP'), QUEEN = seatOf(s, 'QUEEN');

  // r1：国王的托管军饷（下回合开始付骑士 5；托管进锁定，违约不可能）
  if (round === 1 && s.seats[KING].funds >= 10) {
    const r = registerNotarizedContract(s, {
      parties: [KING, KNIGHT], payer: KING, payee: KNIGHT,
      trigger: { kind: 'ROUND_START', round: 2 }, amount: 5,
      escrowed: true, expiresRound: 2, feeSplit: [5, 0],
    });
    if (r.ok) { s = r.state; log.push(`  [契约] ${r.contractId} 国王→骑士 军饷 5（托管，下回合付）`); }
  }

  // r1：借贷备忘 + 两条情报转述
  if (round === 1) {
    const memo = registerMemoContract(s, {
      parties: [NOBLE, PEASANT], summary: '贵族借农民 15，农民每回合开始还 20', kind: 'GENERAL',
    });
    if (memo.ok) { s = memo.state; log.push(`  [备忘] ${memo.contractId} 贵族-农民 借贷备忘`); }

    const honest = registerMemoContract(s, {
      parties: [SCHOLAR, MERCHANT], summary: '下回合商业最低出资（真）', kind: 'INTEL_RELAY',
      intelClaim: {
        target: { round: 2, domain: 'COMMERCE' }, field: 'minFunds',
        claimedValue: s.decks.COMMERCE[1]!.minFunds!,   // 学者刚侦察过，照实转述
      },
      relayFrom: SCHOLAR,
    });
    if (honest.ok) { s = honest.state; log.push(`  [备忘] ${honest.contractId} 学者→商人 情报转述（诚实）`); }

    const lie = registerMemoContract(s, {
      parties: [BISHOP, QUEEN], summary: '下回合战争要 999 资金（假）', kind: 'INTEL_RELAY',
      intelClaim: { target: { round: 2, domain: 'WAR' }, field: 'minFunds', claimedValue: 999 },
      relayFrom: BISHOP,
    });
    if (lie.ok) { s = lie.state; log.push(`  [备忘] ${lie.contractId} 主教→王后 情报转述（伪造）`); }
  }

  // 每回合 r<6：贵族放贷农民（转账 15 + 下回合开始还 20 的公证契约）
  if (round < 6 && s.seats[NOBLE].funds >= 20) {
    const c = registerNotarizedContract(s, {
      parties: [NOBLE, PEASANT], payer: PEASANT, payee: NOBLE,
      trigger: { kind: 'ROUND_START', round: (round + 1) as Round }, amount: 20,
      escrowed: false, expiresRound: (round + 1) as Round, feeSplit: [5, 0],
    });
    if (c.ok) {
      s = c.state;
      const t = transfer(s, NOBLE, PEASANT, 15);
      if (t.ok) {
        s = t.state;
        log.push(`  [借贷] ${c.contractId} 贵族→农民 放贷 15，下回合还 20`);
      }
    }
  }

  // 每回合：贵族投资商人（转账 10 + 本回合商业成功付 15 的结算类契约）
  if (s.seats[NOBLE].funds >= 15) {
    const c = registerNotarizedContract(s, {
      parties: [NOBLE, MERCHANT], payer: MERCHANT, payee: NOBLE,
      trigger: { kind: 'PROJECT_RESULT', round, domain: 'COMMERCE', result: 'SUCCESS' },
      amount: 15, escrowed: false, expiresRound: round, feeSplit: [5, 0],
    });
    if (c.ok) {
      s = c.state;
      const t = transfer(s, NOBLE, MERCHANT, 10);
      if (t.ok) { s = t.state; log.push(`  [投资] ${c.contractId} 贵族→商人 投 10，商业成功回 15`); }
    }
  }

  // 农民有失信记录后：贵族在借贷备忘上指控一次（仅一次），农民随即反驳
  const loanMemo = s.contracts.find((c): c is MemoContract =>
    c.tier === 'MEMO' && c.kind === 'GENERAL'
    && c.parties.includes(NOBLE) && c.parties.includes(PEASANT));
  if (loanMemo !== undefined && loanMemo.status === 'OPEN' && s.seats[PEASANT].defaults.length > 0) {
    const acc = accuseMemoContract(s, loanMemo.contractId, NOBLE, '农民欠债不还，已有公开失信记录为证');
    if (acc.ok) {
      s = acc.state;
      log.push(`  [指控] 贵族指控 ${loanMemo.contractId}：农民违约`);
      const reb = rebutMemoContract(s, loanMemo.contractId, PEASANT, '收成歉收又逢瘟疫，非不愿还，实不能也');
      if (reb.ok) { s = reb.state; log.push('  [反驳] 农民反驳指控'); }
    }
  }

  // 危机承诺（TDD-002 §9.2 CR-2）：谈判的最后一步，各自把打算投入的数额挂到公告板上。
  // 承诺不消耗资源、不强制执行，兑不兑现是信用问题——这里让 11 席说到做到，
  // 国王虚报 30 资金，好让【共同体】与【公地悲剧】两条判定都有真实样本。
  const planned = new Map<SeatId, { funds: number; ability: number }>();
  for (const sub of buildSubmissions(s)) {
    for (const e of sub.entries) {
      if (e.domain === 'CRISIS') planned.set(sub.seatId, { funds: e.funds, ability: e.ability });
    }
  }
  for (const seatId of (Object.keys(s.seats).map(Number) as SeatId[]).sort((a, b) => a - b)) {
    const p = planned.get(seatId) ?? { funds: 0, ability: 0 };
    const inflate = seatId === KING ? 30 : 0;
    const r = pledgeCrisis(s, seatId, p.funds + inflate, p.ability);
    if (r.ok) s = r.state;
  }
  const pledged = s.crisisPledges.filter((p) => p.round === round);
  const pf = pledged.reduce((a, p) => a + p.funds, 0);
  const pa = pledged.reduce((a, p) => a + p.ability, 0);
  log.push(`  [承诺] ${pledged.length} 席登记危机承诺，合计 ${pf} 资金 / ${pa} 能力（国王虚报 30）`);

  return s;
}
