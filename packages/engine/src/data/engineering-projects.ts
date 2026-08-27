// 规则书 §12 工程与生产项目列表。最低合法报价 = ceil(budgetCap × 0.5)，由结算推导，不入表
// （表中「最低合法报价」列与 ceil 公式逐项一致：45→23, 70→35, 85→43, 105→53, 125→63, 150→75）。
// 准入列原文：修复磨坊/重建石桥/建设粮仓「无」；疏浚运河「基础以上」；扩建城墙「基础 / 工程」；王家大堡垒「工程资格」。
import type { ProjectCard } from '../types.js';

export const ENGINEERING_PROJECTS: readonly ProjectCard[] = [
  { cardId: 'ENG_REPAIR_MILL',    domain: 'ENGINEERING', name: '修复磨坊',   entry: { kind: 'NONE' },                                minAbility: 60,  budgetCap: 45 },
  { cardId: 'ENG_REBUILD_BRIDGE', domain: 'ENGINEERING', name: '重建石桥',   entry: { kind: 'NONE' },                                minAbility: 100, budgetCap: 70 },
  { cardId: 'ENG_BUILD_GRANARY',  domain: 'ENGINEERING', name: '建设粮仓',   entry: { kind: 'NONE' },                                minAbility: 120, budgetCap: 85 },
  { cardId: 'ENG_DREDGE_CANAL',   domain: 'ENGINEERING', name: '疏浚运河',   entry: { kind: 'AT_LEAST_BASIC' },                      minAbility: 140, budgetCap: 105 },
  { cardId: 'ENG_EXPAND_WALLS',   domain: 'ENGINEERING', name: '扩建城墙',   entry: { kind: 'ANY_OF', accepted: ['BASIC', 'ENGINEERING'] }, minAbility: 160, budgetCap: 125 },
  { cardId: 'ENG_ROYAL_FORTRESS', domain: 'ENGINEERING', name: '王家大堡垒', entry: { kind: 'ANY_OF', accepted: ['ENGINEERING'] },   minAbility: 180, budgetCap: 150 },
] as const;
