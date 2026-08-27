// 规则书 §17 成就清单 + TDD-001 §8.3 三档分类 + TDD-002 §12 附录 A key 对照。
// 判定阈值集中在 THRESHOLDS，试玩后在这一处调整（TDD-002 §11.4）。

export type AchievementKey =
  | 'BROKER' | 'CAPITALIST' | 'CONTRACTOR' | 'MIDDLEMAN'
  | 'KNOWLEDGE_IS_POWER' | 'RUMOR_MONGER' | 'GUARANTOR_OF_LAST_RESORT'
  | 'IRREPLACEABLE' | 'DOUBLE_AGENT' | 'PEASANT_TO_NOBLE'
  | 'GUILD' | 'CARTEL' | 'MUTUAL_AID' | 'FINANCIAL_MARKET' | 'SHADOW_BANK'
  | 'COMMUNITY' | 'TRAGEDY_OF_COMMONS' | 'LAST_FOOL' | 'ELITE_CLUB'
  | 'REVOLVING_DOOR' | 'POPULAR_FRONT' | 'GRAND_COALITION' | 'COALITION_COLLAPSE'
  | 'TIES_OVER_RULES' | 'RULES_OVER_TIES' | 'INFORMATION_MONOPOLY' | 'GATEWAY_MONOPOLY'
  | 'DISINTERMEDIATION' | 'REINTERMEDIATION' | 'EQUAL_WORK_UNEQUAL_PAY'
  | 'MONEY_IS_NOT_ENOUGH' | 'BIRTH_IS_NOT_DESTINY' | 'EQUAL_VALUE_UNEQUAL_POWER';

export type AchievementTier = 'AUTO' | 'NOMINATED' | 'VOTE';

export interface AchievementMeta {
  key: AchievementKey;
  name: string;                 // 规则书中文名
  tier: AchievementTier;
  section: string;              // 规则书章节
  weight: 1 | 2 | 3;            // TDD-002 §4.4 结构权重：3 制度性 / 2 集团性 / 1 个人性
}

// 顺序 = 规则书 §17.2 → §17.3 → §17.4 的出现顺序。§4.4 同权重时按此顺序取先。
export const ACHIEVEMENTS: readonly AchievementMeta[] = [
  // §17.2 个人成就
  { key: 'BROKER',                   name: '经纪人',       tier: 'NOMINATED', section: '§17.2', weight: 1 },
  { key: 'CAPITALIST',               name: '资本家',       tier: 'NOMINATED', section: '§17.2', weight: 1 },
  { key: 'CONTRACTOR',               name: '承包人',       tier: 'NOMINATED', section: '§17.2', weight: 1 },
  { key: 'MIDDLEMAN',                name: '掮客',         tier: 'NOMINATED', section: '§17.2', weight: 1 },
  { key: 'KNOWLEDGE_IS_POWER',       name: '知识就是力量', tier: 'AUTO',      section: '§17.2', weight: 1 },
  { key: 'RUMOR_MONGER',             name: '谣言制造者',   tier: 'AUTO',      section: '§17.2', weight: 1 },
  { key: 'GUARANTOR_OF_LAST_RESORT', name: '最后的担保人', tier: 'AUTO',      section: '§17.2', weight: 1 },
  { key: 'IRREPLACEABLE',            name: '不可替代',     tier: 'NOMINATED', section: '§17.2', weight: 1 },
  { key: 'DOUBLE_AGENT',             name: '双重身份',     tier: 'VOTE',      section: '§17.2', weight: 1 },
  { key: 'PEASANT_TO_NOBLE',         name: '从农民到贵族', tier: 'AUTO',      section: '§17.2', weight: 1 },
  // §17.3 集体成就
  { key: 'GUILD',              name: '行会',         tier: 'NOMINATED', section: '§17.3', weight: 2 },
  { key: 'CARTEL',             name: '卡特尔',       tier: 'NOMINATED', section: '§17.3', weight: 2 },
  { key: 'MUTUAL_AID',         name: '互助会',       tier: 'NOMINATED', section: '§17.3', weight: 2 },
  { key: 'FINANCIAL_MARKET',   name: '金融市场',     tier: 'AUTO',      section: '§17.3', weight: 2 },
  { key: 'SHADOW_BANK',        name: '影子银行',     tier: 'AUTO',      section: '§17.3', weight: 2 },
  { key: 'COMMUNITY',          name: '共同体',       tier: 'AUTO',      section: '§17.3', weight: 3 },
  { key: 'TRAGEDY_OF_COMMONS', name: '公地悲剧',     tier: 'AUTO',      section: '§17.3', weight: 3 },
  { key: 'LAST_FOOL',          name: '最后一个傻瓜', tier: 'AUTO',      section: '§17.3', weight: 3 },
  { key: 'ELITE_CLUB',         name: '精英俱乐部',   tier: 'NOMINATED', section: '§17.3', weight: 2 },
  { key: 'REVOLVING_DOOR',     name: '旋转门',       tier: 'NOMINATED', section: '§17.3', weight: 1 },
  { key: 'POPULAR_FRONT',      name: '人民阵线',     tier: 'NOMINATED', section: '§17.3', weight: 2 },
  { key: 'GRAND_COALITION',    name: '大联盟',       tier: 'NOMINATED', section: '§17.3', weight: 2 },
  { key: 'COALITION_COLLAPSE', name: '联盟崩溃',     tier: 'NOMINATED', section: '§17.3', weight: 2 },
  // §17.4 制度成就
  { key: 'TIES_OVER_RULES',           name: '关系比规则重要', tier: 'NOMINATED', section: '§17.4', weight: 3 },
  { key: 'RULES_OVER_TIES',           name: '规则比关系重要', tier: 'NOMINATED', section: '§17.4', weight: 3 },
  { key: 'INFORMATION_MONOPOLY',      name: '信息垄断',       tier: 'AUTO',      section: '§17.4', weight: 2 },
  { key: 'GATEWAY_MONOPOLY',          name: '入口垄断',       tier: 'NOMINATED', section: '§17.4', weight: 2 },
  { key: 'DISINTERMEDIATION',         name: '去中介化',       tier: 'AUTO',      section: '§17.4', weight: 3 },
  { key: 'REINTERMEDIATION',          name: '中介再生产',     tier: 'AUTO',      section: '§17.4', weight: 3 },
  { key: 'EQUAL_WORK_UNEQUAL_PAY',    name: '同工不同酬',     tier: 'AUTO',      section: '§17.4', weight: 1 },
  { key: 'MONEY_IS_NOT_ENOUGH',       name: '钱不是万能的',   tier: 'AUTO',      section: '§17.4', weight: 3 },
  { key: 'BIRTH_IS_NOT_DESTINY',      name: '身份不是命运',   tier: 'AUTO',      section: '§17.4', weight: 3 },
  { key: 'EQUAL_VALUE_UNEQUAL_POWER', name: '等值不等势',     tier: 'VOTE',      section: '§17.4', weight: 1 },
] as const;

export const META: Record<AchievementKey, AchievementMeta> =
  Object.fromEntries(ACHIEVEMENTS.map((m) => [m.key, m])) as Record<AchievementKey, AchievementMeta>;

// TDD-002 §11.4：以下阈值全部没有试玩数据支撑，集中放在这里以便一处调整。
export const THRESHOLDS = {
  /** 【金融市场】一回合内以未来结果为条件的非托管公证契约份数 */
  FINANCIAL_MARKET_CONTRACTS: 3,
  /** 【影子银行】「不承担主要生产能力」的能力投入上限 */
  SHADOW_BANK_MAX_ABILITY: 20,
  /** 【影子银行】每回合至少向几名不同座位提供融资 */
  SHADOW_BANK_MIN_COUNTERPARTIES: 2,
  /** 【最后的担保人】为他人结果付款且履约的契约份数 */
  GUARANTOR_MIN_FULFILLED: 2,
  /** 【信息垄断】情报转述的不同对手方人数 */
  INFO_MONOPOLY_MIN_BUYERS: 4,
  /** 【谣言制造者】被终局核验为不实的转述，其不同对手方人数 */
  RUMOR_MIN_VICTIMS: 3,
  /** 【知识就是力量】属实且促成中标的转述份数 */
  KNOWLEDGE_MIN_HITS: 2,
  /** 【最后一个傻瓜】个人贡献占危机目标的比例 */
  LAST_FOOL_SHARE: 0.3,
  /** 【共同体】实际与承诺的允许偏差 */
  COMMUNITY_TOLERANCE: 0.1,
  /** 【同工不同酬】收益倍数 */
  UNEQUAL_PAY_RATIO: 2,
  /** 【掮客】纯提供资格累计取得的资金净流入 */
  MIDDLEMAN_MIN_GAIN: 30,
  /** 【资本家】能力占比上限 / 资金占比下限 / 累计次数 */
  CAPITALIST_MAX_ABILITY_SHARE: 0.25,
  CAPITALIST_MIN_FUNDS_SHARE: 0.5,
  CAPITALIST_MIN_TIMES: 2,
  /** 【不可替代】同回合被拉进几支不同队伍 */
  IRREPLACEABLE_MIN_TEAMS: 3,
  /** 【行会】/【精英俱乐部】的最小集团规模 */
  GUILD_MIN_SIZE: 3,
  /** 【卡特尔】领域内合法队伍数上限与成员重合度 */
  CARTEL_MAX_TEAMS: 2,
  CARTEL_MIN_JACCARD: 0.6,
  /** 【互助会】连续两回合内的无对价转账笔数 */
  MUTUAL_AID_MIN_TRANSFERS: 3,
  /** 【人民阵线】/【大联盟】/【联盟崩溃】的集团规模 */
  POPULAR_FRONT_MIN_SIZE: 4,
  GRAND_COALITION_MIN_SIZE: 6,
  COALITION_COLLAPSE_MIN_SIZE: 5,
  COALITION_COLLAPSE_DROP: 0.6,
  /** 【等值不等势】赞成票门槛（规则书 §17.4 明文，不是拍的） */
  EQUAL_VALUE_MIN_VOTES: 9,
} as const;
