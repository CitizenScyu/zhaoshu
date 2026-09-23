import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import {
  engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource,
  type EngineSearchResult, type EngineTocResult, type EngineContentResult,
} from './api';
import { contentHtmlToText, contentNeedsHtmlToText } from './content-html';
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

describe('引擎源正文 @html → 纯文本（41-HTMLFIX）', () => {
  const htmlSource = (content: string, next = false) => engineSource({
    ruleContent: next ? { content, nextContentUrl: '.next@href' } : { content },
  });

  it('① .con@html 规则 + <p> 段落 → 段落换行拼接', async () => {
    const pages = new Map([[CHAPTER_URL, '<div class="con"><p>段一</p><p>段二</p></div>']]);
    const result = await engineFetchContent(htmlSource('.con@html'), CHAPTER_URL, fakeContext(pages));
    expect(result.text).toBe('段一\n段二');
    expect(result.text).not.toContain('<p>');
  });

  it('② <br> 与实体（&nbsp; &amp; 十六进制数字实体）正确解码', async () => {
    const pages = new Map([[CHAPTER_URL, '<div class="con">甲&nbsp;乙<br>丙&amp;丁&#x4e2d;</div>']]);
    expect((await engineFetchContent(htmlSource('.con@html'), CHAPTER_URL, fakeContext(pages))).text)
      .toBe('甲 乙\n丙&丁中');
  });

  it('③ <script> 与 <style> 连同内容整段删除', async () => {
    const pages = new Map([[CHAPTER_URL,
      '<div class="con"><script>alert(1)</script><p>正文</p><style>.x{color:red}</style></div>']]);
    const text = (await engineFetchContent(htmlSource('.con@html'), CHAPTER_URL, fakeContext(pages))).text;
    expect(text).toBe('正文');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('④ 纯文本正文（无标签，含「1<2」）逐字节不变', async () => {
    // 基线是 evaluateText 的既有产出（它统一 trim 首尾，行内全角缩进保留），转换必须在其上恒等。
    const plain = '第一段 1<2 且 a>b\n　　第二段';
    const pages = new Map([[CHAPTER_URL, `<div class="content">　　${plain}</div>`]]);
    const source = engineSource({ ruleContent: { content: '.content@text' } });
    expect((await engineFetchContent(source, CHAPTER_URL, fakeContext(pages))).text).toBe(plain);
  });

  it('⑤ 两页正文各自转换后再以换行拼接', async () => {
    const pages = new Map([
      [CHAPTER_URL, '<div class="con"><p>甲</p><p>乙</p></div><a class="next" href="/c/2.html">下一页</a>'],
      ['https://book15.net/c/2.html', '<div class="con"><p>丙&amp;丁</p></div>'],
    ]);
    expect((await engineFetchContent(htmlSource('.con@html', true), CHAPTER_URL, fakeContext(pages))).text)
      .toBe('甲\n乙\n丙&丁');
  });

  it('S5 行首全角缩进保留在段落内，空段落与纯缩进行被压掉', () => {
    // 缩进写在 <p> 内才是段落缩进；标签前的裸缩进单独成行，只含全角空格的行按空行压缩。
    expect(contentHtmlToText('<p>　　甲</p><p></p><p>乙</p>')).toBe('　　甲\n乙');
    expect(contentHtmlToText('　　<p>甲</p><p>　　</p><p>乙</p>')).toBe('甲\n乙');
  });
});

// ---------------------------------------------------------------- 41-HTMLFIX 复审修复（B1–B4 / S1–S7 / R1–R4）
describe('正文转纯文本按规则类型判定（41-HTMLFIX 复审）', () => {
  const htmlSource = (content: string) => engineSource({ ruleContent: { content } });
  const fetch = async (rule: string, body: string) => (
    await engineFetchContent(htmlSource(rule), CHAPTER_URL, fakeContext(new Map([[CHAPTER_URL, body]])))
  ).text;

  it('B1 @text 规则的正文逐字节透传（<+字母、空白、已解码实体都不被改写）', async () => {
    const cases: [string, string][] = [
      ['<div class="content">如果a&lt;b，而 x&gt;y，那么结论成立。</div>', '如果a<b，而 x>y，那么结论成立。'],
      ['<div class="content">获得技能&lt;Lv.10&gt;火球术，属性&lt;HP+100&gt;</div>', '获得技能<Lv.10>火球术，属性<HP+100>'],
      ['<div class="content">He said &lt;Hello World&gt; and left</div>', 'He said <Hello World> and left'],
      ['<div class="content">他大喊&lt;!&gt;然后离开</div>', '他大喊<!>然后离开'],
      ['<div class="content">第一段  \n\n\n第二段 a&lt;b</div>', '第一段  \n\n\n第二段 a<b'],
      ['<div class="content">符号 &amp;amp; 表示与，a&lt;b 时成立</div>', '符号 &amp; 表示与，a<b 时成立'],
    ];
    for (const [body, expected] of cases) {
      expect(await fetch('.content@text', body)).toBe(expected);
    }
  });

  it('B1 不写后缀的正文规则同样透传（字段层默认末端是 @text，evaluate.ts:220）', async () => {
    expect(await fetch('.content', '<div class="content">a&lt;b 且 x&gt;y</div>')).toBe('a<b 且 x>y');
  });

  it('B3 无标签的 @html 输出也解码实体', async () => {
    expect(await fetch('.con@html', '<div class="con">甲&amp;乙&lt;丙&gt;丁&nbsp;戊</div>'))
      .toBe('甲&乙<丙>丁 戊');
  });

  it('B3 @p@html 多段（段落内无标签）逐段解码，含 &nbsp; 缩进', async () => {
    const body = '<div id="nr1"><p>&nbsp;&nbsp;&nbsp;&nbsp;段一&amp;x</p><p>&nbsp;&nbsp;&nbsp;&nbsp;段二</p></div>';
    expect(await fetch('#nr1@p@html', body)).toBe('段一&x\n段二');
  });

  it('B3 同书有无内联标签的章节解码结果一致', async () => {
    const withTag = '<div id="nr1"><p>&nbsp;&nbsp;段一&amp;x</p><p>段二<b>粗</b></p></div>';
    expect(await fetch('#nr1@p@html', withTag)).toBe('段一&x\n段二粗');
  });

  it('B4 越界数字实体输出 U+FFFD 且不抛（&#0;、代理区、超 U+10FFFF）', () => {
    expect(() => contentHtmlToText('<p>x&#99999999;y</p>')).not.toThrow();
    expect(contentHtmlToText('<p>x&#99999999;y</p>')).toBe('x�y');
    expect(contentHtmlToText('<p>x&#x110000;y</p>')).toBe('x�y');
    expect(contentHtmlToText('<p>x&#0;y</p>')).toBe('x�y');
    expect(contentHtmlToText('<p>x&#xD800;y</p>')).toBe('x�y');
  });

  it('B4 JSON 正文里的越界实体端到端不抛', async () => {
    const body = JSON.stringify({ data: { content: '<p>x&#99999999;y&#0;z</p>' } });
    expect(await fetch('$.data.content', body)).toBe('x�y�z');
  });

  it('S1 大写十六进制实体 &#X4E2D; 解码', () => {
    expect(contentHtmlToText('<p>&#X4E2D;</p>')).toBe('中');
  });

  it('S2 &constructor; 等原型链名字原样保留', () => {
    expect(contentHtmlToText('<p>A&constructor;B&toString;C&__proto__;D</p>'))
      .toBe('A&constructor;B&toString;C&__proto__;D');
  });

  it('S4 未闭合的 <script> 截到末尾，脚本内容不进正文', () => {
    expect(contentHtmlToText('<p>正文</p><script>var leak = 1;')).toBe('正文');
  });

  it('S6 零宽字符（U+200B/200C/200D）被删除', () => {
    expect(contentHtmlToText('<p>段​一‌二‍</p>')).toBe('段一二');
  });

  it('S7 JSON 正文的 HTML4 命名实体解码', async () => {
    const body = JSON.stringify({ data: { content: '&ldquo;你好&rdquo;&hellip;&mdash;&middot;' } });
    expect(await fetch('$.data.content', body)).toBe('“你好”…—·');
  });

  it('R1 大写块级标签同样换行', () => {
    expect(contentHtmlToText('<P CLASS="x">段一</P><DIV style="a:b">段二</DIV>')).toBe('段一\n段二');
    expect(contentHtmlToText('甲<BR>乙<BR/>丙')).toBe('甲\n乙\n丙');
  });

  it('R2 注释整段删除（含注释内的标签与 >）', () => {
    expect(contentHtmlToText('<p>甲<!-- 广告 <p>x</p> a>b -->乙</p>')).toBe('甲乙');
    expect(contentHtmlToText('<p>甲<!-- 未闭合')).toBe('甲');
  });

  it('R3 行首尾半角空白被规整，全角缩进保留', () => {
    expect(contentHtmlToText('<p>  段一  </p><p>　　段二</p>')).toBe('段一\n　　段二');
    expect(contentHtmlToText('<p>甲</p><p>   </p><p>乙</p>')).toBe('甲\n乙');
  });

  it('R4 先剥标签再解码：转义文本 &lt;b&gt; 保留为字面尖括号', () => {
    expect(contentHtmlToText('<p>甲&lt;b&gt;乙&lt;/b&gt;</p>')).toBe('甲<b>乙</b>');
  });

  it('混合 || 分支（html||text）保守转换：@html 命中时解码', async () => {
    const merged = { ...rules, ruleContent: { content: '.con@html||.other@text' } };
    const source: EngineSource = {
      url: 'https://book15.net/engine/', name: '引擎源', searchUrl: SEARCH_URL,
      compiled: compileSource(
        { url: 'https://book15.net/engine/', searchUrl: SEARCH_URL, rules: merged },
        { orEnabled: true },
      ),
    };
    const body = '<div class="con">甲&amp;乙</div>';
    const pages = new Map([[CHAPTER_URL, body]]);
    expect((await engineFetchContent(source, CHAPTER_URL, fakeContext(pages))).text).toBe('甲&乙');
  });

  it('规则类型判定：text 类透传，其余转换', () => {
    const fieldOf = (content: string, orEnabled = false) => compileSource(
      { url: 'https://book15.net/engine/', searchUrl: SEARCH_URL, rules: { ...rules, ruleContent: { content } } },
      { orEnabled },
    ).get('ruleContent.content');
    expect(contentNeedsHtmlToText(fieldOf('.content@text') as never)).toBe(false);
    expect(contentNeedsHtmlToText(fieldOf('.content@ownText') as never)).toBe(false);
    expect(contentNeedsHtmlToText(fieldOf('.content') as never)).toBe(false);
    expect(contentNeedsHtmlToText(fieldOf('.a@text||.b@ownText', true) as never)).toBe(false);
    expect(contentNeedsHtmlToText(fieldOf('.con@html') as never)).toBe(true);
    expect(contentNeedsHtmlToText(fieldOf('#nr1@p@html') as never)).toBe(true);
    expect(contentNeedsHtmlToText(fieldOf('.con@html||.other@text', true) as never)).toBe(true);
    expect(contentNeedsHtmlToText(fieldOf('$.data.content') as never)).toBe(true);
    expect(contentNeedsHtmlToText(undefined)).toBe(false);
  });
});

describe('正文转纯文本性能（41-HTMLFIX 复审 B2：10 万字符病态输入）', () => {
  const time = (input: string) => {
    const start = performance.now();
    contentHtmlToText(input);
    return performance.now() - start;
  };
  const cases: [string, string][] = [
    ['<p> + < ×n', '<p>' + '<'.repeat(100_000)],
    ['<a ×n/2', '<a'.repeat(50_000)],
    ['<!-- ×n/4 不闭合', '<!--'.repeat(25_000)],
    ['<script> ×n/8 不闭合', '<script>'.repeat(12_500)],
    ['<p>x + 空格×n + y</p>', '<p>x' + ' '.repeat(100_000) + 'y</p>'],
    ['行内 &nbsp; ×n/6', '<p>x' + '&nbsp;'.repeat(16_667) + 'y</p>'],
  ];
  for (const [name, input] of cases) {
    it(`${name}（len=${input.length}）< 500ms`, () => {
      expect(time(input)).toBeLessThan(500);
    });
  }
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
