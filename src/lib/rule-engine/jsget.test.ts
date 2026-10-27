// jsget1028：ENGINE_SYNTAX_JS_GET —— JS 里放行 legado `java.getString`/`java.getStringList`（实参为字面量规则文本，
// 编译期收白名单、求值期在字段作用域上取值）；语义版本位、按源判定、门面与 source-usability 缓存口径。
// 规则均为合成形态。
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesJsGetSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody, type EvalScope } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_JS_GET_BIT, engineSemanticsVersion, engineSyntaxJsGetEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://book15.net';
const PAGE_URL = `${SITE}/p/1.html`;
const ON = { jsEnabled: true, jsGetEnabled: true } as const;
const OFF = { jsEnabled: true, jsGetEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field: string) => parseFieldRule(rule, { ...OFF, field });
const scopeOf = (text: string): EvalScope => createScope(normalizeBody(text), PAGE_URL);
const value = (field: FieldIr, text: string) => evaluateField(field, scopeOf(text));
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const NAME = 'ruleBookInfo.name';

describe('开关与语义版本', () => {
  it('engineSyntaxJsGetEnabled 严格口径', () => {
    expect(engineSyntaxJsGetEnabled({})).toBe(false);
    expect(engineSyntaxJsGetEnabled({ ENGINE_SYNTAX_JS_GET: '0' })).toBe(false);
    expect(engineSyntaxJsGetEnabled({ ENGINE_SYNTAX_JS_GET: 'yes' })).toBe(false);
    expect(engineSyntaxJsGetEnabled({ ENGINE_SYNTAX_JS_GET: ' On ' })).toBe(true);
    expect(engineSyntaxJsGetEnabled({ ENGINE_SYNTAX_JS_GET: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsGetEnabled({ ENGINE_SYNTAX_JS_GET: '1' })).toBe(true);
  });

  it('getter 位 +4096，1–4096 逐字不变', () => {
    expect(ENGINE_SEMANTICS_JS_GET_BIT).toBe(4096);
    const all = [true, true, true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 4096);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, false, false, false, false, true))
      .toBe(engineSemanticsVersion(false) + 4096);
  });

  it('按源判定：只有 off 拒、on 过的字段所在源换版本', () => {
    const opts = (jsGetEnabled: boolean, jsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false,
      jsGetEnabled,
    });
    const getJs = raw({ ruleBookInfo: { name: '@js:java.getString("#t@text")' } });
    const listJs = raw({ ruleContent: { content: '#c@text@js:java.getStringList("p@text").size() + result' } });
    const plainJs = raw({ ruleContent: { content: '#c@html@js:result.trim()' } });
    const dynamic = raw({ ruleBookInfo: { name: '@js:var r = "#t@text"; java.getString(r)' } });
    const inString = raw({ ruleBookInfo: { name: '#t@text@js:result + "java.getString(\'#t@text\')"' } });
    const inComment = raw({ ruleBookInfo: { name: '#t@text@js:result // java.getString("#t@text")' } });
    const bothReject = raw({ ruleBookInfo: { name: '@js:java.getString("#t@text") + java.ajax("x")' } });
    const withLib = raw({ ...getJs.rules, jsLib: 'function f(){}' });
    for (const s of [plainJs, dynamic, inString, inComment, bothReject, withLib]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    }
    for (const s of [getJs, listJs]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      expect(engineSourceRevision(s, opts(true, false))).toBe(engineSourceRevision(s, opts(false, false)));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false,
    };
    expect(sourceUsesJsGetSyntax(getJs.rules, flags)).toBe(true);
    expect(sourceUsesJsGetSyntax(listJs.rules, flags)).toBe(true);
    for (const s of [plainJs, dynamic, inString, inComment, bothReject, withLib]) expect(sourceUsesJsGetSyntax(s.rules, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译；两态缓存互不污染', () => {
    const rules = { ruleContent: { content: '#c@text@js:result + java.getString("#t@text")' } };
    const compiled = (jsGetEnabled: boolean) => compileSource(raw(rules), { jsEnabled: true, jsGetEnabled }).get('ruleContent.content');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true)).not.toHaveProperty('skipped');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse：实参白名单', () => {
  it('off：java.getString 照旧不在白名单；on 但 JS 关：照旧拒', () => {
    expect(codeOf(() => off('@js:java.getString("#t@text")', NAME))).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule('@js:java.getString("#t@text")', { jsEnabled: false, jsGetEnabled: true, field: NAME })))
      .toBeDefined();
  });

  it('字面量实参收进 jsGets（单/双引号、常见转义、多次调用去重）；不产出时不挂键', () => {
    const field = on('@js:java.getString("#t@text") + java.getString(\'#t@text\') + java.getStringList("p\\u0040text").size()', NAME);
    expect([...(field.jsGets?.keys() ?? [])]).toEqual(['#t@text', 'p@text']);
    expect(on('#c@text@js:result.trim()', NAME).jsGets).toBeUndefined();
    expect(on('@js:java . getString ( "#t@text" )', NAME).jsGets?.has('#t@text')).toBe(true);
  });

  it('不收的形态照旧拒：动态实参、多参、getElement、不认的转义、跨占位', () => {
    const name = (code: string) => codeOf(() => on(`@js:${code}`, NAME));
    expect(name('var r = "#t@text"; java.getString(r)')).toBe('unsupported_js');
    expect(name('java.getString("#t" + "@text")')).toBe('unsupported_js');
    expect(name('java.getString("a@href", true)')).toBe('unsupported_js');
    expect(name('java.getElement("#t")')).toBe('unsupported_js');
    expect(name('java.getElements("#t")')).toBe('unsupported_js');
    expect(name('java.getString("\\x23t@text")')).toBe('unsupported_js');
    expect(name('java.getString("\\u{23}t@text")')).toBe('unsupported_js');
    expect(name('java.getString("\\0")')).toBe('unsupported_js');
    expect(codeOf(() => on('@js:java.getString("{{@@#a@text}}")', NAME, { jsExtEnabled: true }))).toBe('unsupported_js');
  });

  it('起点落在字符串/注释/模板字面量里不收；代码里的才换', () => {
    const name = (code: string) => codeOf(() => on(`@js:${code}`, NAME));
    // 字面量里的调用本就不执行：剥字面量后没有 java，照旧可编译但不进白名单
    const quoted = on('@js:"java.getString(\'#t@text\')"', NAME);
    expect(quoted.jsGets).toBeUndefined();
    expect(on('@js:1 /* java.getString("#t@text") */', NAME).jsGets).toBeUndefined();
    // 反引号不剥（模板字面量里的插值是代码），两态一样按白名单拒
    expect(name('`x java.getString("#t@text")`')).toBe('unsupported_js');
    expect(name('`${java.getString("#t@text")}`')).toBe('unsupported_js');
    expect(name('"a" + java.getString("#t@text")')).toBeUndefined();
  });

  it('实参规则按段开关编译：编译不过、含 ## 或 JS 一律整段拒', () => {
    const name = (code: string) => codeOf(() => on(`@js:${code}`, NAME));
    expect(name('java.getString("#t@text##a##b")')).toBe('unsupported_js');
    expect(name('java.getString("$.a[?(@.b > 1)]")')).toBe('unsupported_js');
    expect(name('java.getString("<js>1</js>")')).toBe('unsupported_js');
  });

  it('列表 JS 不收', () => {
    expect(codeOf(() => on('@js:java.getStringList("li").toArray()', 'ruleSearch.bookList', { listJsEnabled: true }))).toBe('unsupported_js');
  });
});

describe('求值', () => {
  it('页面作用域：getString 按 legado 多值换行拼接、含 & 时 unescapeHtml4', async () => {
    await preloadJsSandbox();
    const html = '<b id="t">甲</b><i>1</i><i>2</i><p id="e">x &amp;amp; y</p>';
    expect(value(on('@js:java.getString("#t@text") + "|" + java.getString("i@text")', NAME), html)).toBe('甲|1\n2');
    // 字段末段本也解一次实体，这里在 JS 里比，看的是回调自身的口径
    expect(value(on('@js:java.getString("#e@text") === "x & y"', NAME), html)).toBe('true');
    // java 读的是字段作用域（原页面），不是上一段结果
    expect(value(on('#t@text@js:result + java.getString("#t@text")', NAME), html)).toBe('甲甲');
  });

  it('getStringList：List 形态（size/get/length），不解码，空 = 空表', async () => {
    await preloadJsSandbox();
    const html = '<i>1</i><i>2</i><p id="e">x &amp;amp; y</p>';
    const list = on('@js:var l = java.getStringList("i@text"); l.size() + "|" + l.get(1) + "|" + l.length', NAME);
    expect(value(list, html)).toBe('2|2|2');
    expect(value(on('@js:java.getStringList("#e@text").get(0) === "x &amp; y"', NAME), html)).toBe('true');
    expect(value(on('@js:java.getStringList("#none@text").size()', NAME), html)).toBe('0');
  });

  it('JSON 页面：实参 JSONPath 在原 JSON 上取值', async () => {
    await preloadJsSandbox();
    expect(value(on('@js:java.getString("$.a") + "-" + java.getString("$.b[1]")', NAME), '{"a":"x","b":[1,2]}')).toBe('x-2');
  });

  it('列表条目作用域：在本条元素上取值', async () => {
    await preloadJsSandbox();
    const page = scopeOf('<li><a href="/c/1.html">一</a><em>A</em></li><li><a href="/c/2.html">二</a><em>B</em></li>');
    const items = evaluateFieldList(parseFieldRule('li', { field: 'ruleSearch.bookList' }), page);
    const name = on('a@text@js:result + java.getString("em@text")', 'ruleSearch.name');
    expect(items.map((item) => evaluateField(name, item))).toEqual(['一A', '二B']);
  });

  it('jsExt 模板路径：{{}} 与 getter 同段', async () => {
    await preloadJsSandbox();
    const field = on('@js:java.getString("#t@text") + "{{@@#u@text}}"', NAME, { jsExtEnabled: true });
    expect(field.jsGets?.has('#t@text')).toBe(true);
    expect(value(field, '<b id="t">甲</b><b id="u">乙</b>')).toBe('甲乙');
  });

  it('白名单外的键求值失败，JS 里 try/catch 吞不掉宿主回调失败', async () => {
    await preloadJsSandbox();
    const field = on('@js:try { java.getString("#t@text") } catch (e) { "caught" }', NAME);
    expect(value(field, '<b id="t">甲</b>')).toBe('甲');
    const forged: FieldIr = { ...field, jsGets: new Map() };
    expect(codeOf(() => value(forged, '<b id="t">甲</b>'))).toBe('RULE_EVAL_FAILED');
  });

  it('同一次求值内同键只取一次值，结果一致', async () => {
    await preloadJsSandbox();
    const field = on('@js:java.getString("i@text") === java.getString("i@text") ? "same" : "diff"', NAME);
    expect(value(field, '<i>1</i><i>2</i>')).toBe('same');
  });
});

describe('门面', () => {
  const engine = (rules: Record<string, unknown>): EngineSource => ({
    url: SITE, name: 'jsget 源', searchUrl: `${SITE}/s?q={{key}}`,
    compiled: compileSource(raw(rules), { jsEnabled: true, jsGetEnabled: true }),
  });
  const context = (pages: Map<string, string>): SourceRequestContext => ({
    page: async (url: string) => {
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  } as unknown as SourceRequestContext);

  it('正文 JS 读页面上的另一处文本', async () => {
    await preloadJsSandbox();
    const src = engine({ ruleContent: { content: '#c@text@js:java.getString("#t@text") + "|" + result' } });
    const url = `${SITE}/c/1.html`;
    const pages = new Map([[url, '<h1 id="t">第1章</h1><div id="c">正文</div>']]);
    expect((await engineFetchContent(src, url, context(pages))).text).toBe('第1章|正文');
  });
});

describe('source-usability 缓存口径', () => {
  const saved = process.env.ENGINE_SYNTAX_JS_GET;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGINE_SYNTAX_JS_GET;
    else process.env.ENGINE_SYNTAX_JS_GET = saved;
  });

  it('翻 ENGINE_SYNTAX_JS_GET 后 engineSourceUsable 重新判定', async () => {
    const { engineSourceUsable } = await import('../source-usability');
    const env = process.env;
    const prev = { js: env.ENGINE_SYNTAX_JS };
    env.ENGINE_SYNTAX_JS = '1';
    try {
      const source = {
        url: 'https://book15.net/', name: 'x', searchUrl: 'https://book15.net/s?q={{key}}', // 默认 host 门白名单
        rules: {
          ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
          ruleToc: { chapterList: '.c', chapterName: 'a@text', chapterUrl: 'a@href' },
          ruleContent: { content: '#c@text@js:result + java.getString("#t@text")' },
        },
      };
      env.ENGINE_SYNTAX_JS_GET = '0';
      const offState = engineSourceUsable(source as never);
      env.ENGINE_SYNTAX_JS_GET = '1';
      const onState = engineSourceUsable(source as never);
      expect(offState).toBe(false);
      expect(onState).toBe(true);
    } finally {
      if (prev.js === undefined) delete env.ENGINE_SYNTAX_JS;
      else env.ENGINE_SYNTAX_JS = prev.js;
    }
  });
});
