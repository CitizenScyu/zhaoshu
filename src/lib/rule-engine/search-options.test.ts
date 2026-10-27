import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import { buildSourceSearchRequest, searchOptionsConstructible, searchOptionsNeedParity } from '@/lib/source-parser';
import { engineSourceRevision } from './compile';
import { engineSearchOptionsActive } from './compile-smoke';
import { buildSearchRequest, prepareSearchJs } from './search-js';
import { engineSearchOptionsEnabled, engineSemanticsVersion, ENGINE_SEMANTICS_SEARCH_OPTIONS_BIT } from './syntax-flags';

// searchopt1028：搜索选项 legado UrlOption 口径。形态取自现网 searchUrl 桶的骨架（域名/参数为合成值）。
const BASE = 'https://a.example.com';
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const on = (template: string, title = '书') => buildSourceSearchRequest(template, title, BASE, anyHost, true);
const off = (template: string, title = '书') => buildSourceSearchRequest(template, title, BASE, anyHost, false);
const env = (patch: Record<string, string>) => patch as unknown as NodeJS.ProcessEnv;
const KEY = encodeURIComponent('书');

beforeAll(async () => {
  await prepareSearchJs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ENGINE_SEARCH_OPTIONS 开关与语义位', () => {
  it.each([['1', true], ['true', true], ['on', true], [' ON ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])(
    '%s → %s', (value, expected) => {
      expect(engineSearchOptionsEnabled({ ENGINE_SEARCH_OPTIONS: value })).toBe(expected);
    },
  );

  it('只在 ENGINE_POST_SEARCH 同开时生效', () => {
    expect(engineSearchOptionsActive(env({ ENGINE_SEARCH_OPTIONS: '1' }))).toBe(false);
    expect(engineSearchOptionsActive(env({ ENGINE_POST_SEARCH: '1' }))).toBe(false);
    expect(engineSearchOptionsActive(env({ ENGINE_SEARCH_OPTIONS: '1', ENGINE_POST_SEARCH: '1' }))).toBe(true);
  });

  it('第 17 位 = 65536，前 16 位组合逐字不变', () => {
    expect(ENGINE_SEMANTICS_SEARCH_OPTIONS_BIT).toBe(65536);
    const flags = Array<boolean>(16).fill(false);
    expect(engineSemanticsVersion(false, ...flags.slice(1))).toBe(1);
    expect(engineSemanticsVersion(false, ...flags.slice(1), true)).toBe(1 + 65536);
  });

  it('默认参数读 env：两开关同开才走新口径', () => {
    const template = `${BASE}/s?q={{key}},{"charset":""}`;
    vi.stubEnv('ENGINE_SEARCH_OPTIONS', '1');
    expect(() => buildSourceSearchRequest(template, '书', BASE, anyHost)).toThrow(SourcePolicyError);
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    expect(buildSourceSearchRequest(template, '书', BASE, anyHost).url).toBe(`${BASE}/s?q=${KEY}`);
  });
});

describe('旧口径模板：只在旧口径因选项被拒时接手', () => {
  it('旧口径能构造的模板逐字不变', () => {
    const template = `${BASE}/s,{"method":"POST","body":"k={{key}}","charset":"gbk"}`;
    expect(on(template)).toEqual(off(template));
  });

  it('空 charset 视同未声明', () => {
    const template = `${BASE}/s,{"method":"POST","body":"k={{key}}","charset":""}`;
    expect(() => off(template)).toThrow(SourcePolicyError);
    expect(on(template)).toEqual({
      url: `${BASE}/s`, method: 'POST', charset: 'utf-8', body: `k=${KEY}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  });

  it('GSON 宽松形态（裸键、分号）照读，{{key}}/{{page}} 照常展开', () => {
    const template = `${BASE}/s,{method:post; body:"k={{key}}&p={{page}}"}`;
    expect(() => off(template)).toThrow(SourcePolicyError);
    expect(on(template)).toMatchObject({ url: `${BASE}/s`, method: 'POST', body: `k=${KEY}&p=1` });
  });

  it('GSON 也读不出（对象尾逗号）→ 选项整段忽略，按 GET 请求 url 部分', () => {
    const template = `${BASE}/s?q={{key}},{"method":"POST","body":"k={{key}}",}`;
    expect(() => off(template)).toThrow(SourcePolicyError);
    expect(on(template)).toEqual({ url: `${BASE}/s?q=${KEY}`, method: 'GET', charset: 'utf-8' });
  });

  it('未知键、origin/webJs、整数 retry 忽略', () => {
    const template = `${BASE}/s,{"method":"POST","body":"k={{key}}","origin":"x","webJs":"y","retry":2,"webView":false}`;
    expect(on(template)).toMatchObject({ method: 'POST', body: `k=${KEY}` });
  });

  it('method 非 POST 一律 GET（GET 时 body 不发）', () => {
    expect(on(`${BASE}/s?q={{key}},{"method":"PUT","body":"k={{key}}"}`)).toEqual({ url: `${BASE}/s?q=${KEY}`, method: 'GET', charset: 'utf-8' });
  });

  it('headers 为 JSON 串：解析后过白名单，整数/布尔值转串', () => {
    const template = `${BASE}/s?q={{key}},{"headers":"{'Referer':'${BASE}/','User-Agent':5,'Cookie':'c'}"}`;
    expect(() => off(template)).toThrow(SourcePolicyError);
    expect(on(template).headers).toEqual({ Referer: `${BASE}/`, 'User-Agent': '5' });
  });

  it('headers 串解析不成对象 → 无头', () => {
    expect(on(`${BASE}/s?q={{key}},{"headers":"not json"}`).headers).toBeUndefined();
  });

  it('白名单头的值是对象/null → 拒；非白名单头不管值形态都丢', () => {
    expect(() => on(`${BASE}/s?q={{key}},{"headers":{"Referer":{"a":1}},"x":1}`)).toThrow(SourcePolicyError);
    expect(() => on(`${BASE}/s?q={{key}},{"headers":{"Referer":null},"x":1}`)).toThrow(SourcePolicyError);
    expect(on(`${BASE}/s?q={{key}},{"headers":{"X-A":{"a":1}},"x":1}`).headers).toBeUndefined();
  });

  it('POST 对象 body 按 GSON pretty 序列化，{{key}} 原样（JSON body 口径）', () => {
    const template = `${BASE}/api,{"method":"POST","body":{"k":"{{key}}","n":1}}`;
    expect(() => off(template)).toThrow(SourcePolicyError);
    expect(on(template)).toMatchObject({
      method: 'POST', body: '{\n  "k": "书",\n  "n": 1\n}', headers: { 'Content-Type': 'application/json' },
    });
  });

  it.each([
    ['webView 为真', '{"webView":true,"x":1}'],
    ['webView 为 0（legado 非空非 false 即真）', '{"webView":0,"x":1}'],
    ['js 非 null', '{"js":"result","x":1}'],
    ['type 非 null', '{"type":"","x":1}'],
    ['serverID 非 null', '{"serverID":1,"x":1}'],
    ['retry 非整数', '{"retry":"x","x":1}'],
    ['webViewDelayTime 为小数', '{"webViewDelayTime":1.5,"x":1}'],
    ['重复键', '{"x":1,"x":2}'],
    ['escape 字符集', '{"charset":"escape","x":1}'],
    ['未知字符集', '{"charset":"utf_8","x":1}'],
    ['数字 body', '{"method":"POST","body":1,"x":1}'],
    ['body 里有 null', '{"method":"POST","body":{"a":null}}'],
  ])('%s → 拒', (_name, option) => {
    expect(() => on(`${BASE}/s?q={{key}},${option}`)).toThrow(SourcePolicyError);
  });

  it('红线不变：非 443 端口、body 里的 java. 照旧拒', () => {
    expect(() => on(`https://a.example.com:8443/s?q={{key}},{"charset":""}`)).toThrow(SourcePolicyError);
    expect(() => on(`${BASE}/s?q={{key}},{"method":"POST","body":"java.x({{key}})","x":1}`)).toThrow(SourcePolicyError);
  });

  it('含页码表达式、## 或占位字符的模板不接手', () => {
    expect(() => on(`${BASE}/s?q={{key}}&p=<1,2>,{"charset":""}`)).toThrow(SourcePolicyError);
    expect(() => on(`${BASE}/s?q={{key}},{"charset":""}##x`)).toThrow(SourcePolicyError);
    expect(() => on(`${BASE}/s?q={{key}}\uE000,{"charset":""}`)).toThrow(SourcePolicyError);
  });
});

describe('JS 模板：求值后的选项按 legado 口径重读', () => {
  const template = `@js:'${BASE}/s,{"method":"POST","body":"k='+key+'","origin":"x"}'`;

  it('开关关：未知键照旧拒', () => {
    expect(() => buildSearchRequest(template, '书', BASE, anyHost, true)).toThrow(SourcePolicyError);
  });

  it('开关开：未知键忽略', () => {
    vi.stubEnv('ENGINE_SEARCH_OPTIONS', '1');
    expect(buildSearchRequest(template, '书', BASE, anyHost, true)).toMatchObject({
      url: `${BASE}/s`, method: 'POST', body: `k=${KEY}`,
    });
  });
});

describe('searchOptionsNeedParity 与 revision', () => {
  it('判据：只对旧口径因选项被拒的模板为真', () => {
    expect(searchOptionsNeedParity(`${BASE}/s?q={{key}},{"charset":""}`, BASE)).toBe(true);
    expect(searchOptionsNeedParity(`@js:'${BASE}/s,{"origin":"x"}'`, BASE)).toBe(true);
    expect(searchOptionsNeedParity(`${BASE}/s?q={{key}},{"charset":"gbk"}`, BASE)).toBe(false);
    expect(searchOptionsNeedParity(`${BASE}/s?q={{key}}`, BASE)).toBe(false);
    expect(searchOptionsNeedParity(`@js:'${BASE}/s?q='+key`, BASE)).toBe(false);
    expect(searchOptionsNeedParity(undefined, BASE)).toBe(false);
  });

  it('只有接手的源翻 revision；缺省读 env', () => {
    const using = { url: BASE, searchUrl: `${BASE}/s?q={{key}},{"charset":""}`, rules: {} };
    const plain = { url: BASE, searchUrl: `${BASE}/s?q={{key}}`, rules: {} };
    const ON = { searchOptionsEnabled: true };
    const OFF = { searchOptionsEnabled: false };
    expect(engineSourceRevision(using, ON)).not.toBe(engineSourceRevision(using, OFF));
    expect(engineSourceRevision(plain, ON)).toBe(engineSourceRevision(plain, OFF));
    expect(engineSourceRevision(using, OFF)).toBe(engineSourceRevision(using, { searchOptionsEnabled: undefined }));
  });

  it('候选口径跟随开关', () => {
    const template = `${BASE}/s?q={{key}},{"charset":""}`;
    expect(searchOptionsConstructible(template, BASE)).toBe(false);
    vi.stubEnv('ENGINE_SEARCH_OPTIONS', '1');
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    expect(searchOptionsConstructible(template, BASE)).toBe(true);
  });
});
