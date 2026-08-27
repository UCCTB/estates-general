// 规则书 §15.2 教会与公共危机列表。失败处罚为全员扣减资金（下限 0，TDD-001 §6.2 步骤 7）。
// 危机无准入（entry NONE），目标完全公开。
import type { ProjectCard } from '../types.js';

export const CRISIS_PROJECTS: readonly ProjectCard[] = [
  { cardId: 'CRI_REPAIR_MONASTERY', domain: 'CRISIS', name: '修复修道院',   entry: { kind: 'NONE' }, fundsTarget: 30, abilityTarget: 80,  failPenalty: 5 },
  { cardId: 'CRI_WAR_REFUGEES',     domain: 'CRISIS', name: '安置战争难民', entry: { kind: 'NONE' }, fundsTarget: 40, abilityTarget: 100, failPenalty: 7 },
  { cardId: 'CRI_ALMSHOUSE',        domain: 'CRISIS', name: '建设济贫院',   entry: { kind: 'NONE' }, fundsTarget: 50, abilityTarget: 120, failPenalty: 10 },
  { cardId: 'CRI_FAMINE_RELIEF',    domain: 'CRISIS', name: '饥荒赈济',     entry: { kind: 'NONE' }, fundsTarget: 60, abilityTarget: 140, failPenalty: 12 },
  { cardId: 'CRI_BLACK_DEATH',      domain: 'CRISIS', name: '对抗黑死病',   entry: { kind: 'NONE' }, fundsTarget: 70, abilityTarget: 170, failPenalty: 15 },
  { cardId: 'CRI_GREAT_PLAGUE',     domain: 'CRISIS', name: '王国大疫病',   entry: { kind: 'NONE' }, fundsTarget: 90, abilityTarget: 200, failPenalty: 20 },
] as const;
