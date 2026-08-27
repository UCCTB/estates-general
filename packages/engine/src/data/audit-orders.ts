// 规则书 §14.1 行政审查令：履历优先 × 2、资格优先 × 2、实务优先 × 2，洗混不放回。
import type { AuditOrder } from '../types.js';

export const AUDIT_ORDER_DECK: readonly AuditOrder[] = [
  'RECORD_FIRST', 'RECORD_FIRST',
  'QUALIFICATION_FIRST', 'QUALIFICATION_FIRST',
  'PRACTICE_FIRST', 'PRACTICE_FIRST',
] as const;
