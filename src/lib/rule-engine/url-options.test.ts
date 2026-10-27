// urlopt1028：ENGINE_URL_OPTIONS —— URL 字段值的 legado `url,{选项}` 后缀在进 host 门前剥掉（取页语义不变的选项才剥）；
// 开关严格口径、语义版本位、按源/按字段判据、选项接受集、门面与准入可读性腿接线。全部为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { readabilityShadow, type AdmissionTransport } from './admission';
import { engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision, type CompileOptions } from './compile';
import type { RawSource } from './compile-smoke';
import { ENGINE_SEMANTICS_URL_OPTIONS_BIT, engineSemanticsVersion, engineUrlOptionsEnabled } from './syntax-flags';
import { stripUrlOptions, urlOptionFields, urlOptionHead } from './url-options';

const SITE = 'https://book15.net';
const SEARCH_URL = `${SITE}/s?q={{key}}`;
const TOC_URL = `${SITE}/toc/1.html`;
const WEBVIEW = ",{'webView': true}";
const ON: CompileOptions = { urlOptionsEnabled: true };
const OFF: CompileOptions = { urlOptionsEnabled: false };

const rulesOf = (over: Record<string, Record<string, unknown>> = {}): Record<string, unknown> => ({
  ruleSearch: { bookList: '.book', name: '.name@text', bookUrl: 'a@href', ...over.ruleSearch },
  ruleBookInfo: { name: 'h1@text', tocUrl: '.toc@href', ...over.ruleBookInfo },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: `a@href##$##${WEBVIEW}`, ...over.ruleToc },
  ruleContent: { content: '.content@text', ...over.ruleContent },
});
const sourceOf = (rules: Record<string, unknown>) => ({ url: `${SITE}/engine/`, searchUrl: SEARCH_URL, rules });
const engineSource = (rules: Record<string, unknown>, options: CompileOptions = ON): EngineSource => ({
  url: `${SITE}/engine/`, name: '引擎源', searchUrl: SEARCH_URL, compiled: compileSource(sourceOf(rules), options),
});
const fakeContext = (pages: Map<string, string>, requested: string[] = []): SourceRequestContext => ({
  page: async (url: string) => {
    requested.push(url);
    const text = pages.get(url);
    if (text === undefined) throw new Error('Unexpected engine request: ' + url);
    return { url, text };
  },
}) as unknown as SourceRequestContext;

const TOC_PAGE = '<div class="chapter"><a href="/c/1.html">第一章</a></div><div class="chapter"><a href="/c/2.html">第二章</a></div>';

afterEach(() => { vi.unstubAllEnvs(); });

describe('开关与语义版本', () => {
  it('engineUrlOptionsEnabled 严格口径', () => {
    expect(engineUrlOptionsEnabled({})).toBe(false);
    expect(engineUrlOptionsEnabled({ ENGINE_URL_OPTIONS: '0' })).toBe(false);
    expect(engineUrlOptionsEnabled({ ENGINE_URL_OPTIONS: 'yes' })).toBe(false);
    expect(engineUrlOptionsEnabled({ ENGINE_URL_OPTIONS: ' On ' })).toBe(true);
    expect(engineUrlOptionsEnabled({ ENGINE_URL_OPTIONS: 'TRUE' })).toBe(true);
    expect(engineUrlOptionsEnabled({ ENGINE_URL_OPTIONS: '1' })).toBe(true);
  });

  it('URL 选项位 +131072，1–131072 逐字不变', () => {
    expect(ENGINE_SEMANTICS_URL_OPTIONS_BIT).toBe(131072);
    const all = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 131072);
  });

  it('只有判出 URL 选项字段的源翻 revision', () => {
    const withOptions = sourceOf(rulesOf());
    const plain = sourceOf(rulesOf({ ruleToc: { chapterUrl: 'a@href' } }));
    expect(engineSourceRevision(withOptions, ON)).not.toBe(engineSourceRevision(withOptions, OFF));
    expect(engineSourceRevision(plain, ON)).toBe(engineSourceRevision(plain, OFF));
  });
});

describe('按源/按字段判据', () => {
  it('五个 URL 字段原文含 `,{` 或 webView 才挂', () => {
    expect([...urlOptionFields(rulesOf())]).toEqual(['ruleToc.chapterUrl']);
    const all = rulesOf({
      ruleSearch: { bookUrl: '$.url@js:result+",{\'webView\':true}"' },
      ruleBookInfo: { tocUrl: '{{$.toc}},{"webView":true}' },
      ruleToc: { nextTocUrl: 'a.next@href##$##,{"webView":true}' },
      ruleContent: { nextContentUrl: 'a.next@href##$##,{"webView":true}' },
    });
    expect([...urlOptionFields(all)].sort()).toEqual([
      'ruleBookInfo.tocUrl', 'ruleContent.nextContentUrl', 'ruleSearch.bookUrl', 'ruleToc.chapterUrl', 'ruleToc.nextTocUrl',
    ]);
    // 非 URL 字段不算。
    expect(urlOptionFields(rulesOf({ ruleToc: { chapterUrl: 'a@href', chapterName: 'a@text##$##,{x}' } })).size).toBe(0);
  });

  it('源写了 ruleContent.webJs/sourceRegex：取正文页的两字段不挂，其余照挂', () => {
    for (const extra of [{ webJs: 'document.body.innerHTML' }, { sourceRegex: '.*\\.mp3' }]) {
      const rules = rulesOf({
        ruleBookInfo: { tocUrl: `.toc@href##$##${WEBVIEW}` },
        ruleContent: { nextContentUrl: `a.next@href##$##${WEBVIEW}`, ...extra },
      });
      expect([...urlOptionFields(rules)]).toEqual(['ruleBookInfo.tocUrl']);
    }
  });

  it('compileSource：on 才给判出的字段挂 urlOptions；skipped 字段不动', () => {
    const on = compileSource(sourceOf(rulesOf()), ON).get('ruleToc.chapterUrl');
    const off = compileSource(sourceOf(rulesOf()), OFF).get('ruleToc.chapterUrl');
    expect(on && !('skipped' in on) && on.urlOptions).toBe(true);
    expect(off && !('skipped' in off) && off.urlOptions).toBeUndefined();
    expect(compileSource(sourceOf(rulesOf()), ON).get('ruleToc.chapterName')).not.toHaveProperty('urlOptions');
  });
});

describe('选项接受集（urlOptionHead）', () => {
  const URL = `${SITE}/c/1.html`;
  it('无选项原样；取页语义不变的选项剥成前半', () => {
    expect(urlOptionHead(URL)).toBe(URL);
    for (const option of [
      "{'webView': true}", '{"webView":true}', '{"webView":"true","webViewDelayTime":1000}', '{webView:1}', '{"webView":false}',
      '{"method":"GET","body":"a=1"}', '{"origin":"https://x.example"}', '{"unknown":{"a":[1,2]}}', '{"retry":3}', '{"retry":"2"}',
      '{"charset":"utf-8"}', '{"charset":"UTF8"}', '{"charset":""}', '{"headers":{}}', '{"headers":""}', '{"headers":"{}"}',
      '{"webJs":"x()"}', '{"webView":true,"webJs":""}', '{"js":null}',
    ]) {
      expect(urlOptionHead(`${URL},${option}`), option).toBe(URL);
      expect(urlOptionHead(`${URL} , ${option}`), option).toBe(URL);
    }
  });

  it('选项读不出或不是对象：legado 整段忽略 → 前半', () => {
    for (const option of ['{webView', '{"a":1,}', '{"a":1} tail']) expect(urlOptionHead(`${URL},${option}`), option).toBe(URL);
  });

  it('改变请求或口径不定的选项：null（调用方用原值，与 off 同）', () => {
    for (const option of [
      '{"method":"POST","body":"a=1"}', '{"method":"post"}', '{"headers":{"Referer":"https://book15.net/"}}', '{"headers":"{\\"User-Agent\\":\\"x\\"}"}',
      '{"charset":"gbk"}', '{"js":"result"}', '{"type":"zip"}', '{"serverID":1}', '{"webView":true,"webJs":"x()"}',
      '{"retry":1.5}', '{"retry":"x"}', '{"webViewDelayTime":true}', '{"webView":true,"webView":false}',
    ]) {
      expect(urlOptionHead(`${URL},${option}`), option).toBeNull();
    }
  });

  it('stripUrlOptions：未挂原值；挂了且被拒也回原值', () => {
    const value = `${URL},{'webView': true}`;
    expect(stripUrlOptions(value, undefined)).toBe(value);
    expect(stripUrlOptions(value, true)).toBe(URL);
    expect(stripUrlOptions(`${URL},{"method":"POST"}`, true)).toBe(`${URL},{"method":"POST"}`);
  });
});

describe('门面接线', () => {
  it('目录 chapterUrl：on 剥成纯地址、off 丢章（逐字同改前）', async () => {
    const pages = new Map([[TOC_URL, TOC_PAGE]]);
    const on = await engineFetchToc(engineSource(rulesOf()), TOC_URL, fakeContext(pages));
    expect(on.chapters).toEqual([{ url: `${SITE}/c/1.html`, title: '第一章' }, { url: `${SITE}/c/2.html`, title: '第二章' }]);
    const off = await engineFetchToc(engineSource(rulesOf(), OFF), TOC_URL, fakeContext(pages));
    expect(off.chapters).toEqual([]);
  });

  it('被拒的选项（POST）on 态原值照旧（与 off 逐字同）', async () => {
    const rules = rulesOf({ ruleToc: { chapterUrl: 'a@href##$##,{"method":"POST","body":"x"}' } });
    const pages = new Map([[TOC_URL, TOC_PAGE]]);
    const on = await engineFetchToc(engineSource(rules), TOC_URL, fakeContext(pages));
    const off = await engineFetchToc(engineSource(rules, OFF), TOC_URL, fakeContext(pages));
    expect(on).toEqual(off);
    expect(on.chapters.every((c) => !c.url.endsWith('/c/1.html') && !c.url.endsWith('/c/2.html'))).toBe(true);
  });

  it('双引号选项 off 态被编码进路径（改前缺陷形态），on 剥成纯地址', async () => {
    const rules = rulesOf({ ruleToc: { chapterUrl: 'a@href##$##,{"webView":true}' } });
    const pages = new Map([[TOC_URL, TOC_PAGE]]);
    const off = await engineFetchToc(engineSource(rules, OFF), TOC_URL, fakeContext(pages));
    expect(off.chapters[0]?.url).not.toBe(`${SITE}/c/1.html`);
    const on = await engineFetchToc(engineSource(rules), TOC_URL, fakeContext(pages));
    expect(on.chapters.map((c) => c.url)).toEqual([`${SITE}/c/1.html`, `${SITE}/c/2.html`]);
  });

  it('nextTocUrl 翻页：on 跟到纯地址', async () => {
    const page2 = `${SITE}/toc/1_2.html`;
    const rules = rulesOf({ ruleToc: { chapterUrl: 'a@href', nextTocUrl: `a.next@href##$##${WEBVIEW}` } });
    const pages = new Map([
      [TOC_URL, `${TOC_PAGE}<a class="next" href="/toc/1_2.html">下页</a>`],
      [page2, '<div class="chapter"><a href="/c/3.html">第三章</a></div>'],
    ]);
    const requested: string[] = [];
    const result = await engineFetchToc(engineSource(rules), TOC_URL, fakeContext(pages, requested));
    expect(requested).toEqual([TOC_URL, page2]);
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章']);
  });

  it('搜索 bookUrl 与详情 tocUrl：on 剥成纯地址', async () => {
    const rules = rulesOf({
      ruleSearch: { bookUrl: `a@href##$##${WEBVIEW}` },
      ruleBookInfo: { tocUrl: `.toc@href##$##${WEBVIEW}` },
    });
    const source = engineSource(rules);
    const searchPage = `${SITE}/s?q=${encodeURIComponent('书名')}`;
    const pages = new Map([
      [searchPage, '<div class="book"><span class="name">书名</span><a href="/b/1.html">x</a></div>'],
      [`${SITE}/b/1.html`, '<h1>书名</h1><a class="toc" href="/toc/1.html">目录</a>'],
    ]);
    const results = await engineSearchBook(source, '书名', fakeContext(pages));
    expect(results.map((r) => r.bookUrl)).toEqual([`${SITE}/b/1.html`]);
    const detail = await engineFetchDetail(source, `${SITE}/b/1.html`, fakeContext(pages));
    expect(detail.tocUrl).toBe(TOC_URL);
  });

  it('正文 nextContentUrl：on 跟到纯地址', async () => {
    const rules = rulesOf({ ruleContent: { nextContentUrl: `a.next@href##$##${WEBVIEW}` } });
    const pages = new Map([
      [`${SITE}/c/1.html`, '<div class="content">上半</div><a class="next" href="/c/1_2.html">下页</a>'],
      [`${SITE}/c/1_2.html`, '<div class="content">下半</div>'],
    ]);
    const result = await engineFetchContent(engineSource(rules), `${SITE}/c/1.html`, fakeContext(pages));
    expect(result.text).toBe('上半\n下半');
  });
});

describe('准入可读性腿接线', () => {
  const HOST = 'rd.example.com';
  const BASE = `https://${HOST}`;
  const rawSource = (): RawSource => ({
    bookSourceUrl: BASE, bookSourceName: '合成源', searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
    ruleBookInfo: { tocUrl: `.tocl@href##$##${WEBVIEW}` },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: `a@href##$##${WEBVIEW}` },
    ruleContent: { content: '.c' },
  }) as RawSource;
  const site = () => {
    const paths: string[] = [];
    const routes: Record<string, string> = {
      '/b/1': '<a class="tocl" href="/b/1/toc">目录</a>',
      '/b/1/toc': `<ul class="toc">${[0, 1, 2].map((i) => `<li><a href="/c/${i}">第${i + 1}章</a></li>`).join('')}</ul>`,
      '/c/1': `<div class="c">${'字'.repeat(800)}</div>`,
    };
    const fetchPage = vi.fn<AdmissionTransport>(async (input) => {
      const { pathname } = new URL(input);
      paths.push(pathname);
      const body = routes[pathname];
      return new Response(`<html><body>${body ?? 'nf'}</body></html>`, {
        status: body === undefined ? 404 : 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    return { fetchPage, paths };
  };
  const options = (fetchPage: AdmissionTransport) => ({
    fetchPage, declaredHosts: new Set([HOST]), signal: new AbortController().signal, throttleMs: 0,
  });
  const sample = { url: '/b/1', pageUrl: `${BASE}/s?q=x` };

  it('on：tocUrl/chapterUrl 剥选项后可读', async () => {
    vi.stubEnv('ENGINE_URL_OPTIONS', '1');
    const stub = site();
    const result = await readabilityShadow(rawSource(), sample, options(stub.fetchPage));
    expect(result).toEqual({ verdict: 'readable', chapters: 3, chars: 800, error: '' });
    expect(stub.paths).toEqual(['/b/1', '/b/1/toc', '/c/1']);
  });

  it('off：tocUrl 带选项过不了门（逐字同改前）', async () => {
    vi.stubEnv('ENGINE_URL_OPTIONS', '0');
    const stub = site();
    const result = await readabilityShadow(rawSource(), sample, options(stub.fetchPage));
    expect(result.verdict).toBe('url_invalid');
    expect(stub.paths).toEqual(['/b/1']);
  });
});
