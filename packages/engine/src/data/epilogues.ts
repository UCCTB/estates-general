// 规则书 §22 第三层结局：社会史后记。
// 规则书原文只给了 5 条示例（影子银行 / 精英俱乐部 / 公地悲剧 / 互助会 / 钱不是万能的），
// 其余为 TDD-002 提案，逐条标注来源。后记是叙事不是规则，主持端可以自由改写。
import type { AchievementKey } from './achievement-meta.js';

export interface EpilogueLine { text: string; source: '规则书 §22' | 'TDD-002 提案'; }

export const EPILOGUES: Partial<Record<AchievementKey, EpilogueLine>> = {
  // ── 规则书 §22 原文 ──
  SHADOW_BANK:        { text: '影子银行时代。', source: '规则书 §22' },
  ELITE_CLUB:         { text: '新的贵族已经形成。', source: '规则书 §22' },
  TRAGEDY_OF_COMMONS: { text: '他们能够分配整个王国，却无法共同阻止瘟疫。', source: '规则书 §22' },
  MUTUAL_AID:         { text: '在正式秩序之外，另一种秩序已经生长。', source: '规则书 §22' },
  MONEY_IS_NOT_ENOUGH:{ text: '最富有的人站在城门之外。', source: '规则书 §22' },

  // ── TDD-002 提案，待设计者确认 ──
  COMMUNITY:          { text: '这一次，他们在开口之前就已经算清了各自要出多少。', source: 'TDD-002 提案' },
  LAST_FOOL:          { text: '有人替所有人付了钱，然后和所有人一起受罚。', source: 'TDD-002 提案' },
  BIRTH_IS_NOT_DESTINY: { text: '名册的顺序没有变，但坐在前面的人换了。', source: 'TDD-002 提案' },
  PEASANT_TO_NOBLE:   { text: '有一个人走完了全程，于是所有人都知道那条路是通的。', source: 'TDD-002 提案' },
  DISINTERMEDIATION:  { text: '两个人终于直接说上了话，中间那位从账本上消失了。', source: 'TDD-002 提案' },
  REINTERMEDIATION:   { text: '旧的中间人被绕开，新的中间人在同一个位置上出现。', source: 'TDD-002 提案' },
  FINANCIAL_MARKET:   { text: '尚未发生的收益，已经被反复许诺出去。', source: 'TDD-002 提案' },
  INFORMATION_MONOPOLY: { text: '关于明天的消息，只有一个来源。', source: 'TDD-002 提案' },
  RUMOR_MONGER:       { text: '有人靠说错话赚到了钱，而且不止一次。', source: 'TDD-002 提案' },
  KNOWLEDGE_IS_POWER: { text: '知道得早，就等于拿得多。', source: 'TDD-002 提案' },
  GUARANTOR_OF_LAST_RESORT: { text: '总得有人在别人失败的时候还站着。', source: 'TDD-002 提案' },
  EQUAL_WORK_UNEQUAL_PAY: { text: '同样的一天劳作，价钱由认识谁决定。', source: 'TDD-002 提案' },
  GUILD:              { text: '价格不再由竞争决定，而由一次事先的会面决定。', source: 'TDD-002 提案' },
  CARTEL:             { text: '竞争者只剩下两家，而这两家早就谈好了。', source: 'TDD-002 提案' },
  POPULAR_FRONT:      { text: '没有资格的人凑在一起，也凑出了一个门槛。', source: 'TDD-002 提案' },
  GRAND_COALITION:    { text: '半数以上的人在同一张网里，剩下的人只能等它散掉。', source: 'TDD-002 提案' },
  COALITION_COLLAPSE: { text: '那个联盟撑过了一个回合，没能撑过分钱。', source: 'TDD-002 提案' },
  REVOLVING_DOOR:     { text: '拿到资格的第二天，他就换了一批合作者。', source: 'TDD-002 提案' },
  TIES_OVER_RULES:    { text: '门是锁着的，但有人一直有钥匙。', source: 'TDD-002 提案' },
  RULES_OVER_TIES:    { text: '认识所有人，也没能换来那一张纸。', source: 'TDD-002 提案' },
  GATEWAY_MONOPOLY:   { text: '两支队伍争的不是钱，是同一个人的资格。', source: 'TDD-002 提案' },
  BROKER:             { text: '什么都没生产的人，从每一笔交易里抽走了一点。', source: 'TDD-002 提案' },
  CAPITALIST:         { text: '出钱的人不必出力，出力的人不必分钱。', source: 'TDD-002 提案' },
  CONTRACTOR:         { text: '同一个人组了两支不同的队，两次都赢了。', source: 'TDD-002 提案' },
  MIDDLEMAN:          { text: '他带来的既不是钱也不是力，是一张卡。', source: 'TDD-002 提案' },
  IRREPLACEABLE:      { text: '那一回合，所有人都在等同一个人点头。', source: 'TDD-002 提案' },
  DOUBLE_AGENT:       { text: '他在两张桌子上都有位子，直到有人开始数椅子。', source: 'TDD-002 提案' },
  EQUAL_VALUE_UNEQUAL_POWER: { text: '十二张卡上写着同一个数字，然后就再没有一样过。', source: 'TDD-002 提案' },
};
