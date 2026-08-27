// 规则书 §11.1 战争动员资格加成。单支队伍加成上限 +60（两项组织资格可共同达到 +60）。
// 表中只列了基础 / 组织 / 核心；未列出的资格（工程、行政）按 +0 处理。
import type { Qualification } from '../types.js';

export const WAR_QUALIFICATION_BONUS: Readonly<Partial<Record<Qualification, number>>> = {
  BASIC: 0,
  ORG: 30,
  CORE: 60,
} as const;

export const WAR_BONUS_CAP = 60;
