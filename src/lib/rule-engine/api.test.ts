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
    const merged = { ...rules, ruleToc: { ...(rules.ruleToc as Record<string, unknown>), ...ruleToc } };
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
  it('模块导出恰为门面四函数 + 正文翻页上限常量；admissionFetch / validateAdmissionUrl 不在其中', async () => {
    const moduleExports = Object.keys(await import('./api')).sort();
    // MAX_CONTENT_PAGES 是唯一的常量例外（41-M1.1）：阅读器正文 context 的 L1 上限必须不低于翻页上限，
    // 共用同一个值防止两边漂移（limit 低于它时引擎正文第 2 页就撞 SOURCE_SCOPE_EXHAUSTED）。
    expect(moduleExports).toEqual([
      'MAX_CONTENT_PAGES', 'engineFetchContent', 'engineFetchDetail', 'engineFetchToc', 'engineSearchBook',
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

// ---------------------------------------------------------------- 41-PAGEFIX：正文翻页遇「下一页 = 下一章」即停
// legado BookContent.analyzeContent：下一页 getAbsoluteURL 后等于下一章 ⇒ break，不请求那一页。
// 夹具仿 cuoceng：每章一页，#linkNext 指向下一章。context 记录每次取页，断言请求序列而不只是拼接结果。
describe('正文翻页遇下一章即停（41-PAGEFIX）', () => {
  const chapter = (n: number) => `https://book15.net/cc/${n}.html`;
  const page = (text: string, next?: string) =>
    `<div id="content">${text}</div>` + (next === undefined ? '' : `<a id="linkNext" href="${next}">下一章</a>`);
  const cuoceng = engineSource({ ruleContent: { content: '#content@text', nextContentUrl: '#linkNext@href' } });
  /** 三章一页一章：第 1、2 章的 linkNext 指向下一章（相对地址），第 3 章是末章、没有 linkNext。 */
  const threeChapters = () => new Map([
    [chapter(1), page('第1章正文', '/cc/2.html')],
    [chapter(2), page('第2章正文', '/cc/3.html')],
    [chapter(3), page('第3章正文')],
  ]);
  function recording(pages: Map<string, string>) {
    const requested: string[] = [];
    const inner = fakeContext(pages);
    const context = { page: async (url: string) => { requested.push(url); return inner.page(url); } } as unknown as SourceRequestContext;
    return { requested, context };
  }

  it('① cuoceng 同型：读第 N 章只请求本章 1 页，正文不含第 N+1 章（strict 同样不误报）', async () => {
    for (const strict of [false, true]) {
      const first = recording(threeChapters());
      expect(await engineFetchContent(cuoceng, chapter(1), first.context, strict, chapter(2))).toEqual({ text: '第1章正文' });
      expect(first.requested).toEqual([chapter(1)]);
      const middle = recording(threeChapters());
      expect(await engineFetchContent(cuoceng, chapter(2), middle.context, strict, chapter(3))).toEqual({ text: '第2章正文' });
      expect(middle.requested).toEqual([chapter(2)]);
    }
  });

  it('② 真多页章节（下一页是本章第 2 页，第 2 页才指向下一章）⇒ 照常翻页、正确拼接', async () => {
    const pages = new Map([
      [chapter(1), page('第1章上半', '/cc/1_2.html')],
      ['https://book15.net/cc/1_2.html', page('第1章下半', '/cc/2.html')],
      [chapter(2), page('第2章正文')],
    ]);
    for (const strict of [false, true]) {
      const run = recording(pages);
      expect(await engineFetchContent(cuoceng, chapter(1), run.context, strict, chapter(2))).toEqual({ text: '第1章上半\n第1章下半' });
      expect(run.requested).toEqual([chapter(1), 'https://book15.net/cc/1_2.html']);
    }
  });

  it('③ 不传 nextChapterUrl（末章 / 旧调用）⇒ 行为与改前相同：照旧沿 linkNext 翻页拼接', async () => {
    for (const args of [[], [false], [false, undefined]] as const) {
      const run = recording(threeChapters());
      expect(await engineFetchContent(cuoceng, chapter(1), run.context, ...args)).toEqual({ text: '第1章正文\n第2章正文\n第3章正文' });
      expect(run.requested).toEqual([chapter(1), chapter(2), chapter(3)]);
    }
    const last = recording(threeChapters());
    expect(await engineFetchContent(cuoceng, chapter(3), last.context, true)).toEqual({ text: '第3章正文' });
    expect(last.requested).toEqual([chapter(3)]);
  });

  it('④ 相对/绝对、带 fragment 的写法规范化后认作同一地址；查询串不同不算同一地址', async () => {
    const cases: Array<{ next: string; nextChapterUrl: string }> = [
      { next: '/cc/2.html', nextChapterUrl: 'https://book15.net/cc/2.html' },
      { next: 'https://book15.net/cc/2.html', nextChapterUrl: '/cc/2.html' },
      { next: '2.html', nextChapterUrl: 'https://book15.net/cc/2.html#chapter' },
      { next: 'https://book15.net/cc/2.html#top', nextChapterUrl: '2.html' },
    ];
    for (const { next, nextChapterUrl } of cases) {
      const run = recording(new Map([[chapter(1), page('第1章正文', next)], [chapter(2), page('第2章正文')]]));
      expect(await engineFetchContent(cuoceng, chapter(1), run.context, true, nextChapterUrl)).toEqual({ text: '第1章正文' });
      expect(run.requested).toEqual([chapter(1)]);
    }
    // 查询串原样保留（legado 同样不规范化）：按查询串区分章节/分页的站点，去掉查询串会把本章第 2 页误判成下一章。
    const byQuery = (query: string) => `https://book15.net/cc/read?${query}`;
    const paged = recording(new Map([
      [byQuery('id=1'), page('第1章上半', 'read?id=1&p=2')],
      [byQuery('id=1&p=2'), page('第1章下半', 'read?id=2')],
    ]));
    expect(await engineFetchContent(cuoceng, byQuery('id=1'), paged.context, true, byQuery('id=2'))).toEqual({ text: '第1章上半\n第1章下半' });
    expect(paged.requested).toEqual([byQuery('id=1'), byQuery('id=1&p=2')]);
  });
});
