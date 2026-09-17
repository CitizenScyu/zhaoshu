// 别名修复的行为级用例（新机制，vitest mock HTTP，不打真站）。
//
// 覆盖任务书的五类场景：①简介【原书名：X】解析；②别名命中 sourceBookMatches；
// ③作者回退搜索拿到改名候选→命中；④同名不同书的负对照（别名不得引入误命中）；
// ⑤归一化容错（全半角括号）。
//
// 该文件在基线 763afe0（无别名机制）上应全红，在修复后应全绿。

import { describe, expect, it } from 'vitest';
import {
  parseSourceDetailLinks, parseSourceIdentity, sourceBookMatches,
} from './source-parser';

describe('source alias parsing', () => {
  it('extracts the self-reported original title from the intro (full-width brackets)', () => {
    const html = '<meta property="og:novel:book_name" content="我有一座冒险屋">'
      + '<meta property="og:novel:author" content="我会修空调">'
      + '<div>小说简介:【原书名：我有一座恐怖屋】陈歌继承了失踪父母留下的鬼屋。</div>';
    expect(parseSourceIdentity(html)).toEqual({
      title: '我有一座冒险屋', author: '我会修空调', alias: '我有一座恐怖屋',
    });
  });

  it('tolerates half-width brackets, ASCII colon and stray spaces, normalizing the stored alias', () => {
    const html = '<meta property="og:novel:book_name" content="新书">'
      + '<p>简介 [ 原书名: Ａ 书 名 ] 正文</p>';
    expect(parseSourceIdentity(html)).toEqual({ title: '新书', author: '', alias: 'a书名' });
  });

  it('omits the alias when the intro has no original-title marker', () => {
    const html = '<meta property="og:novel:book_name" content="新书"><p>简介里提到原书名但没有标记格式</p>';
    const identity = parseSourceIdentity(html);
    expect(identity.alias).toBeUndefined();
    expect(identity).toEqual({ title: '新书', author: '' });
  });

  it('collects detail links from an author search page regardless of anchor text', () => {
    const html = '<a href="/books/details42.html"><b>完全不相干的锚文本</b></a>'
      + '<a href="/books/details42.html">重复链接</a>'
      + '<a href="/books/list-1.html">分类链接</a>'
      + '<a href="/books/details43.html">阅读小说</a>';
    expect(parseSourceDetailLinks(html, 'https://book15.net/books/search.html?kw=x'))
      .toEqual(['https://book15.net/books/details42.html', 'https://book15.net/books/details43.html']);
  });

  it('still rejects cross-domain detail links from the author search page', () => {
    expect(() => parseSourceDetailLinks('<a href="https://evil.invalid/books/details42.html">书</a>', 'https://book15.net/'))
      .toThrow();
  });
});

describe('sourceBookMatches with aliases', () => {
  const expected = { title: '我有一座恐怖屋', author: '我会修空调' };

  it('accepts the site title or the site-reported original title (alias)', () => {
    expect(sourceBookMatches(expected, { title: '我有一座冒险屋', author: '我会修空调', alias: '我有一座恐怖屋' })).toBe(true);
    expect(sourceBookMatches(expected, { title: '我有一座恐怖屋', author: '我会修空调' })).toBe(true);
  });

  it('normalizes full-width brackets and spacing on both sides of the comparison', () => {
    expect(sourceBookMatches(
      { title: '《我有一座恐怖屋》', author: '我 会 修 空 调' },
      { title: '我有一座冒险屋', author: '我会修空调', alias: '我 有 一 座 恐 怖 屋 ' },
    )).toBe(true);
  });

  it('does not match when neither the title nor the alias agrees', () => {
    expect(sourceBookMatches(expected, { title: '我有一座冒险屋', author: '我会修空调', alias: '另一本书' })).toBe(false);
  });

  it('keeps the author gate: an alias cannot pair the expected book with a same-title different book', () => {
    // 负对照：目标《冒险屋》作者 B；站点候选《冒险屋》作者 A，其简介自报原书名《恐怖屋》。
    // 期望《恐怖屋》的一方靠 alias 命中标题维，但作者不同 ⇒ 必须拒。
    expect(sourceBookMatches(
      { title: '我有一座恐怖屋', author: '作者B' },
      { title: '我有一座冒险屋', author: '作者A', alias: '我有一座恐怖屋' },
    )).toBe(false);
    // 期望《冒险屋》真书的一方：标题直接相等但作者不同 ⇒ 仍拒（既有行为不回退）。
    expect(sourceBookMatches(
      { title: '我有一座冒险屋', author: '作者B' },
      { title: '我有一座冒险屋', author: '作者A', alias: '我有一座恐怖屋' },
    )).toBe(false);
  });

  it('does not let an empty alias match an empty expected title', () => {
    expect(sourceBookMatches({ title: '', author: '' }, { title: '', author: '', alias: '' })).toBe(false);
  });
});
