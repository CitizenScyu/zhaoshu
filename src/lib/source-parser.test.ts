import { describe, expect, it } from 'vitest';
import {
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

  it('does not accept cross-domain search hits or directory links', () => {
    expect(() => parseSourceSearch('<a href="https://evil.invalid/books/details42.html">书</a>', bookUrl, '书')).toThrow();
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
  });
});
