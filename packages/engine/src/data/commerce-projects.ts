// 规则书 §13.1 商业与运输项目列表。商业项目不要求资格（§13），entry 一律 NONE。
import type { ProjectCard } from '../types.js';

export const COMMERCE_PROJECTS: readonly ProjectCard[] = [
  { cardId: 'COM_CAPITAL_FAIR',   domain: 'COMMERCE', name: '王都大市集',   entry: { kind: 'NONE' }, minFunds: 30, minAbility: 20, reward: 55,  risk: 0 },
  { cardId: 'COM_WARHORSE_TRADE', domain: 'COMMERCE', name: '战马贸易',     entry: { kind: 'NONE' }, minFunds: 40, minAbility: 30, reward: 75,  risk: 1 },
  { cardId: 'COM_GRAIN_TRANSIT',  domain: 'COMMERCE', name: '粮食转运',     entry: { kind: 'NONE' }, minFunds: 50, minAbility: 30, reward: 95,  risk: 1 },
  { cardId: 'COM_SILVER_MINE',    domain: 'COMMERCE', name: '银矿承包',     entry: { kind: 'NONE' }, minFunds: 60, minAbility: 40, reward: 120, risk: 2 },
  { cardId: 'COM_SEAPORT_TRADE',  domain: 'COMMERCE', name: '海港贸易',     entry: { kind: 'NONE' }, minFunds: 70, minAbility: 40, reward: 145, risk: 2 },
  { cardId: 'COM_SPICE_VOYAGE',   domain: 'COMMERCE', name: '东方香料远航', entry: { kind: 'NONE' }, minFunds: 80, minAbility: 50, reward: 175, risk: 3 },
] as const;
