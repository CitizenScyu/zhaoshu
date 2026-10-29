// fieldnet1029：ENGINE_FIELD_NET_JS —— 页面级字段 JS 里的 java.ajax（legado JsExtensions.ajax → 新建 AnalyzeUrl 取 body）：
// 只在 jsoup 重编帧、FIELD_NET_FIELDS 里放行（FieldIr.jsAjax），求值撞到未取地址即中断、调用方取页后整段重放；
// 门面四环节与准入搜索腿各自取页，没有取页上下文时求值失败。规则与页面均为合成形态。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import type { SourceRequestContext } from '@/lib/source-reader';
import type { SourceSearchRequest } from '@/lib/source-parser';
import { searchAdmission, type AdmissionTransport } from './admission';
import { engineFetchContent, engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesFieldNetSyntax } from './compile';
import type { RawSource } from './compile-smoke';
import {
  createScope, evaluateField, evaluateFieldList, evaluateFieldSafe, FieldNetMissError, normalizeBody, withFieldNet, type EvalScope,
} from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { FIELD_NET_FIELDS, parseFieldRule, type ParseOptions } from './parse';
import { evaluateWithFieldNet } from './search-js';
import { ENGINE_SEMANTICS_FIELD_NET_JS_BIT, engineFieldNetJsEnabled, engineSemanticsVersion } from './syntax-flags';
import { RuleEngineError } from './types';

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const PAGE_URL = `${SITE}/p/1.html`;
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const CONTENT = 'ruleContent.content';
const ON: ParseOptions = { jsEnabled: true, jsoupEnabled: true, fieldNetJsEnabled: true };
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};
const scopeOf = (text: string): EvalScope => createScope(normalizeBody(text), PAGE_URL);
const AJAX_CONTENT = `@js:var h = java.ajax("${SITE}/api/c?id=1"); String(h).replace(/<[^>]+>/g, "")`;

const netOn = () => {
  vi.stubEnv('ENGINE_FIELD_NET_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
};

beforeAll(async () => {
  await preloadJsSandbox();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('开关与语义位', () => {
  it.each([['1', true], ['true', true], [' On ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])('%s → %s', (value, expected) => {
    expect(engineFieldNetJsEnabled({ ENGINE_FIELD_NET_JS: value })).toBe(expected);
  });

  it('字段联网位 +4294967296，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_FIELD_NET_JS_BIT).toBe(4294967296);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 31 }, () => true);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 4294967296);
    expect(Number.isSafeInteger(version(...all, true))).toBe(true);
  });

  it('engineSourceRevision：JS、jsoup、字段联网同开且页面级字段经 jsoup 重编用到 java.ajax 才加位，内容 identity 不变', () => {
    const src = { url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: { ruleContent: { content: AJAX_CONTENT } } };
    const all = { jsEnabled: true, jsoupEnabled: true, fieldNetJsEnabled: true };
    const v = (s: { url: string; searchUrl: string; rules: Record<string, unknown> }, o: Record<string, boolean>) => Number(engineSourceRevision(s, o).split(':')[0]);
    expect(v(src, all) - v(src, { ...all, fieldNetJsEnabled: false })).toBe(4294967296);
    for (const off of ['jsEnabled', 'jsoupEnabled']) {
      expect(v(src, { ...all, [off]: false }) - v(src, { ...all, [off]: false, fieldNetJsEnabled: false })).toBe(0);
    }
    // 不在 FIELD_NET_FIELDS 的字段、不含 ajax 的 JS 不加位
    const nameOnly = { ...src, rules: { ruleSearch: { bookList: '.i', name: `@js:String(java.ajax("${SITE}/n"))`, bookUrl: 'a@href' } } };
    expect(v(nameOnly, all)).toBe(v(nameOnly, { ...all, fieldNetJsEnabled: false }));
    const plain = { ...src, rules: { ruleContent: { content: '@js:java.getElements("p").text()' } } };
    expect(v(plain, all)).toBe(v(plain, { ...all, fieldNetJsEnabled: false }));
    expect(engineSourceRevision(src, all).split(':')[1]).toBe(engineSourceRevision(src, {}).split(':')[1]);
  });

  it('sourceUsesFieldNetSyntax 按源判定', () => {
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: true, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false, jsUtilEnabled: false,
      jsonPathEnabled: false, initJsEnabled: false, bookFieldsEnabled: false, listGetEnabled: false, initJsoupEnabled: false,
    };
    expect(sourceUsesFieldNetSyntax({ ruleContent: { content: AJAX_CONTENT } }, flags)).toBe(true);
    expect(sourceUsesFieldNetSyntax({ ruleToc: { chapterName: `@js:String(java.ajax("${SITE}/n"))` } }, flags)).toBe(false);
    expect(sourceUsesFieldNetSyntax({ ruleContent: { content: '#c@text' } }, flags)).toBe(false);
    expect(sourceUsesFieldNetSyntax({ ruleContent: { content: '@js:"ajax"' } }, flags)).toBe(false);
  });
});

describe('parse：只在 jsoup 联网帧里放行', () => {
  it('关：java.ajax 照旧拒；开：页面级字段挂 jsAjax', () => {
    expect(codeOf(() => parseFieldRule(AJAX_CONTENT, { ...ON, fieldNetJsEnabled: false, field: CONTENT }))).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule(AJAX_CONTENT, { ...ON, jsoupEnabled: false, field: CONTENT }))).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule(AJAX_CONTENT, { ...ON, jsEnabled: false, field: CONTENT }))).toBe('unsupported_js');
    const field = on(AJAX_CONTENT, CONTENT);
    expect(field).toMatchObject({ jsoup: true, jsAjax: true });
    expect(on(`@js:String(java.ajax("${SITE}/t"))`, 'ruleBookInfo.tocUrl').jsAjax).toBe(true);
  });

  it('只认 FIELD_NET_FIELDS', () => {
    expect([...FIELD_NET_FIELDS].sort()).toEqual([
      'ruleBookInfo.init', 'ruleBookInfo.tocUrl', 'ruleContent.content', 'ruleSearch.bookList', 'ruleToc.chapterList',
    ]);
    for (const name of ['ruleSearch.name', 'ruleSearch.bookUrl', 'ruleBookInfo.name', 'ruleToc.chapterName', 'ruleToc.chapterUrl',
      'ruleToc.nextTocUrl', 'ruleContent.nextContentUrl']) {
      expect(codeOf(() => on(`@js:String(java.ajax("${SITE}/x"))`, name))).toBe('unsupported_js');
    }
  });

  it('off 态能编的字段逐字不变，不挂 jsAjax；其余沙箱外成员照旧拒', () => {
    for (const rule of ['#c@text@js:result.trim()', '@js:java.getElements("p").text()']) {
      expect(on(rule, CONTENT)).toEqual(parseFieldRule(rule, { ...ON, fieldNetJsEnabled: false, field: CONTENT }));
      expect(on(rule, CONTENT).jsAjax).toBeUndefined();
    }
    expect(codeOf(() => on(`@js:java.ajaxAll(["${SITE}/x"])`, CONTENT))).toBe('unsupported_js');
    expect(codeOf(() => on(`@js:java.get("${SITE}/x")`, CONTENT))).toBe('unsupported_js');
  });

  it('不传选项时读 env', () => {
    const opts = { jsEnabled: true, jsoupEnabled: true, field: CONTENT };
    expect(codeOf(() => parseFieldRule(AJAX_CONTENT, opts))).toBe('unsupported_js');
    vi.stubEnv('ENGINE_FIELD_NET_JS', '1');
    expect(parseFieldRule(AJAX_CONTENT, opts).jsAjax).toBe(true);
  });
});

describe('求值：缺页中断、取页重放', () => {
  const PAGE = '<div id="c"><p>甲</p></div>';
  const API = '<b>乙</b>丙';

  it('没有取页上下文：求值失败（不是待取页）', () => {
    const field = on(AJAX_CONTENT, CONTENT);
    let error: unknown;
    try {
      evaluateField(field, scopeOf(PAGE));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RuleEngineError);
    expect(error).not.toBeInstanceOf(FieldNetMissError);
  });

  it('缓存未命中抛 FieldNetMissError（带原串），命中返回 Java 字符串；JS 里 catch 也吞不掉', () => {
    const field = on(AJAX_CONTENT, CONTENT);
    let miss: unknown;
    try {
      withFieldNet(new Map(), () => evaluateField(field, scopeOf(PAGE)));
    } catch (err) {
      miss = err;
    }
    expect(miss).toBeInstanceOf(FieldNetMissError);
    expect((miss as FieldNetMissError).url).toBe(`${SITE}/api/c?id=1`);
    expect(withFieldNet(new Map([[`${SITE}/api/c?id=1`, API]]), () => evaluateField(field, scopeOf(PAGE)))).toBe('乙丙');
    const swallow = on(`@js:var h; try { h = String(java.ajax("${SITE}/a")); } catch (e) { h = "兜底"; } h`, CONTENT);
    expect(() => withFieldNet(new Map(), () => evaluateField(swallow, scopeOf(PAGE)))).toThrow(FieldNetMissError);
    expect(withFieldNet(new Map([[`${SITE}/a`, '真']]), () => evaluateField(swallow, scopeOf(PAGE)))).toBe('真');
  });

  it('evaluateFieldSafe 不包装待取页；没有取页上下文照旧按字段失败处理', () => {
    const field = on(AJAX_CONTENT, CONTENT);
    expect(() => withFieldNet(new Map(), () => evaluateFieldSafe(CONTENT, field, scopeOf(PAGE)))).toThrow(FieldNetMissError);
    let error: unknown;
    try {
      evaluateFieldSafe(CONTENT, field, scopeOf(PAGE));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RuleEngineError);
    expect(error).not.toBeInstanceOf(FieldNetMissError);
  });

  it('列表链：首段规则 + ajax 页面决定条目', () => {
    const list = on(`.item@js:String(java.ajax("${SITE}/flag")) === "all" ? result : [result.get(0)]`, 'ruleSearch.bookList', { listJsEnabled: true });
    expect(list.jsAjax).toBe(true);
    const page = scopeOf('<ul><li class="item"><a href="/b/1">一</a></li><li class="item"><a href="/b/2">二</a></li></ul>');
    const name = parseFieldRule('a@text', { field: 'ruleSearch.name' });
    const names = (flag: string) => withFieldNet(new Map([[`${SITE}/flag`, flag]]), () => evaluateFieldList(list, page))
      .map((item) => evaluateField(name, item));
    expect(names('all')).toEqual(['一', '二']);
    expect(names('one')).toEqual(['一']);
  });

  it('evaluateWithFieldNet：每个地址取一次、取回后整段重放；同地址不重取', async () => {
    const field = on(`@js:String(java.ajax("${SITE}/a")) + String(java.ajax("${SITE}/b")) + String(java.ajax("${SITE}/a"))`, CONTENT);
    const seen: SourceSearchRequest[] = [];
    const runs = vi.fn(() => evaluateField(field, scopeOf(PAGE)));
    const pages: Record<string, string> = { [`${SITE}/a`]: 'A', [`${SITE}/b`]: 'B' };
    expect(await evaluateWithFieldNet(runs, anyHost, async (request) => {
      seen.push(request);
      return pages[request.url];
    })).toBe('ABA');
    expect(seen.map((r) => r.url)).toEqual([`${SITE}/a`, `${SITE}/b`]);
    expect(runs).toHaveBeenCalledTimes(3);
  });

  it('evaluateWithFieldNet：超过 4 页、页面过大、地址不合口径一律判不支持；取页失败原样抛', async () => {
    const many = on(`@js:var x = ""; for (var i = 0; i < 5; i++) x += String(java.ajax("${SITE}/p" + i)); x`, CONTENT);
    await expect(evaluateWithFieldNet(() => evaluateField(many, scopeOf(PAGE)), anyHost, async () => 'x')).rejects.toThrow('java.ajax 次数过多');
    const field = on(AJAX_CONTENT, CONTENT);
    const run = () => evaluateField(field, scopeOf(PAGE));
    await expect(evaluateWithFieldNet(run, anyHost, async () => 'x'.repeat((1 << 20) + 1))).rejects.toThrow('java.ajax 页面过大');
    await expect(evaluateWithFieldNet(run, anyHost, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    for (const url of ['/rel', `${SITE}/s<1,2>`, 'ftp://book15.net/x']) {
      const bad = on(`@js:String(java.ajax(${JSON.stringify(url)}))`, CONTENT);
      await expect(evaluateWithFieldNet(() => evaluateField(bad, scopeOf(PAGE)), anyHost, async () => 'x')).rejects.toThrow(SourcePolicyError);
    }
    const gated = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: (host) => host === 'book15.net' });
    const other = on('@js:String(java.ajax("https://other.example.com/x"))', CONTENT);
    await expect(evaluateWithFieldNet(() => evaluateField(other, scopeOf(PAGE)), gated, async () => 'x')).rejects.toThrow(SourcePolicyError);
  });

  it('evaluateWithFieldNet：没用 ajax 的求值只跑一遍、不取页', async () => {
    const fetch = vi.fn(async () => '');
    const run = vi.fn(() => 'v');
    expect(await evaluateWithFieldNet(run, anyHost, fetch)).toBe('v');
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

const pagesContext = (pages: Record<string, string>, urls: string[] = []) => ({
  page: async (url: string) => {
    urls.push(url);
    const text = pages[url];
    if (text === undefined) throw new Error(`unexpected ${url}`);
    return { url, text };
  },
}) as unknown as SourceRequestContext;
const engineSource = (rules: Record<string, unknown>): EngineSource => ({
  url: SITE, name: '联网源', searchUrl: `${SITE}/s?q={{key}}`, compiled: compileSource({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules }),
});

describe('门面：ajax 页面经 context.page', () => {
  beforeEach(() => {
    netOn();
    vi.stubEnv('ENGINE_SYNTAX_LIST_JS', '1');
  });

  it('engineFetchContent', async () => {
    const urls: string[] = [];
    const source = engineSource({ ruleContent: { content: AJAX_CONTENT } });
    const context = pagesContext({ [`${SITE}/c/1.html`]: '<div id="c">壳</div>', [`${SITE}/api/c?id=1`]: '<p>正文</p>' }, urls);
    expect(await engineFetchContent(source, `${SITE}/c/1.html`, context)).toEqual({ text: '正文' });
    expect(urls).toEqual([`${SITE}/c/1.html`, `${SITE}/api/c?id=1`]);
  });

  it('engineFetchContent：开关关时字段 skipped，不取 ajax 页', async () => {
    vi.stubEnv('ENGINE_FIELD_NET_JS', '0');
    const source = engineSource({ ruleContent: { content: AJAX_CONTENT } });
    expect(source.compiled.get(CONTENT)).toMatchObject({ skipped: expect.any(String) });
  });

  it('engineSearchBook：bookList 的 ajax 页面取回后重放', async () => {
    const urls: string[] = [];
    const source = engineSource({
      ruleSearch: { bookList: `.i@js:String(java.ajax("${SITE}/flag")) === "all" ? result : []`, name: '.t@text', bookUrl: 'a@href' },
    });
    const context = pagesContext({
      [`${SITE}/s?q=%E7%94%B2`]: '<div class="i"><span class="t">甲书</span><a href="/b/1">x</a></div>', [`${SITE}/flag`]: 'all',
    }, urls);
    expect(await engineSearchBook(source, '甲', context)).toEqual([{ title: '甲书', author: '', bookUrl: `${SITE}/b/1` }]);
    expect(urls).toEqual([`${SITE}/s?q=%E7%94%B2`, `${SITE}/flag`]);
  });

  it('engineFetchDetail：tocUrl 的 ajax 页面', async () => {
    const source = engineSource({
      ruleBookInfo: { name: 'h1@text', tocUrl: `@js:String(java.ajax("${SITE}/api/toc?b=1")).match(/"u":"([^"]+)"/)[1]` },
    });
    const urls: string[] = [];
    const context = pagesContext({ [`${SITE}/b/1`]: '<h1>甲书</h1>', [`${SITE}/api/toc?b=1`]: '{"u":"/toc/1"}' }, urls);
    expect(await engineFetchDetail(source, `${SITE}/b/1`, context)).toMatchObject({ title: '甲书', tocUrl: `${SITE}/toc/1` });
    expect(urls).toEqual([`${SITE}/b/1`, `${SITE}/api/toc?b=1`]);
  });

  it('engineFetchToc：chapterList 的 ajax 页面；章节只收一次', async () => {
    const source = engineSource({
      ruleToc: { chapterList: `li@js:String(java.ajax("${SITE}/api/v")) === "2" ? result : [result.get(0)]`, chapterName: 'a@text', chapterUrl: 'a@href' },
    });
    const urls: string[] = [];
    const context = pagesContext({
      [`${SITE}/toc/1`]: '<ul><li><a href="/c/1">一</a></li><li><a href="/c/2">二</a></li></ul>', [`${SITE}/api/v`]: '2',
    }, urls);
    expect(await engineFetchToc(source, `${SITE}/toc/1`, context)).toEqual({
      chapters: [{ url: `${SITE}/c/1`, title: '一' }, { url: `${SITE}/c/2`, title: '二' }],
    });
    expect(urls).toEqual([`${SITE}/toc/1`, `${SITE}/api/v`]);
  });

  it('取页失败整环节失败', async () => {
    const source = engineSource({ ruleContent: { content: AJAX_CONTENT } });
    await expect(engineFetchContent(source, `${SITE}/c/1.html`, pagesContext({ [`${SITE}/c/1.html`]: '<div id="c">壳</div>' })))
      .rejects.toThrow(`unexpected ${SITE}/api/c?id=1`);
  });
});

describe('准入搜索腿', () => {
  beforeEach(() => {
    netOn();
    vi.stubEnv('ENGINE_SYNTAX_LIST_JS', '1');
  });

  const RESULT_PAGE = '<div class="i"><span class="t">甲书</span><a href="/b/1">x</a></div>';
  const raw = (bookList: string) => ({
    bookSourceUrl: SITE, bookSourceName: '联网源', searchUrl: `${SITE}/s?q={{key}}`, checkKeyWord: '测试',
    ruleSearch: { bookList, name: '.t@text', bookUrl: 'a@href' },
    ruleToc: { chapterList: '.toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
  } as unknown as RawSource);
  const LIST = `.i@js:String(java.ajax("${SITE}/flag")) === "all" ? result : []`;
  const options = (fetchPage: AdmissionTransport, sleep = vi.fn(async () => {})) => ({
    fetchPage, declaredHosts: new Set(['book15.net']), signal: new AbortController().signal, throttleMs: 5, sleep,
  });
  const route = (flag: () => Response) => vi.fn<AdmissionTransport>(async (url) => (
    String(url) === `${SITE}/flag` ? flag() : new Response(RESULT_PAGE, { headers: { 'content-type': 'text/html' } })
  ));

  it('ajax 页面走准入通道，取页前补节流间隔', async () => {
    const fetchPage = route(() => new Response('all'));
    const sleep = vi.fn(async () => {});
    expect(await searchAdmission(raw(LIST), options(fetchPage, sleep))).toMatchObject({ verdict: 'ok', candidateCount: 1 });
    expect(fetchPage.mock.calls.map(([url]) => String(url))).toEqual([`${SITE}/s?q=%E6%B5%8B%E8%AF%95`, `${SITE}/flag`]);
    expect(sleep).toHaveBeenCalled();
    expect(await searchAdmission(raw(LIST), options(route(() => new Response('none'))))).toMatchObject({ verdict: 'no_result' });
  });

  it('ajax 403 → challenge，5xx → http_5xx，4xx → http_4xx，连不上 → conn_fail，门外 → url_invalid', async () => {
    expect(await searchAdmission(raw(LIST), options(route(() => new Response('x', { status: 403 }))))).toMatchObject({ verdict: 'challenge', status: 403 });
    expect(await searchAdmission(raw(LIST), options(route(() => new Response('x', { status: 502 }))))).toMatchObject({ verdict: 'http_5xx', status: 502 });
    expect(await searchAdmission(raw(LIST), options(route(() => new Response('x', { status: 404 }))))).toMatchObject({ verdict: 'http_4xx', status: 404 });
    expect(await searchAdmission(raw(LIST), options(route(() => { throw new TypeError('fetch failed'); })))).toMatchObject({ verdict: 'conn_fail' });
    const offPool = `.i@js:String(java.ajax("https://other.example.com/")) ? result : []`;
    expect(await searchAdmission(raw(offPool), options(route(() => new Response('all'))))).toMatchObject({ verdict: 'url_invalid' });
  });

  it('开关关：bookList 编不过，候选为空、不取 ajax 页', async () => {
    vi.stubEnv('ENGINE_FIELD_NET_JS', '0');
    const fetchPage = route(() => new Response('all'));
    expect(await searchAdmission(raw(LIST), options(fetchPage))).toMatchObject({ verdict: 'no_result' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
