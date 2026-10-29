import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkSourceUrl, SourcePolicyError } from '@/lib/source-policy';
import { buildSourceSearchRequest, searchTemplateNeedsJs } from '@/lib/source-parser';
import { engineSourceRevision } from './compile';
import { engineSearchJsActive, selectCandidates, type RawSource } from './compile-smoke';
import { buildSearchRequest, prepareSearchJs, searchJsConstructible } from './search-js';
import { engineSearchJsEnabled, engineSemanticsVersion, ENGINE_SEMANTICS_SEARCH_JS_BIT } from './syntax-flags';

// searchjs1027：legado AnalyzeUrl 口径的搜索模板 JS。用例形态取自现网 searchUrl 桶（域名/参数为合成值）。
const BASE = 'https://a.example.com';
const anyHost = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: () => true });
const build = (template: string, title = '书', base = BASE) => buildSearchRequest(template, title, base, anyHost, true);
const env = (patch: Record<string, string>) => patch as unknown as NodeJS.ProcessEnv;

beforeAll(async () => {
  await prepareSearchJs();
});

describe('ENGINE_SEARCH_JS 开关与语义位', () => {
  it.each([['1', true], ['true', true], ['on', true], [' ON ', true], ['0', false], ['', false], [undefined, false], ['yes', false]])(
    '%s → %s', (value, expected) => {
      expect(engineSearchJsEnabled({ ENGINE_SEARCH_JS: value })).toBe(expected);
    },
  );

  it('只在 ENGINE_POST_SEARCH 同开时生效', () => {
    expect(engineSearchJsActive(env({ ENGINE_SEARCH_JS: '1' }))).toBe(false);
    expect(engineSearchJsActive(env({ ENGINE_POST_SEARCH: '1' }))).toBe(false);
    expect(engineSearchJsActive(env({ ENGINE_SEARCH_JS: '1', ENGINE_POST_SEARCH: '1' }))).toBe(true);
  });

  it('版本位 256：1–256 逐字不变，257 = 基线 + 搜索 JS', () => {
    expect(ENGINE_SEMANTICS_SEARCH_JS_BIT).toBe(256);
    expect(engineSemanticsVersion(false)).toBe(1);
    expect(engineSemanticsVersion(true, true, true, true, true, true, true, true)).toBe(256);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, true)).toBe(257);
  });

  it('engineSourceRevision 只给需 JS 的模板加位', () => {
    const rules = { ruleSearch: { bookList: '.b' } };
    const jsSource = { url: BASE, searchUrl: `${BASE}/s?q={{key}}&p={{page-1}}`, rules };
    const plain = { url: BASE, searchUrl: `${BASE}/s?q={{key}}&p={{page}}`, rules };
    expect(engineSourceRevision(jsSource, { searchJsEnabled: true }).split(':')[0]).toBe('257');
    expect(engineSourceRevision(jsSource, { searchJsEnabled: false }).split(':')[0]).toBe('1');
    expect(engineSourceRevision(plain, { searchJsEnabled: true }).split(':')[0]).toBe('1');
    expect(engineSourceRevision(jsSource, { searchJsEnabled: true }).split(':')[1])
      .toBe(engineSourceRevision(jsSource, { searchJsEnabled: false }).split(':')[1]);
  });
});

describe('searchTemplateNeedsJs / 旧口径不变', () => {
  it.each([
    `${BASE}/s?q={{key}}`,
    `${BASE}/s?q={{key}}&p={{page}}`,
    `${BASE}/s,{"method":"POST","body":"k={{key}}"}`,
  ])('旧口径能构造的模板不走新路径：%s', (template) => {
    expect(searchTemplateNeedsJs(template, BASE)).toBe(false);
    expect(build(template)).toEqual(buildSourceSearchRequest(template, '书', BASE, anyHost));
  });

  it('无 JS 标记的旧口径失败照抛原错误（webView 等）', () => {
    const template = `${BASE}/s?q={{key}},{"webView":true}`;
    expect(searchTemplateNeedsJs(template, BASE)).toBe(false);
    expect(() => build(template)).toThrow('不支持该书源的搜索选项：webView');
  });

  it('开关关：需 JS 的模板照旧抛旧口径错误', () => {
    expect(() => buildSearchRequest(`${BASE}/s?q={{key}}&p={{page-1}}`, '书', BASE, anyHost, false))
      .toThrow('不支持该书源的动态搜索规则');
  });
});

describe('legado AnalyzeUrl 口径求值', () => {
  it('{{page-1}} 与表单 body：整数按 %.0f，未声明 charset 的表单按 URLEncoder 编码', () => {
    expect(build(`${BASE}/search,{"method":"POST","body":"keyword={{key}}&page={{page-1}}"}`)).toEqual({
      url: `${BASE}/search`, method: 'POST', charset: 'utf-8', body: 'keyword=%E4%B9%A6&page=0',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  });

  it('{{(page-1)*10}} → 0；GET 查询串里的书名按 queryEncoder 编码', () => {
    expect(build(`${BASE}/s?q={{key}}&start={{(page-1)*10}}`))
      .toEqual({ url: `${BASE}/s?q=%E4%B9%A6&start=0`, method: 'GET', charset: 'utf-8' });
  });

  it('@js: 整段求值，key/page 为绑定', () => {
    expect(build('@js:"https://a.example.com/s?q="+encodeURIComponent(key)+"&p="+page').url)
      .toBe(`${BASE}/s?q=%E4%B9%A6&p=1`);
  });

  it('JS 段后的文本替换 @result（含 $ 的结果按字面拼接）', () => {
    expect(build(`<js>java.base64Encode(key)</js>${BASE}/s?q=@result`).url).toBe(`${BASE}/s?q=5Lmm`);
    expect(build(`<js>"a$&b"</js>${BASE}/s?q=@result`).url).toBe(`${BASE}/s?q=a$&b`);
  });

  it('JS 段前的文本成为 result，再交给 JS', () => {
    expect(build(`${BASE}/s?q={{key}}<js>result+"&t=1"</js>`).url).toBe(`${BASE}/s?q=%E4%B9%A6&t=1`);
  });

  it('source.getKey() / baseUrl = 书源地址（选项部分剥掉）', () => {
    expect(build('@js:source.getKey()+"/s?q="+key').url).toBe(`${BASE}/s?q=%E4%B9%A6`);
    expect(build('@js:baseUrl+"/s?q="+key', '书', `${BASE},{"headers":{}}`).url).toBe(`${BASE}/s?q=%E4%B9%A6`);
  });

  it('{{cookie.removeCookie(source.getKey())}} 求值为空串', () => {
    expect(build(`{{cookie.removeCookie(source.getKey())}}${BASE}/s?q={{key}}`).url).toBe(`${BASE}/s?q=%E4%B9%A6`);
  });

  it('gbk 表单：声明 charset 时逐段按 gbk 编码，Content-Type 带声明值', () => {
    expect(build(`${BASE}/s,{"method":"POST","charset":"gbk","body":"q={{key}}&n={{1+1}}"}`)).toEqual({
      url: `${BASE}/s`, method: 'POST', charset: 'gbk', body: 'q=%CA%E9&n=2',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=gbk' },
    });
  });

  it('JSON body 原样不编码', () => {
    expect(build(`${BASE}/api,{"method":"POST","body":"{\\"kw\\":\\"{{key}}\\",\\"p\\":{{page-1}}}"}`)).toMatchObject({
      body: '{"kw":"书","p":0}', headers: { 'Content-Type': 'application/json' },
    });
  });

  it('<a,b> 页码取首项', () => {
    expect(build(`${BASE}/s?q={{key}}&p=<1, 2>&t={{page*1}}`).url).toBe(`${BASE}/s?q=%E4%B9%A6&p=1&t=1`);
  });

  it('java.put/get：一次请求构造内跨段共享，put 返回值本身', () => {
    expect(build(`<js>java.put('o', String((page-1)*20))</js>${BASE}/s?q={{key}}&o={{java.get('o')}}`).url)
      .toBe(`${BASE}/s?q=%E4%B9%A6&o=0`);
    expect(build(`${BASE}/s?q={{java.put('k', key)}}&n={{java.put('p', page)}}`).url).toBe(`${BASE}/s?q=%E4%B9%A6&n=1`);
    expect(build('@js:java.put("u", "https://a.example.com/s?q=");java.get("u")+key').url).toBe(`${BASE}/s?q=%E4%B9%A6`);
    expect(build(`${BASE}/s?q={{key}}&a={{java.put('__proto__','x')}}&b={{java.get('__proto__')}}`).url)
      .toBe(`${BASE}/s?q=%E4%B9%A6&a=x&b=x`);
  });

  it('变量袋对规则代码不可见；每次构造从空袋起', () => {
    expect(build(`${BASE}/s?q={{key}}&v={{typeof vars}}`).url).toBe(`${BASE}/s?q=%E4%B9%A6&v=undefined`);
    build(`${BASE}/s?q={{key}}&a={{java.put('z','1')}}`);
    expect(() => build(`${BASE}/s?q={{key}}&b={{java.get('z')}}`)).toThrow(SourcePolicyError);
  });

  it('非整数：Java 与 JS 同形的范围放行，其余拒', () => {
    expect(build(`${BASE}/s?q={{key}}&r={{0.5}}`).url).toBe(`${BASE}/s?q=%E4%B9%A6&r=0.5`);
    expect(() => build(`${BASE}/s?q={{key}}&r={{1e-7}}`)).toThrow(SourcePolicyError);
  });
});

describe('gbkjs1029：搜索模板 java.encodeURI(…, gbk 系)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const on = () => { vi.stubEnv('ENGINE_SYNTAX_JS', '1'); vi.stubEnv('ENGINE_SYNTAX_JS_UTIL', '1'); };
  const tpl = `${BASE}/s?q={{java.encodeURI(key,'gbk')}}&p={{page}}`;

  it('关（JS_UTIL 或 JS 任一未开）：照旧判不支持', () => {
    expect(() => build(tpl)).toThrow(SourcePolicyError);
    vi.stubEnv('ENGINE_SYNTAX_JS_UTIL', '1');
    expect(() => build(tpl)).toThrow(SourcePolicyError);
  });

  it('开：GET 查询串里的 %XX 原样保留；POST 表单与 @js: 段同口径', () => {
    on();
    expect(build(tpl, '书 a')).toEqual({ url: `${BASE}/s?q=%CA%E9+a&p=1`, method: 'GET', charset: 'utf-8' });
    expect(build(`${BASE}/s,{"method":"POST","body":"k={{java.encodeURI(key,'GB2312')}}"}`).body).toBe('k=%CA%E9');
    expect(build(`@js:'${BASE}/s?q='+java.encodeURI(key,'gb18030')`).url).toBe(`${BASE}/s?q=%CA%E9`);
  });

  it('开：表外/映射不一的字符致命失败；非 gbk 系字符集照旧只收 UTF-8', () => {
    on();
    expect(() => build(tpl, '书·名')).toThrow(SourcePolicyError);
    expect(() => build(`${BASE}/s?q={{(function(){try{return java.encodeURI(key,'gbk')}catch(e){return key}})()}}`, '·'))
      .toThrow(SourcePolicyError);
    expect(() => build(`${BASE}/s?q={{java.encodeURI(key,'big5')}}`)).toThrow(SourcePolicyError);
  });

  it('候选口径随开关变（探测记忆按开关分键）', () => {
    expect(searchJsConstructible(tpl, BASE)).toBe(false);
    on();
    expect(searchJsConstructible(tpl, BASE)).toBe(true);
    vi.unstubAllEnvs();
    expect(searchJsConstructible(tpl, BASE)).toBe(false);
  });

  it('语义位：JS + JS_UTIL + 搜索 JS 同开且模板需 JS、带 GBK 系 encodeURI 才计 jsUtil 位，内容 identity 不变', () => {
    const rules = { ruleSearch: { bookList: '.b' } };
    const src = { url: BASE, searchUrl: tpl, rules };
    const all = { jsEnabled: true, jsUtilEnabled: true, searchJsEnabled: true };
    expect(engineSourceRevision(src, all).split(':')[0]).toBe(String(1 + 256 + 8192));
    expect(engineSourceRevision(src, { ...all, jsUtilEnabled: false }).split(':')[0]).toBe('257');
    expect(engineSourceRevision(src, { ...all, jsEnabled: false }).split(':')[0]).toBe('257');
    expect(engineSourceRevision(src, { ...all, searchJsEnabled: false }).split(':')[0]).toBe('1');
    expect(engineSourceRevision({ ...src, searchUrl: `${BASE}/s?q={{java.encodeURI(key)}}` }, all).split(':')[0]).toBe('257');
    expect(engineSourceRevision({ ...src, searchUrl: `${BASE}/s?q={{key}}&gbk=1` }, all).split(':')[0]).toBe('1');
    expect(engineSourceRevision(src, all).split(':')[1]).toBe(engineSourceRevision(src, {}).split(':')[1]);
  });
});

describe('拒绝面', () => {
  it.each([
    ['webView 选项', `${BASE}/s?q={{key}}&p={{page+0}},{"webView":true}`],
    ['java.ajax', '@js:java.ajax("https://b.example.com/x")'],
    ['cache 不存在', '@js:cache.get("u")'],
    ['source.put 不存在', '@js:source.put("a","b");"https://a.example.com/s"'],
    ['analyzeJs 结果为数字', '@js:1'],
    ['死循环（250ms 截停）', '@js:while(true){}'],
    ['头值含非 ASCII（OkHttp 拒）', `${BASE}/s?p={{page+0}},{"headers":{"Referer":"{{key}}"}}`],
    ['非 https 结果', '@js:"http://127.0.0.1/s?q="+key'],
    ['java.get 读本次未 put 的键（legado 得空串，读不到多出自联网段，保守拒）', `${BASE}/s?q={{key}}&t={{java.get('token')}}`],
    ['java.put 对象值', `${BASE}/s?q={{key}}&t={{java.put('h', {a:1})}}`],
    ['java.put 指数形态数字', `${BASE}/s?q={{key}}&t={{java.put('n', 1e21)}}`],
    ['java 不可改写', `${BASE}/s?q={{key}}&t={{java.ajax = function(){ return 'x'; }, java.ajax()}}`],
  ])('%s', (_label, template) => {
    expect(() => build(template)).toThrow(SourcePolicyError);
  });

  it('host 门照守：运行时门拒门外 host', () => {
    const gate = (value: unknown, base?: string) => checkSourceUrl(value, base, { hostAllowed: (h) => h === 'a.example.com' });
    expect(buildSearchRequest('@js:"https://a.example.com/s?q="+key', '书', BASE, gate, true).url).toBe(`${BASE}/s?q=%E4%B9%A6`);
    expect(() => buildSearchRequest('@js:"https://b.example.com/s?q="+key', '书', BASE, gate, true)).toThrow(SourcePolicyError);
  });
});

describe('候选口径', () => {
  const src = (searchUrl: string): RawSource => ({
    bookSourceUrl: BASE, searchUrl, ruleSearch: { bookList: '.book' }, ruleContent: { content: '.content' },
  });

  it('需 JS 且可构造：postSearch+searchJs 才入选', () => {
    const s = src(`${BASE}/s,{"method":"POST","body":"q={{key}}&p={{page-1}}"}`);
    expect(selectCandidates([s]).length).toBe(0);
    expect(selectCandidates([s], { postSearch: true }).length).toBe(0);
    expect(selectCandidates([s], { searchJs: true }).length).toBe(0);
    expect(selectCandidates([s], { postSearch: true, searchJs: true }).length).toBe(1);
  });

  it('纯 GET 形态的 {{表达式}} 模板旧初筛就放行（运行时才判不支持），开关不改其入选', () => {
    const s = src(`${BASE}/s?q={{key}}&p={{page-1}}`);
    expect(selectCandidates([s]).length).toBe(1);
    expect(selectCandidates([s], { postSearch: true, searchJs: true }).length).toBe(1);
  });

  it('需 JS 但构造不出：两态都不入选', () => {
    const s = src('@js:java.ajax("https://a.example.com")');
    expect(selectCandidates([s], { postSearch: true, searchJs: true }).length).toBe(0);
    expect(searchJsConstructible('@js:java.ajax("https://a.example.com")', BASE)).toBe(false);
  });
});
