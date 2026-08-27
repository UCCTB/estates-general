// 规则书 §4 身份卡。数值不改；名义估值仅注释备查（1 情报权 = 10，基础 20 / 工程 30 / 行政 30 / 组织 30 / 核心 40）。
import type { Identity, Qualification } from '../types.js';

export interface IdentityCard {
  identity: Identity;
  funds: number;
  ability: number;
  intel: number;
  initialQualification: Qualification;
}

// 顺序与规则书 §4 表格行序一致
export const IDENTITY_CARDS: readonly IdentityCard[] = [
  { identity: 'KING',         funds: 20, ability: 20, intel: 2, initialQualification: 'CORE' },
  { identity: 'QUEEN',        funds: 30, ability: 20, intel: 2, initialQualification: 'ORG' },
  { identity: 'BISHOP',       funds: 10, ability: 20, intel: 4, initialQualification: 'ADMIN' },
  { identity: 'KNIGHT',       funds: 10, ability: 70, intel: 0, initialQualification: 'BASIC' },
  { identity: 'NOBLE',        funds: 50, ability: 20, intel: 0, initialQualification: 'ORG' },
  { identity: 'CLERK',        funds: 20, ability: 30, intel: 3, initialQualification: 'BASIC' },
  { identity: 'MERCHANT',     funds: 70, ability: 10, intel: 2, initialQualification: 'NONE' },
  { identity: 'GUILD_MASTER', funds: 20, ability: 50, intel: 0, initialQualification: 'ENGINEERING' },
  { identity: 'SCHOLAR',      funds: 10, ability: 40, intel: 5, initialQualification: 'NONE' },
  { identity: 'BURGHER',      funds: 40, ability: 40, intel: 0, initialQualification: 'BASIC' },
  { identity: 'ARTISAN',      funds: 10, ability: 80, intel: 1, initialQualification: 'NONE' },
  { identity: 'PEASANT',      funds: 10, ability: 90, intel: 0, initialQualification: 'NONE' },
] as const;
