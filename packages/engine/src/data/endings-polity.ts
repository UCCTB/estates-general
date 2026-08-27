// 规则书 §20 第二层结局：普通双人政体结局（第一名 → 第二名）、独胜结局、
// 以及 TDD-002 §4.3 的第一名通则回退。
//
// 规则书 §20 只列各身份的「常见结局」，共 63 条，未覆盖全部 12 × 11 = 132 组；
// 缺口 69 组走通则回退（FALLBACK_POLITY），此时 ending.polityFallback = true。
// 原文中「贵族 / 骑士」「书记官 / 学者」这类斜杠写法在此展开为多行。
import type { Identity } from '../types.js';

export interface PolityEntry { first: Identity; second: Identity; name: string; }

export const POLITY_PAIRS: readonly PolityEntry[] = [
  // §20.1 国王第一：最高制度资格最终成功转化为现实支配
  { first: 'KING', second: 'BISHOP',       name: '王座与祭坛' },
  { first: 'KING', second: 'NOBLE',        name: '王权复兴' },
  { first: 'KING', second: 'KNIGHT',       name: '剑与王冠' },
  { first: 'KING', second: 'MERCHANT',     name: '税契王国' },
  { first: 'KING', second: 'CLERK',        name: '羊皮纸王权' },
  { first: 'KING', second: 'SCHOLAR',      name: '羊皮纸王权' },

  // §20.2 主教第一：掌握制度解释、知识与合法性的人凌驾于世俗权力之上
  { first: 'BISHOP', second: 'KING',       name: '卡诺莎之后' },
  { first: 'BISHOP', second: 'SCHOLAR',    name: '经院王国' },
  { first: 'BISHOP', second: 'CLERK',      name: '羊皮纸教廷' },
  { first: 'BISHOP', second: 'MERCHANT',   name: '赎罪券时代' },
  { first: 'BISHOP', second: 'PEASANT',    name: '千禧王国' },
  { first: 'BISHOP', second: 'ARTISAN',    name: '千禧王国' },

  // §20.3 王后第一：宫廷网络、协调与组织能力成为实际权力核心
  { first: 'QUEEN', second: 'KING',        name: '摄政之治' },
  { first: 'QUEEN', second: 'BISHOP',      name: '双冠政治' },
  { first: 'QUEEN', second: 'NOBLE',       name: '宫廷同盟' },
  { first: 'QUEEN', second: 'MERCHANT',    name: '宫廷财政' },
  { first: 'QUEEN', second: 'CLERK',       name: '密室政府' },
  { first: 'QUEEN', second: 'SCHOLAR',     name: '密室政府' },

  // §20.4 贵族第一：财富与既有身份联合起来限制最高王权
  { first: 'NOBLE', second: 'KING',        name: '第二次大宪章' },
  { first: 'NOBLE', second: 'QUEEN',       name: '诸侯会议' },
  { first: 'NOBLE', second: 'KNIGHT',      name: '封建军役' },
  { first: 'NOBLE', second: 'MERCHANT',    name: '纹章与钱袋' },
  { first: 'NOBLE', second: 'BISHOP',      name: '领主与教区' },

  // §20.5 商人第一：流动资本最终取得对其他资源的定价权
  { first: 'MERCHANT', second: 'KING',         name: '王冠的债权人' },
  { first: 'MERCHANT', second: 'NOBLE',        name: '香料与纹章' },
  { first: 'MERCHANT', second: 'GUILD_MASTER', name: '汉萨世纪' },
  { first: 'MERCHANT', second: 'BURGHER',      name: '自由市联盟' },
  { first: 'MERCHANT', second: 'BISHOP',       name: '赎罪券市场' },
  { first: 'MERCHANT', second: 'SCHOLAR',      name: '账本的胜利' },
  { first: 'MERCHANT', second: 'CLERK',        name: '账本的胜利' },

  // §20.6 市民第一：中间阶层通过开放制度与资源平衡进入统治核心
  { first: 'BURGHER', second: 'MERCHANT',      name: '自由市共和国' },
  { first: 'BURGHER', second: 'GUILD_MASTER',  name: '公社宪章' },
  { first: 'BURGHER', second: 'CLERK',         name: '市政共和国' },
  { first: 'BURGHER', second: 'KING',          name: '城市征服了宫廷' },

  // §20.7 行会师傅第一：专业技术开始拥有独立于财富和身份的制度地位
  { first: 'GUILD_MASTER', second: 'MERCHANT', name: '汉萨同盟' },
  { first: 'GUILD_MASTER', second: 'ARTISAN',  name: '行会共和国' },
  { first: 'GUILD_MASTER', second: 'BURGHER',  name: '自由工坊' },
  { first: 'GUILD_MASTER', second: 'KING',     name: '御用工坊反客为主' },
  { first: 'GUILD_MASTER', second: 'BISHOP',   name: '大教堂时代' },

  // §20.8 工匠第一：劳动与技术脱离旧有资格秩序，取得独立政治地位
  { first: 'ARTISAN', second: 'GUILD_MASTER',  name: '公社之钟' },
  { first: 'ARTISAN', second: 'PEASANT',       name: '锤与犁' },
  { first: 'ARTISAN', second: 'BURGHER',       name: '自由手艺人共和国' },
  { first: 'ARTISAN', second: 'MERCHANT',      name: '作坊战胜钱袋' },
  { first: 'ARTISAN', second: 'NOBLE',         name: '没有纹章的时代' },

  // §20.9 农民第一：最低制度位置中的生产能力成功完成全部资本转换
  { first: 'PEASANT', second: 'ARTISAN',       name: '扎克雷之后' },
  { first: 'PEASANT', second: 'BURGHER',       name: '公社之春' },
  { first: 'PEASANT', second: 'KNIGHT',        name: '乡民军' },
  { first: 'PEASANT', second: 'NOBLE',         name: '庄园倒置' },
  { first: 'PEASANT', second: 'KING',          name: '犁铧高于王冠' },

  // §20.10 骑士第一：被制度承认的执行力量最终取得政治支配地位
  { first: 'KNIGHT', second: 'KING',           name: '剑高于王冠' },
  { first: 'KNIGHT', second: 'NOBLE',          name: '军功贵族' },
  { first: 'KNIGHT', second: 'PEASANT',        name: '自由军团' },
  { first: 'KNIGHT', second: 'ARTISAN',        name: '自由军团' },
  { first: 'KNIGHT', second: 'MERCHANT',       name: '佣兵共和国' },

  // §20.11 学者第一：知识资本成功从辅助性资源转化为统治性资源
  { first: 'SCHOLAR', second: 'BISHOP',        name: '经院共和国' },
  { first: 'SCHOLAR', second: 'CLERK',         name: '知识国家' },
  { first: 'SCHOLAR', second: 'KING',          name: '贤哲王庭' },
  { first: 'SCHOLAR', second: 'MERCHANT',      name: '知识市场' },
  { first: 'SCHOLAR', second: 'GUILD_MASTER',  name: '文艺复兴' },

  // §20.12 书记官第一：程序、档案与行政能力最终取得独立于王权的支配地位
  { first: 'CLERK', second: 'KING',            name: '羊皮纸王国' },
  { first: 'CLERK', second: 'BISHOP',          name: '文官国家' },
  { first: 'CLERK', second: 'MERCHANT',        name: '账册王国' },
  { first: 'CLERK', second: 'SCHOLAR',         name: '档案即权力' },
] as const;

// 独胜结局（规则书 §20 各节末条「XX 独自过线」）。仅列出原文给出的 5 项。
export const POLITY_SOLO: Partial<Record<Identity, string>> = {
  KING: '朕即秩序',
  BISHOP: '天主之城',
  PEASANT: '无人再为领主耕田',
  KNIGHT: '最后的骑士',
  CLERK: '一切皆须登记',
};

// TDD-002 §4.3 提案：第一名通则回退。规则书未给出 (1st, 2nd) 条目时使用，
// 语义取自 §20 各节「XX 第一代表：……」那句，只是不区分第二名。
// **待设计者确认或替换。** 命中时 ending.polityFallback = true，主持端会显式提示。
export const FALLBACK_POLITY: Record<Identity, string> = {
  KING: '王冠之治',
  BISHOP: '祭坛之上',
  QUEEN: '宫廷之治',
  NOBLE: '诸侯之国',
  MERCHANT: '资本定价的时代',
  BURGHER: '城市的世纪',
  GUILD_MASTER: '技艺的位置',
  ARTISAN: '没有行会的手艺',
  PEASANT: '田垄之上的王国',
  KNIGHT: '执剑者之治',
  SCHOLAR: '知识的统治',
  CLERK: '档案之国',
};
