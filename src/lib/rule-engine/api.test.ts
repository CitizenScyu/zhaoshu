import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import {
  engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource,
  type EngineSearchResult, type EngineTocResult, type EngineContentResult,
} from './api';
import { compileSource } from './compile';

// 引擎门面单测（M1 任务 4 §7.1）：只做「取页 + 解释」；取页经注入的假 context，
// 校验函数/传输层都是真实的（引擎自身零网络、零定时器）。

const SEARCH_URL = 'https://book15.net/s?q={{key}}';
const BOOK_URL = 'https://book15.net/detail/1.html';
const TOC_URL = 'https://book15.net/toc/1.html';
const CHAPTER_URL = 'https://book15.net/c/1.html';

const rules: Record<string, unknown> = {
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: { name: '.title@text', author: '.writer@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};

function engineSource(overrides: Record<string, unknown> = {}): EngineSource {
  const merged = { ...rules, ...overrides };
  return {
    url: 'https://book15.net/engine/', name: '引擎源', searchUrl: SEARCH_URL,
    compiled: compileSource({ url: 'https://book15.net/engine/', searchUrl: SEARCH_URL, rules: merged }),
  };
}

function fakeContext(pages: Map<string, string>): SourceRequestContext {
  return {
    page: async (url: string) => {
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected engine request: ' + url);
      return { url, text };
    },
  } as unknown as SourceRequestContext;
}

const searchKey = 'https://book15.net/s?q=' + encodeURIComponent('测试书');

describe('引擎门面四函数（M1 任务 4 §7.1）', () => {
  it('engineSearchBook 展开搜索模板并解释 bookList → name/author/bookUrl（绝对化）', async () => {
    const pages = new Map([[searchKey,
      '<div class="book"><span class="name">测试书</span><span class="author">作者</span><a href="/detail/1.html">x</a></div>'
      + '<div class="book"><span class="name">无名</span><span class="author">佚名</span><a href="/detail/2.html">y</a></div>']]);
    const results = await engineSearchBook(engineSource(), '测试书', fakeContext(pages));
    expect(results).toEqual([
      { title: '测试书', author: '作者', bookUrl: BOOK_URL },
      { title: '无名', author: '佚名', bookUrl: 'https://book15.net/detail/2.html' },
    ]);
  });

  it('engineFetchDetail 解释 ruleBookInfo（含 tocUrl 绝对化）', async () => {
    const pages = new Map([[BOOK_URL,
      '<h1 class="title">测试书</h1><span class="writer">作者</span><a class="toc" href="/toc/1.html">目录</a>']]);
    expect(await engineFetchDetail(engineSource(), BOOK_URL, fakeContext(pages))).toEqual({
      title: '测试书', author: '作者', tocUrl: TOC_URL,
    });
  });

  it('engineFetchToc 解释 chapterList 并按 nextTocUrl 翻页拼接', async () => {
    const toc2 = 'https://book15.net/toc/2.html';
    const pages = new Map([
      [TOC_URL, '<li class="chapter"><a href="/c/1.html">第一章</a></li><a class="next" href="/toc/2.html">下一页</a>'],
      [toc2, '<li class="chapter"><a href="/c/2.html">第二章</a></li>'],
    ]);
    const source = engineSource({ ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: '.next@href' } });
    expect(await engineFetchToc(source, TOC_URL, fakeContext(pages))).toEqual({
      chapters: [
        { url: 'https://book15.net/c/1.html', title: '第一章' },
        { url: 'https://book15.net/c/2.html', title: '第二章' },
      ],
    });
  });

  it('engineFetchContent 解释 content 并按 nextContentUrl 翻页拼接', async () => {
    const pages = new Map([
      [CHAPTER_URL, '<div class="content">第一段</div><a class="next" href="/c/2.html">下一章</a>'],
      ['https://book15.net/c/2.html', '<div class="content">第二段</div>'],
    ]);
    const source = engineSource({ ruleContent: { content: '.content@text', nextContentUrl: '.next@href' } });
    expect(await engineFetchContent(source, CHAPTER_URL, fakeContext(pages))).toEqual({ text: '第一段\n第二段' });
  });

  it('产出 URL 不过运行时 host 门时被丢弃（不猜测、不外泄）', async () => {
    const pages = new Map([[searchKey,
      '<div class="book"><span class="name">测试书</span><a href="https://evil.invalid/detail/1.html">x</a></div>']]);
    expect(await engineSearchBook(engineSource(), '测试书', fakeContext(pages))).toEqual([]);
  });
});

describe('导出面快照（M1 任务 4 v3 E5 结构断言）', () => {
  it('模块导出恰为门面四函数；admissionFetch / validateAdmissionUrl 不在其中', async () => {
    const moduleExports = Object.keys(await import('./api')).sort();
    expect(moduleExports).toEqual([
      'engineFetchContent', 'engineFetchDetail', 'engineFetchToc', 'engineSearchBook',
    ]);
    expect(moduleExports).not.toContain('admissionFetch');
    expect(moduleExports).not.toContain('validateAdmissionUrl');
  });

  it('门面类型存在且可用（EngineSource/EngineSearchResult/EngineTocResult/EngineContentResult）', () => {
    const source: EngineSource = engineSource();
    const search: EngineSearchResult = { title: '', author: '', bookUrl: '' };
    const toc: EngineTocResult = { chapters: [] };
    const content: EngineContentResult = { text: '' };
    expect([source.compiled.size > 0, search.bookUrl, toc.chapters.length, content.text]).toEqual([true, '', 0, '']);
  });
});
