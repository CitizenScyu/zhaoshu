// 别名修复的行为级用例（新机制，vitest mock HTTP，不打真站）。
//
// 覆盖任务书的五类场景：①简介【原书名：X】解析；②别名命中 sourceBookMatches；
// ③作者回退搜索拿到改名候选→命中；④同名不同书的负对照（别名不得引入误命中）；
// ⑤归一化容错（全半角括号）。
// 追加：模糊降级层（L3）——sourceTitleSimilarity 判据 + 模糊候选不直接 404。
//
// 该文件在基线 763afe0（无别名机制）上应全红，在修复后应全绿。

import { describe, expect, it } from 'vitest';
import {
  parseSourceDetailLinks, parseSourceIdentity, sourceBookMatches, sourceTitleSimilarity,
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

describe('sourceTitleSimilarity (fuzzy tier thresholds)', () => {
  it('ranks exact and alias matches at tier 0', () => {
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座冒险屋', author: 'x', alias: '我有一座恐怖屋' })).toBe(0);
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座恐怖屋', author: 'x' })).toBe(0);
  });

  it('ranks decoration-stripped equality at tier 1', () => {
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座恐怖屋（精品版）', author: 'x' })).toBe(1);
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座恐怖屋：修订版', author: 'x' })).toBe(1);
  });

  it('ranks containment at tier 2 only when the shorter side is at least 4 chars', () => {
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座恐怖屋全本', author: 'x' })).toBe(2);
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '恐怖屋', author: 'x' })).not.toBe(2);
  });

  it('ranks small typos at tier 3', () => {
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座恐布屋', author: 'x' })).toBe(3);
  });

  it('requires both titles >= 4 chars for the edit-distance tier (R1: short names must not collect unrelated neighbors)', () => {
    // 2-3 字书名的距离 1/2 近邻全是无关书：活着→活在、边城→边城纪、三体→三休。
    // 这些必须淘汰（Infinity），否则 SOURCE_SIMILAR 候选会被短名近邻淹没。
    expect(sourceTitleSimilarity('活着', { title: '活在', author: 'x' })).toBe(Number.POSITIVE_INFINITY);
    expect(sourceTitleSimilarity('边城', { title: '边城纪', author: 'x' })).toBe(Number.POSITIVE_INFINITY);
    expect(sourceTitleSimilarity('三体', { title: '三休', author: 'x' })).toBe(Number.POSITIVE_INFINITY);
    // 短名仍可走相等（tier 0）与包含档（短侧 ≥4 才启用，短名同样不适用）。
    expect(sourceTitleSimilarity('活着', { title: '活着', author: 'x' })).toBe(0);
    expect(sourceTitleSimilarity('活着', { title: '活着的理由', author: 'x' })).toBe(Number.POSITIVE_INFINITY);
  });

  it('pins the edit-distance threshold at 2 (R2: widening to 5 must fail this test)', () => {
    // 距离 3-5 的书名不允许进候选；MAX_EDIT_DISTANCE 改成 5 会让这两行变绿而红掉本用例。
    expect(sourceTitleSimilarity('我有一座恐怖屋全本', { title: '我有一座恐布屋子读', author: 'x' })).toBe(Number.POSITIVE_INFINITY); // 距离 3
    expect(sourceTitleSimilarity('全球高等学校', { title: '全球低等幼儿园', author: 'x' })).toBe(Number.POSITIVE_INFINITY); // 距离 4
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '我有一座恐布屋', author: 'x' })).toBe(3); // 距离 1 仍进
  });

  it('rejects unrelated books entirely (negative control)', () => {
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '全球高武', author: 'x' })).toBe(Number.POSITIVE_INFINITY);
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '超神机械师', author: 'x', alias: '全球高武' })).toBe(Number.POSITIVE_INFINITY);
    expect(sourceTitleSimilarity('我有一座恐怖屋', { title: '', author: 'x' })).toBe(Number.POSITIVE_INFINITY);
  });
});
