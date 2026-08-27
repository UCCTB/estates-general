// 规则书 §11.3 王权与战争项目列表。
// 2026-08-27 裁定（issues #2 裁定附带）：战争项目不设准入——打仗需要人力，人人可参战；
// 资格加成（§11.1）保留。原准入列（「基础以上」「组织 / 核心」「核心，或 2 项组织资格」）作废，
// 规则书 §11.3 待回写。其余数值不变。
import type { ProjectCard } from '../types.js';

export const WAR_PROJECTS: readonly ProjectCard[] = [
  { cardId: 'WAR_ROYAL_ESCORT',        domain: 'WAR', name: '王室护送', teamSize: [1, 2], entry: { kind: 'NONE' }, minFunds: 10, minAbility: 40,  reward: 50 },
  { cardId: 'WAR_BORDER_GARRISON',     domain: 'WAR', name: '边境驻防', teamSize: [1, 3], entry: { kind: 'NONE' }, minFunds: 20, minAbility: 80,  reward: 80 },
  { cardId: 'WAR_SIEGE_SUPPLY',        domain: 'WAR', name: '围城军需', teamSize: [1, 3], entry: { kind: 'NONE' }, minFunds: 30, minAbility: 100, reward: 110 },
  { cardId: 'WAR_SUPPRESS_REBELLION',  domain: 'WAR', name: '平定叛乱', teamSize: [2, 4], entry: { kind: 'NONE' }, minFunds: 30, minAbility: 120, reward: 135 },
  { cardId: 'WAR_CRUSADE_LEVY',        domain: 'WAR', name: '圣战征募', teamSize: [2, 4], entry: { kind: 'NONE' }, minFunds: 50, minAbility: 140, reward: 170 },
  { cardId: 'WAR_NORTHERN_EXPEDITION', domain: 'WAR', name: '北境远征', teamSize: [2, 4], entry: { kind: 'NONE' }, minFunds: 60, minAbility: 160, reward: 200 },
] as const;
