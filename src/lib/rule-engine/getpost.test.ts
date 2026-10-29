// getpost1029：ENGINE_SEARCH_GETPOST_JS —— 搜索模板里的 java.get(url, headers) / java.post(url, body, headers)（legado JsExtensions →
// Jsoup.connect(url).followRedirects(false).execute()）：Connection.Response 子集（header / headers(name) 列表 / statusCode / body）、
// 不跟随跳转经两条取页腿与 fetchSourceText 传入状态码与响应头、请求头白名单与 POST 默认表单类型、缓存与 ajax 分开、
// 不复现的成员判不支持、能否构造判定、语义版本位。模板形态取自现网 searchUrl 桶（打码骨架），域名/参数为合成值。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import { fetchSourceText } from '@/lib/source-fetch';
import type { SourceRequestContext } from '@/lib/source-reader';
import { allowedSearchRequestHeaders, searchTemplateUsesGetPost, type SourceSearchRequest } from '@/lib/source-parser';
import { searchAdmission, type AdmissionTransport } from './admission';
import { engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import {
  buildSearchRequest, buildSearchRequestWithNet, prepareSearchJs, searchGetPostJsEnabled, searchJsConstructible, SearchNetPendingError,
  type SearchNetFetch,
} from './search-js';
import { ENGINE_SEMANTICS_SEARCH_GETPOST_JS_BIT, engineSearchGetPostJsEnabled, engineSemanticsVersion } from './syntax-flags';

vi.mock('@/lib/supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supported-sources')>();
  return { ...actual, isRetiredBuiltinHost: () => false };
});

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const HOME_URL = `${SITE}/`; // source.key 按 URL 归一（补尾斜杠）
const FINAL = `${SITE}/so/`; // 跳转目标（不跟随，只读 Location）
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const LOC_TPL = `@js: var su = '${SITE}/s?q=' + key; var loc = java.get(su, {}).headers('Location')[0]; loc + '&p=1'`;
const HEADER_TPL = `@js: String(java.get(source.key, {}).header("location")) + 'x?q=' + key`;
const STR_TPL = `@js: String(java.get(source.key, {}).headers("location")).replace(/\\[(.*)\\]/, "$1") + 'x?q=' + key`;
const POST_TPL = `@js: var r = java.post('${SITE}/api', 'q=' + key, {}); '${SITE}/r?id=' + JSON.parse(r.body()).id`;

type Page = { status?: number; headers?: [string, string][]; text: string };
/** 取页：按请求地址给页面；noFollow 记进 seen。 */
const pagesFrom = (pages: Record<string, Page>, seen: { request: SourceSearchRequest; noFollow: boolean }[] = []): SearchNetFetch =>
  async (request, options) => {
    seen.push({ request, noFollow: options?.noFollow === true });
    const page = pages[request.url];
    if (page === undefined) throw new Error(`unexpected ${request.url}`);
    return { url: request.url, ...page };
  };
const redirect = (location: string): Page => ({ status: 302, headers: [['location', location], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']], text: '' });
const netOn = () => {
  vi.stubEnv('ENGINE_SEARCH_NET_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
};
const getPostOn = () => {
  netOn();
  vi.stubEnv('ENGINE_SEARCH_GETPOST_JS', '1');
};

beforeAll(async () => {
  await prepareSearchJs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('开关与语义位', () => {
  it.each([['1', true], ['true', true], [' On ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])('%s → %s', (value, expected) => {
    expect(engineSearchGetPostJsEnabled({ ENGINE_SEARCH_GETPOST_JS: value })).toBe(expected);
  });

  it('须搜索联网 JS 生效', () => {
    const env = (patch: Record<string, string>) => patch as unknown as NodeJS.ProcessEnv;
    expect(searchGetPostJsEnabled(env({ ENGINE_SEARCH_GETPOST_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(false);
    expect(searchGetPostJsEnabled(env({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(false);
    expect(searchGetPostJsEnabled(env({
      ENGINE_SEARCH_GETPOST_JS: '1', ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1',
    }))).toBe(true);
  });

  it('getpost 位 +17179869184，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_SEARCH_GETPOST_JS_BIT).toBe(17179869184);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 33 }, () => true);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 17179869184);
    expect(Number.isSafeInteger(version(...all, true))).toBe(true);
  });

  it('searchTemplateUsesGetPost：java.post 与带第二实参的 java.get 才算', () => {
    expect(searchTemplateUsesGetPost(LOC_TPL)).toBe(true);
    expect(searchTemplateUsesGetPost(POST_TPL)).toBe(true);
    expect(searchTemplateUsesGetPost("{{java . get (java.get('u'), {})}}")).toBe(true);
    expect(searchTemplateUsesGetPost("@js: java.get('k') + ',' + key")).toBe(false);
    expect(searchTemplateUsesGetPost("@js: java.getString('a,b')")).toBe(false);
    expect(searchTemplateUsesGetPost(`${SITE}/s?q={{key}}`)).toBe(false);
    expect(searchTemplateUsesGetPost(undefined)).toBe(false);
  });

  it('engineSourceRevision：联网四条件与 getpost 同开且模板有 HTTP 形态 get/post 才加位，内容 identity 不变', () => {
    const rules = { ruleSearch: { bookList: '.b' } };
    const src = { url: SITE, searchUrl: LOC_TPL, rules };
    const all = { searchJsEnabled: true, jsEnabled: true, jsoupEnabled: true, searchNetJsEnabled: true, searchGetPostJsEnabled: true };
    const v = (s: typeof src, o: Record<string, boolean>) => Number(engineSourceRevision(s, o).split(':')[0]);
    expect(v(src, all) - v(src, { ...all, searchGetPostJsEnabled: false })).toBe(17179869184);
    for (const off of ['searchJsEnabled', 'jsEnabled', 'jsoupEnabled', 'searchNetJsEnabled']) {
      expect(v(src, { ...all, [off]: false }) - v(src, { ...all, [off]: false, searchGetPostJsEnabled: false })).toBe(0);
    }
    for (const searchUrl of [`${SITE}/s?q={{key}}`, `@js: java.put('a', key); '${SITE}/s?q=' + java.get('a')`]) {
      const other = { ...src, searchUrl };
      expect(v(other, all)).toBe(v(other, { ...all, searchGetPostJsEnabled: false }));
    }
    expect(engineSourceRevision(src, all).split(':')[1]).toBe(engineSourceRevision(src, {}).split(':')[1]);
  });

  it('allowedSearchRequestHeaders：白名单过滤、不分大小写后设覆盖', () => {
    expect(allowedSearchRequestHeaders([['Cookie', 'c'], ['referer', 'a'], ['Referer', 'b'], ['X-Token', 't']])).toEqual({ Referer: 'b' });
    expect(allowedSearchRequestHeaders([['Cookie', 'c']])).toBeUndefined();
  });
});

describe('联网帧求值', () => {
  it('关：两参 java.get 照旧读变量失败、java.post 不存在，模板判不支持', () => {
    netOn();
    for (const tpl of [LOC_TPL, POST_TPL]) expect(() => buildSearchRequest(tpl, '书', SITE, anyHost, true)).toThrow(SourcePolicyError);
  });

  it('开：同步入口抛待取请求（http 种类，按 Jsoup.connect 口径）', () => {
    getPostOn();
    let pending: unknown;
    try {
      buildSearchRequest(LOC_TPL, '书', SITE, anyHost, true);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(SearchNetPendingError);
    expect((pending as SearchNetPendingError).kind).toBe('http');
    expect((pending as SearchNetPendingError).connect).toBe(false);
    expect((pending as SearchNetPendingError).request).toEqual({ url: `${SITE}/s?q=%E4%B9%A6`, method: 'GET', charset: 'utf-8' });
  });

  it('不跟随跳转读 Location：headers(名)[0]、header(名)、String(headers(名)).replace', async () => {
    getPostOn();
    const seen: { request: SourceSearchRequest; noFollow: boolean }[] = [];
    const fetch = pagesFrom({ [`${SITE}/s?q=%E4%B9%A6`]: redirect(`${FINAL}?q=x`), [HOME_URL]: redirect(FINAL) }, seen);
    expect((await buildSearchRequestWithNet(LOC_TPL, '书', SITE, anyHost, true, fetch)).request.url).toBe(`${FINAL}?q=x&p=1`);
    expect(seen).toEqual([{ request: { url: `${SITE}/s?q=%E4%B9%A6`, method: 'GET', charset: 'utf-8' }, noFollow: true }]);
    expect((await buildSearchRequestWithNet(HEADER_TPL, '书', SITE, anyHost, true, fetch)).request.url).toBe(`${FINAL}x?q=%E4%B9%A6`);
    expect((await buildSearchRequestWithNet(STR_TPL, '书', SITE, anyHost, true, fetch)).request.url).toBe(`${FINAL}x?q=%E4%B9%A6`);
  });

  it('statusCode()/body()/size()/get()/isEmpty()；同名多值 header 以 ", " 连接、列表转串 "[a, b]"；缺头得 null', async () => {
    getPostOn();
    const tpl = "@js: var r = java.get(source.key, {'User-Agent': 'ua'}); var c = r.headers('Set-Cookie');"
      + " java.put('s', String(r.statusCode())); java.put('h', r.header('SET-COOKIE')); java.put('l', String(c));"
      + " java.put('n', String(c.size())); java.put('g', c.get(1)); java.put('e', String(r.headers('x').isEmpty()));"
      + " java.put('m', String(r.header('x'))); java.put('b', r.body()); java.put('t', typeof r.statusCode());"
      + ` '${SITE}/s?q=' + key`;
    const page: Page = { status: 200, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']], text: 'hello' };
    const seen: { request: SourceSearchRequest; noFollow: boolean }[] = [];
    const built = await buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, pagesFrom({ [HOME_URL]: page }, seen));
    expect(built.vars).toEqual({ s: '200', h: 'a=1, b=2', l: '[a=1, b=2]', n: '2', g: 'b=2', e: 'true', m: 'null', b: 'hello', t: 'number' });
    expect(seen[0].request.headers).toEqual({ 'User-Agent': 'ua' });
  });

  it('java.post：body 原样、白名单头、没给 Content-Type 补 jsoup 默认表单类型', async () => {
    getPostOn();
    const seen: { request: SourceSearchRequest; noFollow: boolean }[] = [];
    const fetch = pagesFrom({ [`${SITE}/api`]: { status: 200, headers: [['content-type', 'application/json']], text: '{"id":"7"}' } }, seen);
    expect((await buildSearchRequestWithNet(POST_TPL, '书', SITE, anyHost, true, fetch)).request.url).toBe(`${SITE}/r?id=7`);
    expect(seen).toEqual([{
      request: {
        url: `${SITE}/api`, method: 'POST', body: 'q=书', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        charset: 'utf-8',
      },
      noFollow: true,
    }]);
    const json = `@js: var r = java.post('${SITE}/api', JSON.stringify({k: key}), {'content-type': 'application/json', Cookie: 'c=1'});`
      + ` '${SITE}/r?id=' + JSON.parse(r.body()).id`;
    seen.length = 0;
    await buildSearchRequestWithNet(json, '书', SITE, anyHost, true, fetch);
    expect(seen[0].request).toMatchObject({ method: 'POST', body: '{"k":"书"}', headers: { 'content-type': 'application/json' } });
  });

  it('ajax 与 java.get 同一地址各取一次（缓存分开），共用 4 页上限', async () => {
    getPostOn();
    const seen: { request: SourceSearchRequest; noFollow: boolean }[] = [];
    const tpl = `@js: var b = java.ajax(source.key) + java.get(source.key, {}).body(); java.put('n', String(b.length)); '${SITE}/s?q=' + key`;
    const built = await buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, pagesFrom({ [HOME_URL]: { status: 200, headers: [], text: 'ab' } }, seen));
    expect(built.vars).toEqual({ n: '4' });
    expect(seen.map((s) => s.noFollow)).toEqual([false, true]);
    const many = `@js: for (var i = 0; i < 5; i++) java.get('${SITE}/p' + i, {}); '${SITE}/s?q=' + key`;
    const all = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`${SITE}/p${i}`, { status: 200, headers: [], text: 'x' }]));
    await expect(buildSearchRequestWithNet(many, '书', SITE, anyHost, true, pagesFrom(all))).rejects.toThrow('java.get/post 次数过多');
  });

  it('取页没带状态码/响应头、取页失败判失败', async () => {
    getPostOn();
    await expect(buildSearchRequestWithNet(HEADER_TPL, '书', SITE, anyHost, true, async () => 'body')).rejects.toThrow(SourcePolicyError);
    await expect(buildSearchRequestWithNet(HEADER_TPL, '书', SITE, anyHost, true, async (r) => ({ url: r.url, text: '' })))
      .rejects.toThrow(SourcePolicyError);
    await expect(buildSearchRequestWithNet(HEADER_TPL, '书', SITE, anyHost, true, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('不复现的形态判不支持：headers() 整表、cookies()、url()、Response 转串、非对象/数组/带访问器的请求头、三参 get、两参 post、相对地址', async () => {
    getPostOn();
    const fetch = pagesFrom({ [HOME_URL]: redirect(FINAL) });
    for (const expr of [
      'java.get(source.key, {}).headers()',
      'java.get(source.key, {}).cookies()',
      'java.get(source.key, {}).url()',
      'java.get(source.key, {})',
      "java.get(source.key, {}).headers('location') + java.get(source.key, {}).statusCode",
      'Object.keys(java.get(source.key, {})).join()',
      "java.get(source.key, '{}').body()",
      'java.get(source.key, [1]).body()',
      "java.get(source.key, Object.defineProperty({}, 'Referer', { get: function(){ return 'x'; }, enumerable: true })).body()",
      'java.get(source.key, {}, 3000).body()',
      "java.post(source.key, 'q').body()",
      "java.get('/rel', {}).body()",
      "java.get(source.key, {}).headers('location')[5]",
    ]) {
      const tpl = `@js: String(${expr}) + 'x?q=' + key`;
      await expect(buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, fetch), expr).rejects.toThrow(SourcePolicyError);
    }
  });

  it('单参 java.get 照旧读变量', async () => {
    getPostOn();
    const tpl = `@js: java.put('u', '${SITE}/s'); var l = java.get(java.get('u'), {}).header('location'); l + '?q=' + key`;
    expect((await buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, pagesFrom({ [`${SITE}/s`]: redirect(FINAL) }))).request.url)
      .toBe(`${FINAL}?q=%E4%B9%A6`);
  });
});

describe('能否构造判定', () => {
  it('searchJsConstructible：到首个 java.get/post 为止，地址能解析即算能构造', () => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    netOn();
    expect(searchJsConstructible(LOC_TPL, SITE)).toBe(false);
    vi.stubEnv('ENGINE_SEARCH_GETPOST_JS', '1');
    expect(searchJsConstructible(LOC_TPL, SITE)).toBe(true);
    expect(searchJsConstructible(`@js: java.get('/rel', {}).body(); '${SITE}/s?q=' + key`, SITE)).toBe(false);
  });
});

const SEARCH_RULES = { bookList: '.i', name: '.t@text', bookUrl: 'a@href' };
const RESULT_PAGE = '<div class="i"><span class="t">甲书</span><a href="/b/1">x</a></div>';

describe('取页腿不跟随跳转、带状态码与响应头', () => {
  beforeEach(() => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    getPostOn();
  });

  it('engineSearchBook：context.page 收 noFollow，状态码与响应头传给 java.get', async () => {
    const calls: { url: string; noFollow?: boolean }[] = [];
    const context = {
      page: async (url: string, opts: { noFollow?: boolean } = {}) => {
        calls.push({ url, noFollow: opts.noFollow });
        return opts.noFollow ? { url, text: '', status: 302, headers: [['location', FINAL]] } : { url, text: RESULT_PAGE };
      },
    } as unknown as SourceRequestContext;
    const source: EngineSource = {
      url: SITE, name: '联网源', searchUrl: HEADER_TPL, compiled: compileSource({ url: SITE, searchUrl: HEADER_TPL, rules: { ruleSearch: SEARCH_RULES } }),
    };
    expect(await engineSearchBook(source, '甲', context)).toEqual([{ title: '甲书', author: '', bookUrl: `${SITE}/b/1` }]);
    expect(calls).toEqual([{ url: HOME_URL, noFollow: true }, { url: `${FINAL}x?q=%E7%94%B2`, noFollow: undefined }]);
  });

  it('searchAdmission：准入通道不跟随跳转，3xx 算取到；4xx 判失败', async () => {
    const urls: string[] = [];
    let status = 302;
    const fetchPage = vi.fn<AdmissionTransport>(async (url) => {
      urls.push(String(url));
      if (String(url) === HOME_URL) return new Response('', { status, headers: { location: FINAL } });
      return new Response(RESULT_PAGE, { headers: { 'content-type': 'text/html' } });
    });
    const raw = {
      bookSourceUrl: SITE, bookSourceName: '联网源', searchUrl: HEADER_TPL, checkKeyWord: '测试',
      ruleSearch: SEARCH_RULES,
      ruleToc: { chapterList: '.toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '.c' },
    } as unknown as RawSource;
    const options = () => ({
      fetchPage, declaredHosts: new Set(['book15.net']), signal: new AbortController().signal, throttleMs: 5, sleep: vi.fn(async () => {}),
    });
    expect(await searchAdmission(raw, options())).toMatchObject({ verdict: 'ok', candidateCount: 1 });
    expect(urls).toEqual([HOME_URL, `${FINAL}x?q=%E6%B5%8B%E8%AF%95`]);
    status = 404;
    expect(await searchAdmission(raw, options())).toMatchObject({ verdict: 'http_4xx', status: 404 });
  });
});

describe('fetchSourceText noFollow', () => {
  const base = () => ({ signal: new AbortController().signal });

  it('3xx 不跟随、原样带回状态码与响应头；body 按 HTTP 声明字符集', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([0xc4, 0xe3]), {
      status: 302, headers: { location: '/so/', 'content-type': 'text/html; charset=gbk' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchSourceText(`${SITE}/s`, { ...base(), noFollow: true, responseCharset: 'auto' });
    expect(page).toEqual({
      url: `${SITE}/s`, text: '你', status: 302, headers: [['content-type', 'text/html; charset=gbk'], ['location', '/so/']],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('2xx 不看 meta、没声明按 UTF-8；4xx 照旧抛错；不开 noFollow 逐字不变', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<meta charset="gbk">好', { headers: { 'content-type': 'text/html' } })));
    expect((await fetchSourceText(`${SITE}/s`, { ...base(), noFollow: true })).text).toBe('<meta charset="gbk">好');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 404 })));
    await expect(fetchSourceText(`${SITE}/s`, { ...base(), noFollow: true })).rejects.toThrow('书源 HTTP 404');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
    expect(await fetchSourceText(`${SITE}/s`, base())).toEqual({ url: `${SITE}/s`, text: 'ok' });
  });
});
