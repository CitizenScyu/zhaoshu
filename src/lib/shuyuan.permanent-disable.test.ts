import { describe, expect, it } from 'vitest';

import { selectCandidates } from './rule-engine/compile-smoke';
import { isPermanentlyDisabledUrl } from './source-policy';

describe('permanent-disable hosts（静态名单，仅默认环境）', () => {
  it('api.wnreader.com 命中', () => {
    expect(isPermanentlyDisabledUrl('https://api.wnreader.com/books?page=1')).toBe(true);
    expect(isPermanentlyDisabledUrl('https://api.wnreader.com/')).toBe(true);
  });
  it('wnreader.com 命中（含子域名后缀匹配）', () => {
    expect(isPermanentlyDisabledUrl('https://wnreader.com/user/x')).toBe(true);
    expect(isPermanentlyDisabledUrl('https://sub.wnreader.com/book/1')).toBe(true);
  });
  it('非 wnreader 一律不命中', () => {
    expect(isPermanentlyDisabledUrl('https://api.other.com/x?host=wnreader.com')).toBe(false);
    expect(isPermanentlyDisabledUrl('https://www.other-wnreader.com/x')).toBe(false);
    expect(isPermanentlyDisabledUrl('')).toBe(false);
    expect(isPermanentlyDisabledUrl('not a url')).toBe(false);
    expect(isPermanentlyDisabledUrl('://wnreader.com')).toBe(false);
    expect(isPermanentlyDisabledUrl('ftp://wnreader.com/x')).toBe(false);
  });
  it('bug42 回归：候选筛的字段是 bookSourceUrl，wnreader 源过不了包装器', () => {
    // 16:46 复发根因：包装器曾用 c.url（RawSource 无此字段，恒 undefined），
    // isPermanentlyDisabledUrl('undefined') 静默 false ⇒ 永不过滤。
    // 本用例模拟 admitRows 的候选判法（selectCandidatesWithPermanentBlock 同款组合）钉死字段名。
    const wnreaderSource = {
      bookSourceUrl: 'https://api.wnreader.com',
      ruleSearch: { bookList: '$.books[*]', name: '$.name' },
      ruleContent: { content: '$.content' },
    };
    // selectCandidates 初筛应放行（形态合规）……
    const candidates = selectCandidates([wnreaderSource]);
    // ……然后 permblock 包装必须把 wnreader 拦下（字段取 bookSourceUrl，不是 url）。
    const afterBlock = candidates.filter((c) => !isPermanentlyDisabledUrl(String(c.bookSourceUrl ?? '')));
    expect(afterBlock).toHaveLength(0);
  });
});
