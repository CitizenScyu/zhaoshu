import { describe, expect, it } from 'vitest';

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
});
