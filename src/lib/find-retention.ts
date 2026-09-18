import type { FindRetention } from './types';

/**
 * F12：找书需求的保留契约。
 *
 * 背景：`FindTab` 的「仅本次有效」勾选此前只把需求塞进 `conditions` 通道，本地搜索历史
 * （localStorage 最近查询）仍**无条件**写入，推荐持久化的 query 字段也照旧落原文。
 * 「本次需求」「长期记忆」「推荐记录」三种概念混在一起，且前端只能靠 conditions 是否为空
 * 反推意图——文案承诺与行为没有共同的、可断言的数据契约。
 *
 * 这里把意图显式化：请求体带 `retention`，前后端都据此判断，不再从 conditions 推断。
 * 保留矩阵（逐格可断言）：
 *
 * | retention | localStorage 搜索历史 | 推荐记录 query 字段 | 画像 |
 * |-----------|----------------------|--------------------|------|
 * | session   | 不写                 | 不落原文（存 ''）  | 不写 |
 * | longterm  | 写                   | 原文               | 不写 |
 *
 * 画像一列对两条路径都是「不写」：找书链路从不更新画像，画像是 feedback/种子书单的产物。
 */
export const DEFAULT_RETENTION: FindRetention = 'longterm';

/** 收窄请求体里的 retention；缺省 / 非法值一律按长期（保守：不悄悄降级成不记录）。 */
export function parseRetention(value: unknown): FindRetention {
  return value === 'session' ? 'session' : DEFAULT_RETENTION;
}

/** 搜索历史（localStorage 最近查询）只在长期契约下写入。 */
export function shouldRememberQuery(retention: FindRetention): boolean {
  return retention === 'longterm';
}

/** 推荐记录的 query 字段：临时契约不落需求原文，避免本次需求进入长期检索记录。 */
export function persistedQuery(retention: FindRetention, query: string): string {
  return retention === 'session' ? '' : query;
}
