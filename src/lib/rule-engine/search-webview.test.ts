// searchwv1028：ENGINE_SEARCH_WEBVIEW —— 搜索选项 legado 口径里 webView 为真按普通请求取页（webJs 非空仍拒）；
// 开关严格口径、语义版本位、只在搜索选项口径生效时起作用、revision 只对含 webView 的接手源翻动。全部为合成形态。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import { buildSourceSearchRequest, searchOptionsConstructible } from '@/lib/source-parser';
import { engineSourceRevision } from './compile';
import { buildSearchRequest, prepareSearchJs } from './search-js';
import { ENGINE_SEMANTICS_SEARCH_WEBVIEW_BIT, engineSearchWebViewEnabled, engineSemanticsVersion } from './syntax-flags';

const BASE = 'https://a.example.com';
const KEY = encodeURIComponent('书');
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const parity = (template: string) => buildSourceSearchRequest(template, '书', BASE, anyHost, true);

beforeAll(async () => {
  await prepareSearchJs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('开关与语义版本', () => {
  it.each([['1', true], ['true', true], [' On ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])(
    '%s → %s', (value, expected) => {
      expect(engineSearchWebViewEnabled({ ENGINE_SEARCH_WEBVIEW: value })).toBe(expected);
    },
  );

  it('第 19 位 = 262144，前 18 位组合逐字不变', () => {
    expect(ENGINE_SEMANTICS_SEARCH_WEBVIEW_BIT).toBe(262144);
    const all = Array<boolean>(18).fill(true) as [boolean, ...boolean[]];
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 262144);
  });
});

describe('旧口径模板的 webView 选项', () => {
  const GET = `${BASE}/s?q={{key}},{'webView': true}`;
  const POST = `${BASE}/s,{"method":"POST","body":"k={{key}}","webView":"true","webViewDelayTime":500}`;

  it('开关关：webView 为真照旧拒', () => {
    expect(() => parity(GET)).toThrow(SourcePolicyError);
    expect(() => parity(POST)).toThrow(SourcePolicyError);
  });

  it('开关开：按普通请求构造（GET / POST 照常）', () => {
    vi.stubEnv('ENGINE_SEARCH_WEBVIEW', '1');
    expect(parity(GET)).toEqual({ url: `${BASE}/s?q=${KEY}`, method: 'GET', charset: 'utf-8' });
    expect(parity(POST)).toMatchObject({ url: `${BASE}/s`, method: 'POST', body: `k=${KEY}` });
  });

  it('开关开：webView 配非空 webJs 仍拒；空 webJs 照收', () => {
    vi.stubEnv('ENGINE_SEARCH_WEBVIEW', '1');
    expect(() => parity(`${BASE}/s?q={{key}},{"webView":true,"webJs":"document.title"}`)).toThrow(SourcePolicyError);
    expect(parity(`${BASE}/s?q={{key}},{"webView":true,"webJs":" "}`).url).toBe(`${BASE}/s?q=${KEY}`);
  });

  it('开关开：其余拒绝项不变（js/重复键/非整数 webViewDelayTime）', () => {
    vi.stubEnv('ENGINE_SEARCH_WEBVIEW', '1');
    for (const option of ['{"webView":true,"js":"result"}', '{"webView":true,"webView":false}', '{"webView":true,"webViewDelayTime":1.5}']) {
      expect(() => parity(`${BASE}/s?q={{key}},${option}`), option).toThrow(SourcePolicyError);
    }
  });

  it('只开 ENGINE_SEARCH_WEBVIEW、搜索选项口径未生效：候选口径不变', () => {
    vi.stubEnv('ENGINE_SEARCH_WEBVIEW', '1');
    expect(searchOptionsConstructible(GET, BASE)).toBe(false);
    vi.stubEnv('ENGINE_SEARCH_OPTIONS', '1');
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    expect(searchOptionsConstructible(GET, BASE)).toBe(true);
    vi.stubEnv('ENGINE_SEARCH_WEBVIEW', '0');
    expect(searchOptionsConstructible(GET, BASE)).toBe(false);
  });
});

describe('JS 模板求值后的 webView 选项', () => {
  const template = `@js:'${BASE}/s?q='+key+',{"webView":true}'`;

  it('搜索选项口径开、webView 关：拒', () => {
    vi.stubEnv('ENGINE_SEARCH_OPTIONS', '1');
    expect(() => buildSearchRequest(template, '书', BASE, anyHost, true)).toThrow(SourcePolicyError);
  });

  it('两开关都开：按普通 GET', () => {
    vi.stubEnv('ENGINE_SEARCH_OPTIONS', '1');
    vi.stubEnv('ENGINE_SEARCH_WEBVIEW', '1');
    expect(buildSearchRequest(template, '书', BASE, anyHost, true)).toMatchObject({ url: `${BASE}/s?q=${KEY}`, method: 'GET' });
  });
});

describe('revision', () => {
  const withWebView = { url: BASE, searchUrl: `${BASE}/s?q={{key}},{'webView': true}`, rules: {} };
  const otherOption = { url: BASE, searchUrl: `${BASE}/s?q={{key}},{"charset":""}`, rules: {} };
  const plain = { url: BASE, searchUrl: `${BASE}/s?q={{key}}`, rules: {} };

  it('只有搜索选项口径接手且含 webView 的源翻；搜索选项口径未生效时不翻', () => {
    const ON = { searchOptionsEnabled: true, searchWebViewEnabled: true };
    const OFF = { searchOptionsEnabled: true, searchWebViewEnabled: false };
    expect(engineSourceRevision(withWebView, ON)).not.toBe(engineSourceRevision(withWebView, OFF));
    expect(engineSourceRevision(otherOption, ON)).toBe(engineSourceRevision(otherOption, OFF));
    expect(engineSourceRevision(plain, ON)).toBe(engineSourceRevision(plain, OFF));
    expect(engineSourceRevision(withWebView, { searchOptionsEnabled: false, searchWebViewEnabled: true }))
      .toBe(engineSourceRevision(withWebView, { searchOptionsEnabled: false, searchWebViewEnabled: false }));
  });

  it('webView 全是字面假值（或只有 webViewDelayTime）不翻；非字面量照翻', () => {
    const ON = { searchOptionsEnabled: true, searchWebViewEnabled: true };
    const OFF = { searchOptionsEnabled: true, searchWebViewEnabled: false };
    const rev = (option: string) => {
      const source = { url: BASE, searchUrl: `${BASE}/s?q={{key}},{"charset":"",${option}}`, rules: {} };
      return [engineSourceRevision(source, ON), engineSourceRevision(source, OFF)];
    };
    for (const option of ['"webView":false', "'webView': 'false'", 'webView:""', '"webView":null', '"webViewDelayTime":1', '"headers":{"webView":"1"}']) {
      const [a, b] = rev(option);
      expect(a, option).toBe(b);
    }
    for (const option of ['"webView":true', '"webView":"1"', 'webView:1,"body":{{key}}']) {
      const [a, b] = rev(option);
      expect(a, option).not.toBe(b);
    }
    // JS 模板：只有字面假值判否。
    const js = (searchUrl: string) => {
      const source = { url: BASE, searchUrl, rules: {} };
      return engineSourceRevision(source, ON) !== engineSourceRevision(source, OFF);
    };
    expect(js(`@js:'${BASE}/s?q='+key+',{"origin":"x","webView":'+(key?'true':'false')+'}'`)).toBe(true);
    expect(js(`@js:'${BASE}/s?q='+key+',{"origin":"x","webView":false}'`)).toBe(false);
  });
});
