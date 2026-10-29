// connectnet1029：ENGINE_SEARCH_CONNECT_JS —— 搜索模板里的 java.connect（legado JsExtensions.connect → AnalyzeUrl.getStrResponse，
// 跟随跳转）：StrResponse 子集（raw().request().url() / url() / body()）、最终地址经两条取页腿传入、缓存与 ajax 分开、
// 不复现的成员与 2 参形态判不支持、能否构造判定、语义版本位。模板形态取自现网 searchUrl 桶（打码骨架），域名/参数为合成值。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import type { SourceRequestContext } from '@/lib/source-reader';
import { searchTemplateUsesConnect, type SourceSearchRequest } from '@/lib/source-parser';
import { searchAdmission, type AdmissionTransport } from './admission';
import { engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import {
  buildSearchRequest, buildSearchRequestWithNet, prepareSearchJs, searchConnectJsEnabled, searchJsConstructible, SearchNetPendingError,
} from './search-js';
import { ENGINE_SEMANTICS_SEARCH_CONNECT_JS_BIT, engineSearchConnectJsEnabled, engineSemanticsVersion } from './syntax-flags';

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const FINAL = `${SITE}/m/`; // 首页跳转后的最终地址
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const INLINE_TPL = '{{java.connect(source.getKey()).raw().request().url()}}search.php?q={{key}}';
const SEG_TPL = `@js: var so = java.connect(source.key).raw().request().url(); String(so).replace(/m\\/$/, 'so/') + '?q=' + key`;
const OR_TPL = `@js: var res = java.connect(source.key), url = res.raw().request().url() || res.url(); String(url) + 's?q=' + key`;
const HOME = '<form action="/so/abc"></form>';

/** 取页：按请求地址给 { 最终地址, body }；redirects 里的地址视作已跟随跳转。 */
const pagesFrom = (pages: Record<string, string>, redirects: Record<string, string> = {}, seen: SourceSearchRequest[] = []) =>
  async (request: SourceSearchRequest) => {
    seen.push(request);
    const url = redirects[request.url] ?? request.url;
    const text = pages[url];
    if (text === undefined) throw new Error(`unexpected ${request.url}`);
    return { url, text };
  };
const home = (seen?: SourceSearchRequest[]) => pagesFrom({ [FINAL]: HOME }, { [`${SITE}/`]: FINAL }, seen);
const netOn = () => {
  vi.stubEnv('ENGINE_SEARCH_NET_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JS', '1');
  vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
};
const connectOn = () => {
  netOn();
  vi.stubEnv('ENGINE_SEARCH_CONNECT_JS', '1');
};

beforeAll(async () => {
  await prepareSearchJs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('开关与语义位', () => {
  it.each([['1', true], ['true', true], [' On ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])('%s → %s', (value, expected) => {
    expect(engineSearchConnectJsEnabled({ ENGINE_SEARCH_CONNECT_JS: value })).toBe(expected);
  });

  it('须搜索联网 JS 生效', () => {
    const env = (patch: Record<string, string>) => patch as unknown as NodeJS.ProcessEnv;
    expect(searchConnectJsEnabled(env({ ENGINE_SEARCH_CONNECT_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(false);
    expect(searchConnectJsEnabled(env({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(false);
    expect(searchConnectJsEnabled(env({
      ENGINE_SEARCH_CONNECT_JS: '1', ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1',
    }))).toBe(true);
  });

  it('connect 位 +8589934592，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_SEARCH_CONNECT_JS_BIT).toBe(8589934592);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 32 }, () => true);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 8589934592);
    expect(Number.isSafeInteger(version(...all, true))).toBe(true);
  });

  it('searchTemplateUsesConnect', () => {
    expect(searchTemplateUsesConnect(INLINE_TPL)).toBe(true);
    expect(searchTemplateUsesConnect('{{java . connect (u)}}')).toBe(true);
    expect(searchTemplateUsesConnect('{{java.connectAll(u)}}')).toBe(false);
    expect(searchTemplateUsesConnect(`${SITE}/s?q={{key}}`)).toBe(false);
    expect(searchTemplateUsesConnect(undefined)).toBe(false);
  });

  it('engineSourceRevision：联网四条件与 connect 同开且需 JS 的模板含 java.connect 才加位，内容 identity 不变', () => {
    const rules = { ruleSearch: { bookList: '.b' } };
    const src = { url: SITE, searchUrl: SEG_TPL, rules };
    const all = { searchJsEnabled: true, jsEnabled: true, jsoupEnabled: true, searchNetJsEnabled: true, searchConnectJsEnabled: true };
    const v = (s: typeof src, o: Record<string, boolean>) => Number(engineSourceRevision(s, o).split(':')[0]);
    expect(v(src, all) - v(src, { ...all, searchConnectJsEnabled: false })).toBe(8589934592);
    for (const off of ['searchJsEnabled', 'jsEnabled', 'jsoupEnabled', 'searchNetJsEnabled']) {
      expect(v(src, { ...all, [off]: false }) - v(src, { ...all, [off]: false, searchConnectJsEnabled: false })).toBe(0);
    }
    for (const searchUrl of [`${SITE}/s?q={{key}}`, `@js: java.ajax(source.key); '${SITE}/s?q=' + key`]) {
      const other = { ...src, searchUrl };
      expect(v(other, all)).toBe(v(other, { ...all, searchConnectJsEnabled: false }));
    }
    expect(engineSourceRevision(src, all).split(':')[1]).toBe(engineSourceRevision(src, {}).split(':')[1]);
  });
});

describe('联网帧求值', () => {
  it('关：java.connect 照旧不存在，模板判不支持', () => {
    netOn();
    for (const tpl of [INLINE_TPL, SEG_TPL]) expect(() => buildSearchRequest(tpl, '书', SITE, anyHost, true)).toThrow(SourcePolicyError);
  });

  it('开：同步入口抛待取地址（connect 键另记，已按 legado AnalyzeUrl 解析）', () => {
    connectOn();
    let pending: unknown;
    try {
      buildSearchRequest(SEG_TPL, '书', SITE, anyHost, true);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(SearchNetPendingError);
    expect((pending as SearchNetPendingError).connect).toBe(true);
    expect((pending as SearchNetPendingError).key).not.toBe(SITE);
    expect((pending as SearchNetPendingError).request).toEqual({ url: `${SITE}/`, method: 'GET', charset: 'utf-8' });
  });

  it('raw().request().url() 取跳转后的最终地址：`{{…}}`、String().replace、|| 形态', async () => {
    connectOn();
    const seen: SourceSearchRequest[] = [];
    expect((await buildSearchRequestWithNet(INLINE_TPL, '书', SITE, anyHost, true, home(seen))).request.url)
      .toBe(`${FINAL}search.php?q=%E4%B9%A6`);
    expect(seen.map((r) => r.url)).toEqual([`${SITE}/`]);
    expect((await buildSearchRequestWithNet(SEG_TPL, '书', SITE, anyHost, true, home())).request.url).toBe(`${SITE}/so/?q=%E4%B9%A6`);
    expect((await buildSearchRequestWithNet(OR_TPL, '书', SITE, anyHost, true, home())).request.url).toBe(`${FINAL}s?q=%E4%B9%A6`);
  });

  it('url()/body() 得 Java 字符串；HttpUrl 拼接、模板字符串、toString()、put(String(…)) 同为最终地址', async () => {
    connectOn();
    const tpl = '@js: var r = java.connect(source.key), u = r.raw().request().url();'
      + " java.put('s', String(u)); java.put('t', u.toString()); java.put('p', '' + u); java.put('l', `${u}`); java.put('u', r.url());"
      + " java.put('b', r.body().match(/action=\"([^\"]+)\"/)[1]); java.put('h', u); java.get('s') + 'x?q=' + key";
    const built = await buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, home());
    expect(built.request.url).toBe(`${FINAL}x?q=%E4%B9%A6`);
    expect(built.vars).toEqual({ s: FINAL, t: FINAL, p: FINAL, l: FINAL, u: FINAL, b: '/so/abc', h: FINAL });
  });

  it('取页只给 body 时最终地址按请求地址算', async () => {
    connectOn();
    expect((await buildSearchRequestWithNet(INLINE_TPL, '书', SITE, anyHost, true, async () => HOME)).request.url)
      .toBe(`${SITE}/search.php?q=%E4%B9%A6`);
  });

  it('不复现的形态判不支持：2 参、code()/headers()、StrResponse 转字符串、不调用就拿方法、未知成员', async () => {
    connectOn();
    for (const expr of [
      "java.connect(source.key, '{}').body()",
      'java.connect(source.key).code()',
      'java.connect(source.key).headers()',
      'String(java.connect(source.key))',
      "java.connect(source.key).raw() + ''",
      "java.connect(source.key).raw().request() + ''",
      "java.connect(source.key).url + ''",
      'java.connect(source.key).raw().request().url().toString',
      'java.connect(source.key).raw().request().url().host()',
      'JSON.stringify(java.connect(source.key).raw().request().url())',
      'Object.keys(java.connect(source.key)).join()',
    ]) {
      const tpl = `@js: String(${expr}) + 'x?q=' + key`;
      await expect(buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, home()), expr).rejects.toThrow(SourcePolicyError);
    }
  });

  it('结果直接是 StrResponse 判不支持；是 HttpUrl 照 legado toString 收', async () => {
    connectOn();
    await expect(buildSearchRequestWithNet('{{java.connect(source.key)}}s', '书', SITE, anyHost, true, home())).rejects.toThrow(SourcePolicyError);
    expect((await buildSearchRequestWithNet('@js: java.connect(source.key).raw().request().url()', '书', SITE, anyHost, true, home())).request.url)
      .toBe(FINAL);
  });

  it('HttpUrl 可再作 connect 实参；ajax 与 connect 同一地址各取一次', async () => {
    connectOn();
    const seen: SourceSearchRequest[] = [];
    const tpl = "@js: var u = java.connect(source.key).raw().request().url(); var b = java.connect(u).body() + java.ajax(source.key);"
      + " java.put('n', String(b.length)); String(u) + 's?q=' + key";
    const fetch = pagesFrom({ [FINAL]: HOME }, { [`${SITE}/`]: FINAL }, seen);
    const built = await buildSearchRequestWithNet(tpl, '书', SITE, anyHost, true, fetch);
    expect(built.vars).toEqual({ n: String(HOME.length * 2) });
    expect(seen.map((r) => r.url)).toEqual([`${SITE}/`, FINAL, `${SITE}/`]);
  });

  it('超过 4 页判不支持；取页失败、非字符串实参原样失败', async () => {
    connectOn();
    const many = `@js: for (var i = 0; i < 5; i++) java.connect('${SITE}/p' + i); '${SITE}/s?q=' + key`;
    const all = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`${SITE}/p${i}`, 'x']));
    await expect(buildSearchRequestWithNet(many, '书', SITE, anyHost, true, pagesFrom(all))).rejects.toThrow('java.connect 次数过多');
    await expect(buildSearchRequestWithNet(SEG_TPL, '书', SITE, anyHost, true, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(() => buildSearchRequest(`@js: java.connect(1); '${SITE}/s?q=' + key`, '书', SITE, anyHost, true)).toThrow(SourcePolicyError);
  });

  it('字段求值没有 connect 回调：jsoup 帧里 java.connect 不存在', async () => {
    connectOn();
    const { runJsoup } = await import('./js-sandbox');
    expect(() => runJsoup('java.connect("https://x.example.com/")', { result: '', baseUrl: SITE }, 'final')).toThrow();
  });
});

describe('能否构造判定', () => {
  it('searchJsConstructible：到首个 java.connect 为止，地址能解析即算能构造', () => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    netOn();
    expect(searchJsConstructible(SEG_TPL, SITE)).toBe(false);
    vi.stubEnv('ENGINE_SEARCH_CONNECT_JS', '1');
    expect(searchJsConstructible(SEG_TPL, SITE)).toBe(true);
    expect(searchJsConstructible(`@js: java.connect('/rel'); '${SITE}/s?q=' + key`, SITE)).toBe(false);
  });
});

const SEARCH_RULES = { bookList: '.i', name: '.t@text', bookUrl: 'a@href' };
const RESULT_PAGE = '<div class="i"><span class="t">甲书</span><a href="/b/1">x</a></div>';

describe('门面与准入取页腿带最终地址', () => {
  beforeEach(() => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    connectOn();
  });

  it('engineSearchBook：context.page 的最终地址传给 java.connect', async () => {
    const urls: string[] = [];
    const context = {
      page: async (url: string) => {
        urls.push(url);
        return url === `${SITE}/` ? { url: FINAL, text: HOME } : { url, text: RESULT_PAGE };
      },
    } as unknown as SourceRequestContext;
    const source: EngineSource = {
      url: SITE, name: '联网源', searchUrl: INLINE_TPL, compiled: compileSource({ url: SITE, searchUrl: INLINE_TPL, rules: { ruleSearch: SEARCH_RULES } }),
    };
    expect(await engineSearchBook(source, '甲', context)).toEqual([{ title: '甲书', author: '', bookUrl: `${SITE}/b/1` }]);
    expect(urls).toEqual([`${SITE}/`, `${FINAL}search.php?q=%E7%94%B2`]);
  });

  it('searchAdmission：准入通道跟随跳转，最终地址传给 java.connect', async () => {
    const urls: string[] = [];
    const fetchPage = vi.fn<AdmissionTransport>(async (url) => {
      urls.push(String(url));
      if (String(url) === `${SITE}/`) return new Response('', { status: 302, headers: { location: '/m/' } });
      return new Response(String(url) === FINAL ? HOME : RESULT_PAGE, { headers: { 'content-type': 'text/html' } });
    });
    const raw = {
      bookSourceUrl: SITE, bookSourceName: '联网源', searchUrl: INLINE_TPL, checkKeyWord: '测试',
      ruleSearch: SEARCH_RULES,
      ruleToc: { chapterList: '.toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '.c' },
    } as unknown as RawSource;
    const result = await searchAdmission(raw, {
      fetchPage, declaredHosts: new Set(['book15.net']), signal: new AbortController().signal, throttleMs: 5, sleep: vi.fn(async () => {}),
    });
    expect(result).toMatchObject({ verdict: 'ok', candidateCount: 1 });
    expect(urls).toEqual([`${SITE}/`, FINAL, `${FINAL}search.php?q=%E6%B5%8B%E8%AF%95`]);
  });
});
