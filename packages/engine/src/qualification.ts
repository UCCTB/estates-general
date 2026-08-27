// 准入判定与资格辅助。规则书 §5.4 资格边界；QualificationRequirement 表示见 types.ts（issues #2）。
import type { Qualification, QualificationRequirement, Seat } from './types.js';

// 单人（行政项目 §14）：以申请者本回合声明使用的资格判定。
// 2026-08-27 裁定（issues #2）：资格严格按卡面列举认定，高级资格不能顶替低级资格
// （撤销此前「CORE 可满足含 BASIC 的 ANY_OF」的保守替代）。
// 「基础以上」是门槛写法本身的范围表达（核心＞工程/行政/组织＞基础），持任意资格即满足，不属混用。
export function entrySatisfiedByOne(entry: QualificationRequirement, used: Qualification | undefined): boolean {
  switch (entry.kind) {
    case 'NONE':
      return true;
    case 'AT_LEAST_BASIC':
      return used !== undefined && used !== 'NONE';
    case 'ANY_OF':
      return used !== undefined && used !== 'NONE' && entry.accepted.includes(used);
    case 'CORE_OR_TWO_ORG':
      return used === 'CORE';   // 单人无法凑出两项组织资格
  }
}

// 队伍（战争 §11 / 工程 §12）：以全体成员声明使用的资格集合判定。
export function entrySatisfiedByTeam(entry: QualificationRequirement, usedList: Qualification[]): boolean {
  switch (entry.kind) {
    case 'NONE':
      return true;
    case 'AT_LEAST_BASIC':
      return usedList.some((q) => q !== 'NONE');
    case 'ANY_OF':
      return usedList.some((q) => entrySatisfiedByOne(entry, q));
    case 'CORE_OR_TWO_ORG':
      return usedList.includes('CORE') || usedList.filter((q) => q === 'ORG').length >= 2;
  }
}

export function holdsQualification(seat: Seat, kind: Exclude<Qualification, 'NONE'>): boolean {
  return seat.qualifications.some((q) => q.kind === kind);
}

// 资格等级（规则书 §2：核心 ＞ 工程 / 行政 / 组织 ＞ 基础），用于终局排名。
export function qualificationLevel(kind: Qualification): number {
  switch (kind) {
    case 'CORE': return 3;
    case 'ENGINEERING': case 'ADMIN': case 'ORG': return 2;
    case 'BASIC': return 1;
    case 'NONE': return 0;
  }
}
