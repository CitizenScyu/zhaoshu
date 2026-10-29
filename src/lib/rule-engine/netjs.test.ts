// netjs1029：ENGINE_SEARCH_NET_JS —— 搜索模板里的 java.ajax（legado JsExtensions.ajax → 新建 AnalyzeUrl 取 body）：
// 联网帧（jsoup 包装、Java 字符串）、待取地址的解析与 host 门、异步入口取页重放、门面/准入两条取页腿、能否构造判定、语义版本位。
// 模板形态取自现网 searchUrl 桶（netjs-search-skel 打码骨架），域名/参数为合成值。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import type { SourceRequestContext } from '@/lib/source-reader';
import { searchTemplateUsesAjax, type SourceSearchRequest } from '@/lib/source-parser';
import { searchTemplateRejected } from '@/lib/source-usability';
import { searchAdmission, type AdmissionTransport } from './admission';
import { engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import {
  buildSearchRequest, buildSearchRequestWithNet, prepareSearchJs, searchJsConstructible, SearchNetPendingError, searchNetJsEnabled,
} from './search-js';
import { ENGINE_SEMANTICS_SEARCH_NET_JS_BIT, engineSearchNetJsEnabled, engineSemanticsVersion } from './syntax-flags';

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const HOME = `<html><body><form name="search" action="/so/abc"><input name="s" value="t0k"></form></body></html>`;
const FORM_TPL = `<js>var h = java.ajax(source.key); var a = org.jsoup.Jsoup.parse(h).select('form[name="search"]').attr('action');
a + '?searchkey=' + key</js>`;
const MATCH_TPL = `@js: var hp = java.ajax(baseUrl); var su = hp.match(/action="([^"]+?)"/)[1]; su + ',{"method":"POST","body":"k={{key}}"}'`;
const INLINE_TPL = `{{cookie.removeCookie(source.getKey()); java.ajax(source.getKey()).match(/action="(.+?)"/)[1]}}?searchkey={{key}}`;

const fetchFrom = (pages: Record<string, string>, seen: SourceSearchRequest[] = []) => async (request: SourceSearchRequest) => {
  seen.push(request);
  const body = pages[request.url];
  if (body === undefined) throw new Error(`unexpected ${request.url}`);
  return body;
};
const netOn = () => {
  vi.stubEnv('ENGINE_SEARCH_NET_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
};

beforeAll(async () => {
  await prepareSearchJs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('开关与语义位', () => {
  it.each([['1', true], ['true', true], [' On ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])('%s → %s', (value, expected) => {
    expect(engineSearchNetJsEnabled({ ENGINE_SEARCH_NET_JS: value })).toBe(expected);
  });

  it('须 ENGINE_SYNTAX_JS 与 ENGINE_SYNTAX_JSOUP 同开', () => {
    const env = (patch: Record<string, string>) => patch as unknown as NodeJS.ProcessEnv;
    expect(searchNetJsEnabled(env({ ENGINE_SEARCH_NET_JS: '1' }))).toBe(false);
    expect(searchNetJsEnabled(env({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1' }))).toBe(false);
    expect(searchNetJsEnabled(env({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(false);
    expect(searchNetJsEnabled(env({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(true);
  });

  it('联网位 +2147483648，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_SEARCH_NET_JS_BIT).toBe(2147483648);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 30 }, () => true);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 2147483648);
    expect(Number.isSafeInteger(version(...all, true))).toBe(true);
  });

  it('searchTemplateUsesAjax', () => {
    expect(searchTemplateUsesAjax(FORM_TPL)).toBe(true);
    expect(searchTemplateUsesAjax('{{java . ajax (u)}}')).toBe(true);
    expect(searchTemplateUsesAjax('{{java.ajaxAll(u)}}')).toBe(false);
    expect(searchTemplateUsesAjax(`${SITE}/s?q={{key}}`)).toBe(false);
    expect(searchTemplateUsesAjax(undefined)).toBe(false);
  });

  it('engineSourceRevision：搜索 JS、原始 JS、jsoup、联网四者同开且需 JS 的模板含 java.ajax 才加位，内容 identity 不变', () => {
    const rules = { ruleSearch: { bookList: '.b' } };
    const src = { url: SITE, searchUrl: FORM_TPL, rules };
    const all = { searchJsEnabled: true, jsEnabled: true, jsoupEnabled: true, searchNetJsEnabled: true };
    const v = (s: typeof src, o: Record<string, boolean>) => Number(engineSourceRevision(s, o).split(':')[0]);
    expect(v(src, all) - v(src, { ...all, searchNetJsEnabled: false })).toBe(2147483648);
    for (const off of ['searchJsEnabled', 'jsEnabled', 'jsoupEnabled']) {
      expect(v(src, { ...all, [off]: false }) - v(src, { ...all, [off]: false, searchNetJsEnabled: false })).toBe(0);
    }
    const plain = { ...src, searchUrl: `${SITE}/s?q={{key}}&p={{page-1}}` };
    expect(v(plain, all)).toBe(v(plain, { ...all, searchNetJsEnabled: false }));
    expect(engineSourceRevision(src, all).split(':')[1]).toBe(engineSourceRevision(src, {}).split(':')[1]);
  });
});

describe('联网帧求值', () => {
  it('关：含 java.ajax 的模板照旧判不支持（java.ajax 不存在）', () => {
    vi.stubEnv('ENGINE_SYNTAX_JS', '1');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
    expect(() => buildSearchRequest(FORM_TPL, '书', SITE, anyHost, true)).toThrow(SourcePolicyError);
  });

  it('开：同步入口抛待取地址（已按 legado AnalyzeUrl 解析、过 host 门）', () => {
    netOn();
    let pending: unknown;
    try {
      buildSearchRequest(FORM_TPL, '书', SITE, anyHost, true);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(SearchNetPendingError);
    expect((pending as SearchNetPendingError).key).toBe(SITE);
    expect((pending as SearchNetPendingError).request).toEqual({ url: `${SITE}/`, method: 'GET', charset: 'utf-8' });
  });

  it('Jsoup.parse(java.ajax(…)) 取表单 action 拼搜索地址', async () => {
    netOn();
    const seen: SourceSearchRequest[] = [];
    const built = await buildSearchRequestWithNet(FORM_TPL, '书', SITE, anyHost, true, fetchFrom({ [`${SITE}/`]: HOME }, seen));
    expect(built.request).toEqual({ url: `${SITE}/so/abc?searchkey=%E4%B9%A6`, method: 'GET', charset: 'utf-8' });
    expect(seen).toHaveLength(1);
  });

  it('Java 字符串的 match、拼接、String()、toString() 与 put 存原文', async () => {
    netOn();
    const fetch = fetchFrom({ [`${SITE}/`]: HOME });
    expect((await buildSearchRequestWithNet(MATCH_TPL, '书', SITE, anyHost, true, fetch)).request)
      .toMatchObject({ url: `${SITE}/so/abc`, method: 'POST', body: 'k=%E4%B9%A6' });
    expect((await buildSearchRequestWithNet(INLINE_TPL, '书', SITE, anyHost, true, fetch)).request.url)
      .toBe(`${SITE}/so/abc?searchkey=%E4%B9%A6`);
    const concat = `@js: var h = '' + java.ajax(source.key); var t = String(java.ajax(source.key)); var u = java.ajax(source.key).toString();
      java.put('len', String(h.length === t.length && h === t)); java.put('raw', java.ajax(source.key)); java.put('u', u); '${SITE}/s?q=' + key`;
    const built = await buildSearchRequestWithNet(concat, '书', SITE, anyHost, true, fetch);
    expect(built.vars).toEqual({ len: 'true', raw: HOME, u: HOME });
  });

  it('多个地址各取一次、同一地址不重取；超过 4 页判不支持', async () => {
    netOn();
    const seen: SourceSearchRequest[] = [];
    const pages = { [`${SITE}/a`]: 'A', [`${SITE}/b`]: 'B' };
    const two = `@js: var x = java.ajax('${SITE}/a') + java.ajax('${SITE}/b') + java.ajax('${SITE}/a'); '${SITE}/s?q=' + key + '&x=' + x`;
    expect((await buildSearchRequestWithNet(two, '书', SITE, anyHost, true, fetchFrom(pages, seen))).request.url).toContain('&x=ABA');
    expect(seen.map((r) => r.url)).toEqual([`${SITE}/a`, `${SITE}/b`]);
    const many = `@js: var x = ''; for (var i = 0; i < 5; i++) x += java.ajax('${SITE}/p' + i); '${SITE}/s?q=' + key`;
    const all = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`${SITE}/p${i}`, 'x']));
    await expect(buildSearchRequestWithNet(many, '书', SITE, anyHost, true, fetchFrom(all))).rejects.toThrow('java.ajax 次数过多');
  });

  it('地址：相对地址、`{{…}}`/JS 段/页码占位、host 门外一律判不支持；选项按 legado 口径读', async () => {
    netOn();
    for (const url of ['/rel', `${SITE}/s?q={{key}}`, `${SITE}/s<1,2>`, `@js:'x'`]) {
      const tpl = `@js: java.ajax(${JSON.stringify(url)}); '${SITE}/s?q=' + key`;
      expect(() => buildSearchRequest(tpl, '书', SITE, anyHost, true)).toThrow(SourcePolicyError);
    }
    const gated = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: (host) => host === 'book15.net' });
    expect(() => buildSearchRequest(`@js: java.ajax('https://other.example.com/'); '${SITE}/s?q=' + key`, '书', SITE, gated, true))
      .toThrow(SourcePolicyError);
    const post = `@js: java.ajax('${SITE}/t,{"method":"POST","body":"a=1"}'); '${SITE}/s?q=' + key`;
    let pending: unknown;
    try {
      buildSearchRequest(post, '书', SITE, anyHost, true);
    } catch (error) {
      pending = error;
    }
    expect((pending as SearchNetPendingError).request).toMatchObject({ url: `${SITE}/t`, method: 'POST', body: 'a=1' });
  });

  it('JS 吞掉未命中也不算数；取页失败、页面过大原样失败', async () => {
    netOn();
    const swallow = `@js: var h; try { h = java.ajax(source.key); } catch (e) { h = 'action="/fallback"'; } h.match(/action="([^"]+)"/)[1]`;
    expect((await buildSearchRequestWithNet(swallow, '书', SITE, anyHost, true, fetchFrom({ [`${SITE}/`]: HOME }))).request.url)
      .toBe(`${SITE}/so/abc`);
    await expect(buildSearchRequestWithNet(FORM_TPL, '书', SITE, anyHost, true, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(buildSearchRequestWithNet(FORM_TPL, '书', SITE, anyHost, true, async () => 'x'.repeat((1 << 20) + 1)))
      .rejects.toThrow('java.ajax 页面过大');
  });

  it('非联网模板只求一遍，与同步入口相同', async () => {
    netOn();
    const tpl = `${SITE}/s?q={{key}}&p={{page-1}}`;
    const fetch = vi.fn(async () => '');
    expect((await buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, fetch)).request).toEqual(buildSearchRequest(tpl, '书', SITE, anyHost, true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('字段求值没有 ajax 回调：jsoup 帧里 java.ajax 照旧不存在', async () => {
    netOn();
    const { runJsoup } = await import('./js-sandbox');
    expect(() => runJsoup('java.ajax("https://x.example.com/")', { result: '', baseUrl: SITE }, 'final')).toThrow();
  });
});

describe('能否构造判定', () => {
  it('searchJsConstructible / searchTemplateRejected：到首个 java.ajax 为止，地址能解析即算能构造', () => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    vi.stubEnv('ENGINE_SYNTAX_JS', '1');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
    expect(searchJsConstructible(FORM_TPL, SITE)).toBe(false);
    expect(searchTemplateRejected({ url: SITE, searchUrl: FORM_TPL, rules: {} })).toBe(true);
    vi.stubEnv('ENGINE_SEARCH_NET_JS', '1');
    expect(searchJsConstructible(FORM_TPL, SITE)).toBe(true);
    expect(searchTemplateRejected({ url: SITE, searchUrl: FORM_TPL, rules: {} })).toBe(false);
    expect(searchTemplateRejected({ url: SITE, searchUrl: FORM_TPL, rules: {} }, '甲')).toBe(false);
    expect(searchJsConstructible(`@js: java.ajax('/rel'); '${SITE}/s?q=' + key`, SITE)).toBe(false);
  });
});

const SEARCH_RULES = { bookList: '.i', name: '.t@text', bookUrl: 'a@href' };
const RESULT_PAGE = '<div class="i"><span class="t">甲书</span><a href="/b/1">x</a></div>';

describe('门面与准入取页腿', () => {
  beforeEach(() => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    netOn();
  });

  it('engineSearchBook：ajax 页面与搜索页都经 context.page', async () => {
    const urls: string[] = [];
    const context = {
      page: async (url: string, options?: { request?: { method?: string } }) => {
        urls.push(`${options?.request?.method ?? 'GET'} ${url}`);
        return { url, text: url === `${SITE}/` ? HOME : RESULT_PAGE };
      },
    } as unknown as SourceRequestContext;
    const source: EngineSource = {
      url: SITE, name: '联网源', searchUrl: FORM_TPL, compiled: compileSource({ url: SITE, searchUrl: FORM_TPL, rules: { ruleSearch: SEARCH_RULES } }),
    };
    expect(await engineSearchBook(source, '甲', context)).toEqual([{ title: '甲书', author: '', bookUrl: `${SITE}/b/1` }]);
    expect(urls).toEqual([`GET ${SITE}/`, `GET ${SITE}/so/abc?searchkey=%E7%94%B2`]);
  });

  const raw = (searchUrl: string) => ({
    bookSourceUrl: SITE, bookSourceName: '联网源', searchUrl, checkKeyWord: '测试',
    ruleSearch: SEARCH_RULES,
    ruleToc: { chapterList: '.toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
  } as unknown as RawSource);
  const options = (fetchPage: AdmissionTransport, sleep = vi.fn(async () => {})) => ({
    fetchPage, declaredHosts: new Set(['book15.net']), signal: new AbortController().signal, throttleMs: 5, sleep,
  });

  it('searchAdmission：ajax 页面走准入通道，前后补节流间隔', async () => {
    const urls: string[] = [];
    const fetchPage = vi.fn<AdmissionTransport>(async (url) => {
      urls.push(String(url));
      return new Response(String(url) === `${SITE}/` ? HOME : RESULT_PAGE, { headers: { 'content-type': 'text/html' } });
    });
    const sleep = vi.fn(async () => {});
    const result = await searchAdmission(raw(FORM_TPL), options(fetchPage, sleep));
    expect(result).toMatchObject({ verdict: 'ok', candidateCount: 1 });
    expect(urls).toEqual([`${SITE}/`, `${SITE}/so/abc?searchkey=%E6%B5%8B%E8%AF%95`]);
    expect(sleep).toHaveBeenCalled();
  });

  it('searchAdmission：ajax 403 → challenge，5xx → http_5xx，策略拒 → url_invalid，连不上 → conn_fail', async () => {
    const at = (status: number) => vi.fn<AdmissionTransport>(async () => new Response('x', { status }));
    expect(await searchAdmission(raw(FORM_TPL), options(at(403)))).toMatchObject({ verdict: 'challenge', status: 403 });
    expect(await searchAdmission(raw(FORM_TPL), options(at(502)))).toMatchObject({ verdict: 'http_5xx', status: 502 });
    expect(await searchAdmission(raw(FORM_TPL), options(at(404)))).toMatchObject({ verdict: 'http_4xx', status: 404 });
    const down = vi.fn<AdmissionTransport>(async () => { throw new TypeError('fetch failed'); });
    expect(await searchAdmission(raw(FORM_TPL), options(down))).toMatchObject({ verdict: 'conn_fail' });
    const offPool = `@js: java.ajax('https://other.example.com/'); '${SITE}/s?q=' + key`;
    expect(await searchAdmission(raw(offPool), options(at(200)))).toMatchObject({ verdict: 'url_invalid' });
  });
});
