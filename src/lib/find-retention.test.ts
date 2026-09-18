import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, parseRetention, persistedQuery, shouldRememberQuery } from './find-retention';

// F12：把「只影响本次推荐」与「记入长期偏好」拆成显式、可测的 retention 契约。
// 这里逐格钉住矩阵，防止再退回「用 conditions 是否为空反推意图」。
describe('retention 契约矩阵', () => {
  it('缺省 / 非法值一律按长期（不悄悄降级成不记录）', () => {
    expect(DEFAULT_RETENTION).toBe('longterm');
    for (const value of [undefined, null, '', '长期', 1, true, {}, []]) {
      expect(parseRetention(value)).toBe('longterm');
    }
    expect(parseRetention('longterm')).toBe('longterm');
    expect(parseRetention('session')).toBe('session');
  });

  it('localStorage 搜索历史：session 不写，longterm 写', () => {
    expect(shouldRememberQuery('session')).toBe(false);
    expect(shouldRememberQuery('longterm')).toBe(true);
  });

  it('推荐记录 query 字段：session 不落原文，longterm 落原文', () => {
    expect(persistedQuery('session', '仅本次需求')).toBe('');
    expect(persistedQuery('longterm', '长期需求')).toBe('长期需求');
  });

  // 契约要点：持久化行为只看 retention，与 conditions 通道是否非空无关。
  it('session 契约下即使 conditions 携带了本次条件，也不落原文', () => {
    expect(persistedQuery('session', '临时条件')).toBe('');
  });
});
