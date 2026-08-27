// 规则书 §21 特殊前三名组合结局。前三名身份的**集合**匹配，与内部次序无关；
// 命中即覆盖 §20 的普通双人结局（§23 第三步）。
//
// 顺序敏感：{国王,主教,贵族} 与 {国王,主教,商人} 第三人不同、互不冲突，但为了
// 「同一前三名在任何实现下都得到同一结局」，本表按规则书列出的顺序逐项匹配，
// 第一个命中即用。不要重排本表。
import type { Identity } from '../types.js';

export interface SpecialTrio {
  members: readonly [Identity, Identity, Identity];
  name: string;
  note: string;
  // 变体：满足 variantWhenFirst 的身份排第一时，可改用 variantName（规则书 §21 只有一处）
  variantWhenFirst?: Identity;
  variantName?: string;
}

export const SPECIAL_TRIOS: readonly SpecialTrio[] = [
  {
    members: ['KING', 'BISHOP', 'NOBLE'],
    name: '王座、祭坛与纹章',
    note: '世俗权力、合法性权力和土地身份共同维持旧秩序',
    variantWhenFirst: 'BISHOP',
    variantName: '卡诺莎体系',
  },
  {
    members: ['MERCHANT', 'BURGHER', 'GUILD_MASTER'],
    name: '新汉萨',
    note: '商业资本、城市共同体与生产组织共同形成新的城市秩序',
  },
  {
    members: ['PEASANT', 'ARTISAN', 'KNIGHT'],
    name: '武装公社',
    note: '生产者与武装执行者共同排除传统资本与高资格中心',
  },
  {
    members: ['BISHOP', 'SCHOLAR', 'CLERK'],
    name: '羊皮纸之国',
    note: '知识、行政与制度解释形成闭环',
  },
  {
    members: ['KING', 'NOBLE', 'MERCHANT'],
    name: '债务君主制',
    note: '王权提供政治入口，贵族提供身份结构，商人提供流动资本',
  },
  {
    members: ['KING', 'BISHOP', 'MERCHANT'],
    name: '王冠、祭坛与钱袋',
    note: '王权、合法性与资本形成高度稳定的三方统治联盟',
  },
  {
    members: ['PEASANT', 'ARTISAN', 'SCHOLAR'],
    name: '异端公社',
    note: '生产者、手工业者与知识者在正式旧秩序之外建立新的解释共同体',
  },
] as const;
