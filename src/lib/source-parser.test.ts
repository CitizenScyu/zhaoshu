import { describe, expect, it } from 'vitest';
import {
  chapterTitlesMatch, matchSourceChapter, normalizeChapterTitle,
  parseSourceIdentity, parseSourceChapters, parseSourceChapterText, parseSourceSearch,
  sourceBookMatches, sourceSearchUrl,
} from './source-parser';

const bookUrl = 'https://book15.net/books/details42.html';

describe('supported source parser', () => {
  it('normalizes book brackets, full-width characters and spacing without dropping sequels', () => {
    expect(sourceBookMatches({ title: '《Ａ 书》', author: '作者' }, { title: 'a书', author: ' 作 者 ' })).toBe(true);
    expect(sourceBookMatches({ title: 'A书', author: '作者' }, { title: 'A书2', author: '作者' })).toBe(false);
    expect(sourceBookMatches({ title: 'A书', author: '作者' }, { title: 'A书', author: '同名作者' })).toBe(false);
    expect(sourceBookMatches({ title: 'A书', author: '作者' }, { title: 'A书', author: '' })).toBe(false);
    expect(sourceBookMatches({ title: 'A书', author: '佚名' }, { title: 'A书', author: '作者' })).toBe(true);
  });

  it('decodes metadata entities regardless of attribute ordering', () => {
    expect(parseSourceIdentity(`<meta content='Ａ书' property='og:novel:book_name'><meta property="og:novel:author" content="甲&middot;乙">`))
      .toEqual({ title: 'Ａ书', author: '甲·乙' });
  });

  it('expands only simple GET templates and encodes the search term', () => {
    const result = sourceSearchUrl('/books/search.html?kw={{key}}&page={{page}}', '书&作者', 'https://book15.net/');
    expect(new URL(result).searchParams.get('kw')).toBe('书&作者');
    expect(new URL(result).searchParams.get('page')).toBe('1');
  });

  it.each([undefined, '@js:result', '/search?q={{java.get()}}', 'https://evil.invalid/?q={{key}}', 'http://book15.net/?q={{key}}', '/search?q={{key}},{"method":"POST"}'])(
    'rejects unsupported search rules %j', (rule) => {
      expect(() => sourceSearchUrl(rule, '书', 'https://book15.net/')).toThrow();
    },
  );

  it('only returns exact title search hits, deduplicated', () => {
    const html = '<a href="/books/details42.html"><b>Ａ书</b></a><a href="/books/details42.html">a书</a><a href="/books/details43.html">a书续</a>';
    expect(parseSourceSearch(html, 'https://book15.net/books/search.html?kw=a', 'a书')).toEqual([bookUrl]);
  });

  // MS-07/MS-16:坏锚点只跳过、不抛(基线会在第一个 javascript: 锚点上把整源打死),
  // 跨站链接(不落在同站根内)也不算命中 —— 两道口径与 parseSourceDetailLinks 对齐。
  it('skips unparsable anchors and cross-site links instead of throwing', () => {
    const html = '<a href="javascript:void(0)">a书</a>'
      + '<a href="https://baidu.com/books/details42.html">a书</a>'
      + '<a href="/books/details42.html">a书</a>';
    expect(parseSourceSearch(html, 'https://book15.net/books/search.html?kw=a', 'a书')).toEqual([bookUrl]);
  });

  it('does not accept cross-domain search hits or directory links', () => {
    // MS-07/MS-16 后跨站锚点从「抛 SourcePolicyError」改为「跳过」:不再炸整源,只交白卷。
    expect(parseSourceSearch('<a href="https://evil.invalid/books/details42.html">书</a>', bookUrl, '书')).toEqual([]);
    expect(() => parseSourceChapters('<dd><a href="https://evil.invalid/chapter/index42-1.html">第一章</a></dd>', bookUrl)).toThrow();
  });

  it('rejects another book in the directory and deduplicates repeated chapters', () => {
    expect(() => parseSourceChapters('<dd><a href="/chapter/index43-1.html">第一章</a></dd>', bookUrl)).toThrow('其他书籍');
    expect(parseSourceChapters('<dd><a href="/chapter/index42-1.html">第一章</a></dd>'.repeat(2), bookUrl))
      .toEqual([{ url: 'https://book15.net/chapter/index42-1.html', title: '第一章' }]);
  });

  it('extracts the content container and strips source templates while retaining prose', () => {
    const html = '<li class="chapter-content-panel-menu"><p>章节目录</p></li><li class="reader chapter-content"><div><p>正文 &lt;符号&gt; &amp; 文本</p><p>第二段（本章完）</p><p>请记住本书首发域名 book15</p><p>12345678</p></div></li><p>下一章</p>';
    expect(parseSourceChapterText(html)).toBe('正文 <符号> & 文本\n第二段');
  });

  it.each([
    '<li class="chapter-content-panel"><p>只有菜单</p></li>',
    '<li class="chapter-content"><p>章节错误，请联系管理员</p></li>',
    '<li class="chapter-content"><p></p></li>',
    '<li class="chapter-content"><p>' + '字'.repeat(32_769) + '</p></li>',
  ])('refuses empty, invalid or oversized chapter content', (html) => {
    expect(() => parseSourceChapterText(html)).toThrow();
  });

  it('rejects a chapter whose heading disagrees with the directory', () => {
    expect(() => parseSourceChapterText('<h1>第二章</h1><li class="chapter-content"><p>正文</p></li>', '第一章')).toThrow('标题');
    // 无关标题仍拒:换源后标题比对放宽(「第1章」=「第一章」),但底线不变 ——
    // 正文页标题若既不是同章号也不是同一主体,绝不能当成这一章交付。
    expect(() => parseSourceChapterText('<h1>风起云涌</h1><li class="chapter-content"><p>正文</p></li>', '第一章')).toThrow('标题');
  });
});

// 洞 4:章节标题对齐(换源与正文校验共用)。归一化层吸收「第1章」/「第一章」这类同义写法,
// 但完全无关的章必须落 Infinity —— 这正是本组负对照锚点存在的理由。
describe('章节标题对齐(洞 4)', () => {
  const chapters = (...titles: string[]) => titles.map((title, i) => ({ url: `https://book15.net/chapter/index42-${i + 1}.html`, title }));

  it('折叠章号写法:第一章 = 第1章 = 第 1 章,并去尾部标点', () => {
    expect(normalizeChapterTitle('第一章')).toBe(normalizeChapterTitle('第1章'));
    expect(normalizeChapterTitle('第 1 章 风起')).toBe(normalizeChapterTitle('第一章风起'));
    expect(normalizeChapterTitle('Chapter 1')).toBe(normalizeChapterTitle('Chapter 1'));
    expect(normalizeChapterTitle('第十二章。')).toBe(normalizeChapterTitle('第12章'));
    expect(normalizeChapterTitle('第1章')).not.toBe(normalizeChapterTitle('第2章'));
  });

  it('中文数字与阿拉伯数字互认(含百/千量级),但不同章号不互认', () => {
    expect(normalizeChapterTitle('第一百零五章')).toBe(normalizeChapterTitle('第105章'));
    expect(normalizeChapterTitle('第二十三章')).toBe(normalizeChapterTitle('第23章'));
    expect(normalizeChapterTitle('第一百零五章')).not.toBe(normalizeChapterTitle('第一百五十章'));
  });

  it('chapterTitlesMatch:同义写法 true,完全无关 false(负对照)', () => {
    expect(chapterTitlesMatch('第一章', '第1章')).toBe(true);
    expect(chapterTitlesMatch('第一章 风起', '第1章 风起')).toBe(true);
    expect(chapterTitlesMatch('第一章 风起', '第1章')).toBe(true);
    expect(chapterTitlesMatch('第一章', '第三章')).toBe(false);
    expect(chapterTitlesMatch('第一章', '全球高武')).toBe(false);
    expect(chapterTitlesMatch('序章', '楔子')).toBe(false);
  });

  it('matchSourceChapter:跨站换写法也能定位到同一章', () => {
    // 备用站把「第一章」写成「第1章 风起」:同章号即可对齐。
    expect(matchSourceChapter(chapters('序言', '第1章 风起', '第2章'), '第一章 风起', 1)).toBe(1);
    expect(matchSourceChapter(chapters('第1章', '第2章'), '第一章')).toBe(0);
  });

  it('matchSourceChapter:重名章取序号最接近当前章的一条,而不是直接失败', () => {
    // 「番外」出现两次(站点把两卷番外同名):旧实现「必须唯一」→ 换源失败;
    // 现在取离当前章序号最近的那一条。
    const duplicated = chapters('第1章', '番外', '第2章', '第3章', '番外', '第4章');
    expect(matchSourceChapter(duplicated, '番外', 4)).toBe(4);
    expect(matchSourceChapter(duplicated, '番外', 1)).toBe(1);
  });

  it('matchSourceChapter:没有标题证据时宁可 null,绝不按序号交付别的章(负对照)', () => {
    // 备用站只有小标题(无章号):序号不构成「这是同一章」的证明 —— 静默交付另一章
    // 比 503 更糟(用户读完才发现串章且无从重试),故一律 null。
    expect(matchSourceChapter(chapters('起风', '落雨', '归途'), '第2章', 1)).toBeNull();
    expect(matchSourceChapter(chapters('起风', '落雨', '归途', '重逢'), '第三章')).toBeNull();
  });
});
