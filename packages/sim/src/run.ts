// 跑一整局（阶段 2）：initGame → (roundStart → 情报 → 谈判[契约/转账] → lockSubmissions → settle) × 6
//                    → finalStanding + verifyIntelClaims。
// 输出完全确定（同 seed 逐字节相同）：不含时间戳，不用 Math.random。
// 指标对应规则书 §26 中可数值化部分；契约/借贷/情报交易指标由阶段 2 谈判脚本产生。
import type { Game, GameEvent, Identity, Qualification, SettleResults } from '@estates/engine';
import {
  beginNegotiation, finalStanding, initGame, lockSubmissions, roundStart, settle, verifyIntelClaims,
} from '@estates/engine';
import { buildSubmissions } from './strategies.js';
import { runIntelPhase, runNegotiation } from './negotiation.js';

const IDENTITY_ZH: Record<Identity, string> = {
  KING: '国王', QUEEN: '王后', BISHOP: '主教', KNIGHT: '骑士', NOBLE: '贵族', CLERK: '书记官',
  MERCHANT: '商人', GUILD_MASTER: '行会师傅', SCHOLAR: '学者', BURGHER: '市民', ARTISAN: '工匠', PEASANT: '农民',
};
const QUAL_ZH: Record<Qualification, string> = {
  NONE: '无', BASIC: '基础', ENGINEERING: '工程', ADMIN: '行政', ORG: '组织', CORE: '核心',
};
const AUDIT_ZH = { RECORD_FIRST: '履历优先', QUALIFICATION_FIRST: '资格优先', PRACTICE_FIRST: '实务优先' } as const;

function totalFunds(state: Game): number {
  // 含在途收益（中标奖金下一回合到账），保证守恒读数连贯
  return (Object.values(state.seats) as { funds: number; lockedFunds: number }[])
    .reduce((a, s) => a + s.funds + s.lockedFunds, 0)
    + state.pendingPayouts.reduce((a, p) => a + p.amount, 0);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// 把契约相关事件译成日志行
function logContractEvents(state: Game, events: GameEvent[], lines: string[]): void {
  const zh = (k: number) => IDENTITY_ZH[state.seats[k as 1].identity];
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case 'CONTRACT_FULFILLED':
        lines.push(`  [履约] ${p['contractId']} ${zh(p['payer'] as number)}→${zh(p['payee'] as number)} ${p['amount']}${p['escrowed'] === true ? '（托管转付）' : ''}`);
        break;
      case 'CONTRACT_DEFAULTED':
        lines.push(`  [失信] ${p['contractId']} ${zh(p['payer'] as number)} 欠 ${zh(p['payee'] as number)} ${p['owed']}，只付 ${p['paid']}，短缺 ${p['shortfall']}`);
        break;
      case 'CONTRACT_VOID':
        lines.push(`  [作废] ${p['contractId']}（${p['reason']}）`);
        break;
      case 'PAYOUT':
        if (p['kind'] === 'REWARD' && p['awardedRound'] !== undefined) {
          lines.push(`  [到账] ${zh(p['seatId'] as number)} 收到第 ${p['awardedRound']} 回合${p['source']}收益 ${p['amount']}`);
        }
        break;
      default:
        break;
    }
  }
}

export function runGame(seed: string): string {
  const lines: string[] = [];
  let { state } = initGame(`sim-${seed}`, seed);

  lines.push('=== 《三级会议》纯文本模拟器（阶段 2）===');
  lines.push(`seed: ${seed}`);
  lines.push(`seedCommitment: ${state.seedCommitment}`);
  lines.push(`初始资金总和: ${totalFunds(state)}`);

  const m = {
    teamsPerDomain: { WAR: 0, ENGINEERING: 0, COMMERCE: 0 },
    adminApplicants: 0,
    crisisContributors: 0,
    engWinningBids: [] as number[],
    comRisks: [] as number[],
    comAttempts: 0,
    comFails: 0,
    crisisSuccesses: 0,
  };

  for (let r = 1; r <= 6; r++) {
    const rs = roundStart(state);
    state = rs.state;
    for (const e of rs.events) {
      if (e.type === 'QUALIFICATION_APPLIED') {
        const p = e.payload as { seatId: number; kind: Qualification; viaPurchase: boolean };
        const id = state.seats[p.seatId as 1].identity;
        lines.push(`  [资格生效] ${IDENTITY_ZH[id]} 取得 ${QUAL_ZH[p.kind]}${p.viaPurchase ? '（购买）' : '（晋升）'}`);
      }
    }
    logContractEvents(state, rs.events, lines);

    // 情报 → 谈判（契约 / 转账 / 指控）
    state = runIntelPhase(state, lines);
    state = beginNegotiation(state);
    state = runNegotiation(state, lines);

    const subs = buildSubmissions(state);
    const lock = lockSubmissions(state, subs);
    state = lock.state;
    for (const rej of lock.rejected) {
      lines.push(`  [校验拒绝] 座位 ${rej.seatId}: ${rej.reason}`);
    }

    const settled = settle(state, lock.accepted, seed);
    state = settled.state;
    const res: SettleResults = settled.results;

    lines.push(`--- 回合 ${r} ---`);
    lines.push(`卡面: 战争=${res.war.card.name} 工程=${res.engineering.card.name} 商业=${res.commerce.card.name}`
      + ` 行政=${res.admin.card.name}(${AUDIT_ZH[res.admin.auditOrder]}) 危机=${res.crisis.card.name}`);

    const teamDesc = (t: { teamId: string; members: number[] } | null) =>
      t ? `${t.teamId}[${t.members.join(',')}]` : '无';
    lines.push(`工程: ${res.engineering.winner ? `中标 ${teamDesc(res.engineering.winner)} 报价 ${res.engineering.payout}` : 'NO_AWARD'}`
      + `（申报 ${res.engineering.teams.length} 队）`);
    lines.push(`战争: ${res.war.winner ? `中标 ${teamDesc(res.war.winner)} 报酬 ${res.war.payout}` : 'NO_AWARD'}`
      + `（申报 ${res.war.teams.length} 队）`);
    lines.push(`商业: ${res.commerce.winner
      ? `${res.commerce.result} 中标 ${teamDesc(res.commerce.winner)} R'=${res.commerce.effectiveRisk} 骰=${res.commerce.dice} 收益 ${res.commerce.payout}`
      : 'NO_AWARD'}（申报 ${res.commerce.teams.length} 队）`);
    lines.push(`行政: ${res.admin.selected.length > 0 ? `录取 [${res.admin.selected.join(',')}] 各得 ${res.admin.payoutEach} 资金 + ${res.admin.intelEach} 情报权` : 'NO_AWARD'}`
      + `（申请 ${res.admin.applicants.length} 人）`);
    const contribCount = Object.keys(res.crisis.contributions).length;
    lines.push(`危机: ${res.crisis.result} 资金 ${res.crisis.totalFunds}/${res.crisis.card.fundsTarget}`
      + ` 能力 ${res.crisis.totalAbility}/${res.crisis.card.abilityTarget}`
      + (res.crisis.result === 'FAIL' ? ` → 全员 -${res.crisis.card.failPenalty}` : '')
      + `（贡献 ${contribCount} 人）`);
    logContractEvents(state, settled.events, lines);
    lines.push(`资金总和: ${totalFunds(state)}`);

    m.teamsPerDomain.WAR += res.war.teams.length;
    m.teamsPerDomain.ENGINEERING += res.engineering.teams.length;
    m.teamsPerDomain.COMMERCE += res.commerce.teams.length;
    m.adminApplicants += res.admin.applicants.length;
    m.crisisContributors += contribCount;
    if (res.engineering.winner) m.engWinningBids.push(res.engineering.payout);
    if (res.commerce.winner) {
      m.comAttempts += 1;
      m.comRisks.push(res.commerce.effectiveRisk!);
      if (res.commerce.result === 'FAIL') m.comFails += 1;
    }
    if (res.crisis.result === 'SUCCESS') m.crisisSuccesses += 1;
  }

  // ── 终局 ──
  const verified = verifyIntelClaims(state);
  state = verified.state;
  const standing = finalStanding(state);
  lines.push('=== 终局 ===');
  lines.push(`过线人数 Q = ${standing.passCount}`);
  lines.push('身份\t座位\t资金\t印章(计入)\t记录\t资格\t失信\t过线\t名次');
  const orderedRows = [...standing.rows].sort((a, b) => a.seatId - b.seatId);
  for (const row of orderedRows) {
    const defaults = state.seats[row.seatId].defaults.length;
    lines.push(`${IDENTITY_ZH[row.identity]}\t${row.seatId}\t${row.funds}\t${row.stampsTotal}(${row.stampsEffective})`
      + `\t${row.recordsTotal}\t${QUAL_ZH[row.highestQualification]}\t${defaults}\t${row.qualified ? '是' : '否'}`
      + `\t${row.rank !== null ? row.rank + (row.winner ? '' : '（过线仍淘汰）') : '-'}`);
  }
  for (const e of verified.events) {
    const p = e.payload;
    lines.push(`[情报核验] ${p['contractId']} 声称 ${String(p['claimedValue'])}，真值 ${String(p['actualValue'])} → ${p['truthful'] === true ? '属实' : '谣言'}`);
  }

  // ── 观察指标（规则书 §26 可数值化部分）──
  const avg = (arr: number[]) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);
  lines.push('=== 观察指标（规则书 §26 可数值化部分）===');
  lines.push(`平均申报队伍/申请数: 战争 ${fmt(m.teamsPerDomain.WAR / 6)} 工程 ${fmt(m.teamsPerDomain.ENGINEERING / 6)}`
    + ` 商业 ${fmt(m.teamsPerDomain.COMMERCE / 6)} 行政 ${fmt(m.adminApplicants / 6)} 危机 ${fmt(m.crisisContributors / 6)}`);
  const bidAvg = avg(m.engWinningBids);
  lines.push(`工程平均中标价格: ${bidAvg === null ? '（无中标）' : fmt(bidAvg)}`);
  const riskAvg = avg(m.comRisks);
  lines.push(`商业平均风险值(R'): ${riskAvg === null ? '（无中标）' : fmt(riskAvg)}`);
  lines.push(`商业失败率: ${m.comAttempts === 0 ? '（无中标）' : `${m.comFails}/${m.comAttempts}`}`);
  lines.push(`公共危机成功率: ${m.crisisSuccesses}/6`);

  const notarized = state.contracts.filter((c) => c.tier === 'NOTARIZED');
  const memos = state.contracts.filter((c) => c.tier === 'MEMO');
  const count = (st: string) => notarized.filter((c) => c.status === st).length;
  lines.push(`正式契约数量: ${notarized.length}`
    + `（履行 ${count('FULFILLED')} / 部分失信 ${count('PARTIAL_DEFAULT')} / 全额失信 ${count('DEFAULTED')}`
    + ` / 作废 ${count('VOID')} / 取消 ${count('CANCELLED')}）`);
  const totalDefaults = (Object.values(state.seats) as { defaults: unknown[] }[])
    .reduce((a, s) => a + s.defaults.length, 0);
  lines.push(`公开失信记录: ${totalDefaults} 条`);
  lines.push(`备忘契约: ${memos.length} 份（指控 ${state.events.filter((e) => e.type === 'MEMO_ACCUSED').length}`
    + ` / 反驳 ${state.events.filter((e) => e.type === 'MEMO_REBUTTED').length}）`);
  lines.push(`非正式转账（借贷/投资）: ${state.events.filter((e) => e.type === 'TRANSFER').length} 笔`);
  lines.push(`情报使用: ${state.events.filter((e) => e.type === 'INTEL_USED').length} 次；`
    + `情报转述: ${memos.filter((c) => c.kind === 'INTEL_RELAY').length} 份`
    + `（属实 ${verified.events.filter((e) => e.payload['truthful'] === true).length}`
    + ` / 谣言 ${verified.events.filter((e) => e.payload['truthful'] === false).length}）`);
  lines.push('联盟/中介涌现指标: 不适用（脚本策略无自由意志，留待真人试玩）');

  return lines.join('\n');
}
