// 跑一整局：initGame → (roundStart → 策略 → lockSubmissions → settle) × 6 → finalStanding。
// 输出完全确定（同 seed 逐字节相同）：不含时间戳，不用 Math.random。
// 指标对应规则书 §26 中可数值化部分；无谈判环节，涉及承诺/联盟的指标标注不适用。
import type { Game, Identity, Qualification, SettleResults } from '@estates/engine';
import {
  finalStanding, initGame, lockSubmissions, roundStart, settle,
} from '@estates/engine';
import { buildSubmissions } from './strategies.js';

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

export function runGame(seed: string): string {
  const lines: string[] = [];
  let { state } = initGame(`sim-${seed}`, seed);

  lines.push('=== 《三级会议》纯文本模拟器（阶段 1）===');
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
  const standing = finalStanding(state);
  lines.push('=== 终局 ===');
  lines.push(`过线人数 Q = ${standing.passCount}`);
  lines.push('身份\t座位\t资金\t印章(计入)\t记录\t资格\t过线\t名次');
  const orderedRows = [...standing.rows].sort((a, b) => a.seatId - b.seatId);
  for (const row of orderedRows) {
    lines.push(`${IDENTITY_ZH[row.identity]}\t${row.seatId}\t${row.funds}\t${row.stampsTotal}(${row.stampsEffective})`
      + `\t${row.recordsTotal}\t${QUAL_ZH[row.highestQualification]}\t${row.qualified ? '是' : '否'}`
      + `\t${row.rank !== null ? row.rank + (row.winner ? '' : '（过线仍淘汰）') : '-'}`);
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
  lines.push('正式契约数量: 0（契约系统属阶段 2）');
  lines.push('承诺-实际贡献差额 / 借贷 / 情报交易 / 联盟指标: 不适用（模拟器无自由磋商环节）');

  return lines.join('\n');
}
