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

// ---------------------------------------------------------------- 准入兼容 L1（admission-compat §3.1 反例 2-6）
// legado 语义（BookChapterList.kt:230-244，取证见 docs/legado-semantics/）：
// ruleToc.chapterUrl 缺失或求值空 → 章节 url 取当前目录页 URL（baseUrl），不是 href 回退。
// 反例要求「尖锐」：mock 里 page.url ≠ source.url ≠ tocUrl，否则「取的是页 URL」没被钉死。
describe('chapterUrl 缺失/求值空 → 取当前目录页 URL（legado baseUrl 兜底）', () => {
  // page.url（跳转后的目录页）与 source.url、tocUrl 都不同——兜底值必须取前者。
  // 调用方传 toc-in（模拟跳转前），context.page 返回 toc-real（跳转后的真实 URL）。
  const tocUrl = 'https://book15.net/toc-in/1.html'; // 调用方传入
  const pageUrl = 'https://book15.net/toc-real/1.html'; // page() 实际返回（含跳转后）

  function fakeRedirectContext(pages: Map<string, string>): SourceRequestContext {
    // 引擎用 tocUrl 作 key 请求；页面真实 URL 是重定向后的 pageUrl（更尖锐的 mock）。
    return {
      page: async (url: string) => {
        const text = pages.get(url === tocUrl ? pageUrl : url);
        if (text === undefined) throw new Error('Unexpected engine request: ' + url);
        return { url: url === tocUrl ? pageUrl : url, text };
      },
    } as unknown as SourceRequestContext;
  }

  function defaultTocSource(ruleToc: Record<string, unknown>): EngineSource {
    const merged = { ...rules, ruleToc: { ...rules.ruleToc, ...ruleToc } };
    return {
      url: 'https://book15.net/engine/', name: '引擎源', searchUrl: SEARCH_URL,
      compiled: compileSource({ url: 'https://book15.net/engine/', searchUrl: SEARCH_URL, rules: merged }),
    };
  }

  it('反例 2：缺 chapterUrl、chapterList 命中 div、chapterName 有文本 → 非空，url=page.url', async () => {
    const pages = new Map([[pageUrl,
      '<div class="chapter"><h3>第一章 标题</h3></div><div class="chapter"><h3>第二章 标题</h3></div>']]);
    const src = defaultTocSource({ chapterList: '.chapter', chapterName: 'h3@text', chapterUrl: undefined });
    const result = await engineFetchToc(src, tocUrl, fakeRedirectContext(pages));
    expect(result.chapters).toEqual([{ url: pageUrl, title: '第一章 标题' }]);
  });

  it('反例 3：chapterUrl 存在但求值空（@href 命中无 href 属性的节点）→ 同样回退 page.url', async () => {
    const pages = new Map([[pageUrl, '<div class="chapter"><h3>第一章</h3><a>无链接</a></div>']]);
    const src = defaultTocSource({ chapterList: '.chapter', chapterName: 'h3@text' });
    const result = await engineFetchToc(src, tocUrl, fakeRedirectContext(pages));
    expect(result.chapters).toEqual([{ url: pageUrl, title: '第一章' }]);
  });

  it('反例 4：chapterUrl 求值出 host 门外的绝对 URL → 丢弃，不静默洗成 page.url', async () => {
    const pages = new Map([[pageUrl,
      '<div class="chapter"><h3>第一章</h3><a href="https://evil.invalid/c/1.html">x</a></div>']]);
    const src = defaultTocSource({ chapterList: '.chapter', chapterName: 'h3@text' });
    const result = await engineFetchToc(src, tocUrl, fakeRedirectContext(pages));
    expect(result.chapters).toEqual([]); // h3@text 有值但节点无 href 语义，evil 链接被丢
  });

  it('反例 5：兜底后多节点同 url → 按 url 去重只剩 1 章（legado LinkedHashSet 同结果）', async () => {
    const pages = new Map([[pageUrl,
      '<div class="chapter"><h3>第一章</h3></div><div class="chapter"><h3>第二章</h3></div><div class="chapter"><h3>第三章</h3></div>']]);
    const src = defaultTocSource({ chapterList: '.chapter', chapterName: 'h3@text' });
    const result = await engineFetchToc(src, tocUrl, fakeRedirectContext(pages));
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].url).toBe(pageUrl);
  });

  it('反例 6：nextTocUrl 翻页时缺 chapterUrl → 每页兜底值是该页的 page.url，不是首页 tocUrl', async () => {
    const page2 = 'https://book15.net/toc-real/2.html';
    const pages = new Map([
      [pageUrl, '<div class="chapter"><h3>第一章</h3></div><a class="next" href="/toc-real/2.html">下一页</a>'],
      [page2, '<div class="chapter"><h3>第二章</h3></div>'],
    ]);
    const src = defaultTocSource({ chapterList: '.chapter', chapterName: 'h3@text', nextTocUrl: '.next@href' });
    const result = await engineFetchToc(src, tocUrl, fakeRedirectContext(pages));
    // 各页兜底值是该页 page.url（两页 URL 不同 ⇒ 不互相吞并），首页 tocUrl 不出现在结果里。
    expect(result.chapters).toEqual([
      { url: pageUrl, title: '第一章' },
      { url: page2, title: '第二章' },
    ]);
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
