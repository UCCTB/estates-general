// 规则书 §14.2 知识与行政项目列表。报酬 = reward 资金 + rewardIntel 情报权。
// 准入列原文：编制地籍「无」；王国人口调查「基础以上」；整顿税册「基础 / 行政 / 核心」；
// 勘测王国疆界「行政资格」；外交使团「行政 / 组织 / 核心」；翻译古代典籍「行政资格」。
import type { ProjectCard } from '../types.js';

export const ADMIN_PROJECTS: readonly ProjectCard[] = [
  { cardId: 'ADM_CADASTRE',        domain: 'ADMIN', name: '编制地籍',     slots: 2, entry: { kind: 'NONE' },                                       minAbility: 30, reward: 35, rewardIntel: 1 },
  { cardId: 'ADM_CENSUS',          domain: 'ADMIN', name: '王国人口调查', slots: 2, entry: { kind: 'AT_LEAST_BASIC' },                             minAbility: 40, reward: 45, rewardIntel: 1 },
  { cardId: 'ADM_TAX_ROLLS',       domain: 'ADMIN', name: '整顿税册',     slots: 1, entry: { kind: 'ANY_OF', accepted: ['BASIC', 'ADMIN', 'CORE'] }, minAbility: 40, reward: 60, rewardIntel: 1 },
  { cardId: 'ADM_SURVEY_BORDERS',  domain: 'ADMIN', name: '勘测王国疆界', slots: 1, entry: { kind: 'ANY_OF', accepted: ['ADMIN'] },                minAbility: 50, reward: 70, rewardIntel: 1 },
  { cardId: 'ADM_DIPLOMATIC_MISSION', domain: 'ADMIN', name: '外交使团',  slots: 1, entry: { kind: 'ANY_OF', accepted: ['ADMIN', 'ORG', 'CORE'] }, minAbility: 40, reward: 80, rewardIntel: 2 },
  { cardId: 'ADM_TRANSLATE_CODICES',  domain: 'ADMIN', name: '翻译古代典籍', slots: 1, entry: { kind: 'ANY_OF', accepted: ['ADMIN'] },             minAbility: 60, reward: 70, rewardIntel: 2 },
] as const;
