// jsext1028：ENGINE_SYNTAX_JS_EXT —— JS 段放行 eval，按 legado SourceRule.makeUpRule 处理 JS 段内的 `{{}}` 占位与 `##` 替换，
// 条目级字段首段 JS 不读 result/src 时放行；以及语义版本位与 source-usability 缓存口径。规则均为合成形态。
import { afterEach, describe, expect, it } from 'vitest';
import { compileSource, engineSourceRevision, sourceUsesJsExtSyntax } from './compile';
import {
  createHtmlScope, createScope, evaluateField, evaluateFieldList, evaluateFieldStrings, normalizeBody, type EvalScope,
} from './evaluate';
import { preloadJsSandbox, runJs } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_JS_EXT_BIT, engineSemanticsVersion, engineSyntaxJsExtEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://example.com';
const PAGE_URL = `${SITE}/p/1.html`;
const ON = { jsEnabled: true, jsExtEnabled: true } as const;
const OFF = { jsEnabled: true, jsExtEnabled: false } as const;
const page = (rule: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field: 'ruleContent.content' });
const pageOff = (rule: string) => parseFieldRule(rule, { ...OFF, field: 'ruleContent.content' });
const item = (rule: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field: 'ruleSearch.author' });
const scopeOf = (text: string): EvalScope => createScope(normalizeBody(text), PAGE_URL);
const value = (field: FieldIr, text: string) => evaluateField(field, scopeOf(text));
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });

describe('开关与语义版本', () => {
  it('engineSyntaxJsExtEnabled 严格口径', () => {
    expect(engineSyntaxJsExtEnabled({})).toBe(false);
    expect(engineSyntaxJsExtEnabled({ ENGINE_SYNTAX_JS_EXT: '0' })).toBe(false);
    expect(engineSyntaxJsExtEnabled({ ENGINE_SYNTAX_JS_EXT: 'yes' })).toBe(false);
    expect(engineSyntaxJsExtEnabled({ ENGINE_SYNTAX_JS_EXT: ' On ' })).toBe(true);
    expect(engineSyntaxJsExtEnabled({ ENGINE_SYNTAX_JS_EXT: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsExtEnabled({ ENGINE_SYNTAX_JS_EXT: '1' })).toBe(true);
  });

  it('JS 扩展位 +1024，1–1024 逐字不变', () => {
    expect(ENGINE_SEMANTICS_JS_EXT_BIT).toBe(1024);
    const all = [true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 1024);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, false, false, true))
      .toBe(engineSemanticsVersion(false) + 1024);
  });

  it('按源判定：只有 off 拒、on 过的字段所在源换版本', () => {
    const opts = (jsExtEnabled: boolean, jsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled,
    });
    const evalJs = raw({ ruleContent: { content: '#c@html@js:eval("result")' } });
    const makeUp = raw({ ruleContent: { content: '#c@html@js:result##a##b' } });
    const plainJs = raw({ ruleContent: { content: '#c@html@js:result.trim()' } });
    const plain = raw({ ruleContent: { content: '#c@html' } });
    const bothReject = raw({ ruleContent: { content: '#c@html@js:java.ajax("x")##a' } });
    const withLib = raw({ ...evalJs.rules, jsLib: 'function f(){}' });
    for (const s of [plainJs, plain, bothReject, withLib]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    }
    for (const s of [evalJs, makeUp]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      expect(engineSourceRevision(s, opts(true, false))).toBe(engineSourceRevision(s, opts(false, false)));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: false,
    };
    expect(sourceUsesJsExtSyntax(evalJs.rules, flags)).toBe(true);
    expect(sourceUsesJsExtSyntax(plainJs.rules, flags)).toBe(false);
    expect(sourceUsesJsExtSyntax(withLib.rules, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译；两态缓存互不污染', () => {
    const rules = { ruleContent: { content: '#c@html@js:eval("result")' } };
    const compiled = (jsExtEnabled: boolean) => compileSource(raw(rules), { jsEnabled: true, jsExtEnabled }).get('ruleContent.content');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true)).not.toHaveProperty('skipped');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse', () => {
  it('off：eval、段内 ##/{{}}、条目首段 JS 照旧拒', () => {
    for (const rule of ['#c@js:eval("1")', '#c@js:result##a##b', '#c@js:result + "{{$.x}}"']) {
      expect(codeOf(() => pageOff(rule)), rule).toBe('unsupported_js');
    }
    expect(codeOf(() => parseFieldRule('@js:"甲"', { ...OFF, field: 'ruleSearch.author' }))).toBe('unsupported_js');
  });

  it('on：不含 ##/{{ 的段与旧路径同一产物', () => {
    expect(page('#c@js:result.trim()')).toEqual(pageOff('#c@js:result.trim()'));
    expect(page('#c@js:eval("result")').chain?.[1]).toEqual({ kind: 'js', code: 'eval("result")' });
  });

  it('on：无 {{ 的 ## 编译期切好；≥4 段 replaceFirst；正则段为空不替换；代码为空只做替换', () => {
    expect(page('#c@js: result ##a##b').chain?.[1]).toEqual({ kind: 'js', code: 'result', regex: { pattern: 'a', replacement: 'b' } });
    expect(page('#c@js:result##a##b###').chain?.[1])
      .toEqual({ kind: 'js', code: 'result', regex: { pattern: 'a', replacement: 'b', first: true } });
    expect(page('#c@js:result##a').chain?.[1]).toEqual({ kind: 'js', code: 'result', regex: { pattern: 'a', replacement: '' } });
    expect(page('#c@js:result####b').chain?.[1]).toEqual({ kind: 'js', code: 'result' });
    expect(page('#c@js:##a##b').chain?.[1]).toEqual({ kind: 'regex', regex: [{ pattern: 'a', replacement: 'b' }] });
  });

  it('on：模板切片——isRule 前缀按规则，其余按 JS', () => {
    const stage = page('#c@js:"{{$.x}}" + {{1 + 1}}').chain?.[1];
    expect(stage).toMatchObject({ kind: 'js', code: '"{{$.x}}" + {{1 + 1}}' });
    const template = stage?.kind === 'js' ? stage.template : undefined;
    expect(template?.map((part) => part.kind)).toEqual(['text', 'rule', 'text', 'js']);
    expect(template?.[3]).toEqual({ kind: 'js', code: '1 + 1' });
  });

  it('on：仍拒的形态', () => {
    for (const rule of [
      '#c@js:java.ajax("x")', // 沙箱不提供
      '#c@js:result@get:{k}', '#c@js:java.put("k", result)##a', // @get/@put
      '#c@js:{{book.name}}', '#c@js:"{{$.x}}" + source.key', // 占位 / 骨架里的禁用标识符
      '#c@js:', '#c@js:   ##', // 空段
      '#c@js:result##(', // 正则编译失败
    ]) {
      expect(codeOf(() => page(rule)), rule).toBeDefined();
    }
    expect(codeOf(() => page('#c@js:result##(##x'))).toBe('regex_invalid');
  });

  it('列表字段 JS：on 态放行 eval，段内 ##/{{}} 照旧拒（legado getElements 不 makeUp）', () => {
    const list = (rule: string) => parseFieldRule(rule, { ...ON, listJsEnabled: true, field: 'ruleSearch.bookList' });
    expect(list('@js:eval("[]")').chain).toEqual([{ kind: 'js', code: 'eval("[]")' }]);
    expect(codeOf(() => list('@js:[]##a'))).toBeDefined();
    expect(codeOf(() => list('@js:["{{$.x}}"]'))).toBeDefined();
    expect(codeOf(() => parseFieldRule('@js:eval("[]")', { ...OFF, listJsEnabled: true, field: 'ruleSearch.bookList' }))).toBeDefined();
  });

  it('条目级首段 JS：不读 result/src 才放行并记 detached；首段纯正则照旧拒', () => {
    expect(item('@js:"甲"').chain).toEqual([{ kind: 'js', code: '"甲"', detached: true }]);
    expect(item('@js:"{{@@.a@text}}" + "x"').chain?.[0]).toMatchObject({ kind: 'js', detached: true });
    for (const rule of [
      '@js:result', '@js:String(src)', '@js:eval("1")', '@js:this.result', '@js:globalThis.x', '@js:"{{result}}"',
      '@js:##a##b', '@js:"unterminated',
    ]) {
      expect(codeOf(() => item(rule)), rule).toBe('unsupported_js');
    }
    expect(item('.a@text@js:result + 1').chain?.[1]).toEqual({ kind: 'js', code: 'result + 1' }); // 非首段不挂 detached
  });
});

describe('求值', () => {
  it('eval 在沙箱里跑', async () => {
    await preloadJsSandbox();
    expect(value(page('@js:eval("1 + 1")'), '<p>x</p>')).toBe('2');
  });

  it('静态 ##：作用在 JS 结果上；replaceFirst 按 legado 只留首个匹配替换后的文本', async () => {
    await preloadJsSandbox();
    expect(value(page('#c@text@js:result + "a"##a##b'), '<div id="c">aa</div>')).toBe('bbb');
    expect(value(page('#c@text@js:result##a##b###'), '<div id="c">aa</div>')).toBe('b');
    expect(value(page('#c@text@js:##a##b'), '<div id="c">aa</div>')).toBe('bb');
  });

  it('模板：{{$.x}} 在字段作用域取值，{{JS}} 以上一段结果为 result；拼回后再切 ##', async () => {
    await preloadJsSandbox();
    const json = '{"x":"甲","y":"z"}';
    expect(value(page('@js:"{{$.x}}" + "!"'), json)).toBe('甲!');
    expect(value(page('@js:"{{$.x}}{{result.length}}"'), json)).toBe(`甲${json.length}`);
    expect(value(page('@js:"{{$.y}}z"##{{$.y}}##w'), json)).toBe('ww');
    expect(value(page('@js:"{{$.y}}z"##{{$.y}}##w###'), json)).toBe('w');
  });

  it('模板：makeUp 后代码为空只做替换；无替换得空串', async () => {
    await preloadJsSandbox();
    const json = '{"e":"","p":"a"}';
    expect(value(page('#c@js:{{$.e}}##{{$.p}}##b'), json)).toBe('');
    expect(value(page('@js:{{$.e}}##{{$.p}}##b'), json)).toBe('{"e":"","p":"b"}');
    expect(value(page('@js:{{$.e}}'), json)).toBe('');
  });

  it('模板：JS 占位结果为 null/数组、列表输入接模板 ⇒ 求值失败', async () => {
    await preloadJsSandbox();
    expect(codeOf(() => value(page('@js:"{{null}}"'), '<p>x</p>'))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => value(page('@js:"{{[1, 2]}}"'), '<p>x</p>'))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => value(page('<js>["a"]</js><js>"{{1}}"</js>'), '<p>x</p>'))).toBe('RULE_EVAL_FAILED');
  });

  it('静态 ## 接数组结果：列表模式逐项替换，字符串模式求值失败', async () => {
    await preloadJsSandbox();
    const field = page('@js:["a1", "a2"]##a##b');
    expect(evaluateFieldStrings(field, scopeOf('<p>x</p>'))).toEqual(['b1', 'b2']);
    expect(codeOf(() => value(field, '<p>x</p>'))).toBe('RULE_EVAL_FAILED');
  });

  it('条目级 detached 首段：作用域没有原文时以空串起链，模板规则占位在条目上取值', async () => {
    await preloadJsSandbox();
    const items = evaluateFieldList(parseFieldRule('.item', { field: 'ruleSearch.bookList' }), createHtmlScope(
      '<div class="item"><a>甲</a></div><div class="item"><a>乙</a></div>', PAGE_URL,
    ));
    expect(items.map((scope) => evaluateField(item('@js:"作者"'), scope))).toEqual(['作者', '作者']);
    expect(items.map((scope) => evaluateField(item('@js:"{{@@a@text}}" + "!"'), scope))).toEqual(['甲!', '乙!']);
    expect(items.map((scope) => evaluateField(item('<js>"x"</js>a@text'), scope))).toEqual(['', '']);
  });

  it('模板段按段原文记预算：换占位值不绕过单段预算', async () => {
    await preloadJsSandbox();
    const key = 'budget-key-jsext';
    for (let i = 0; i < 14; i += 1) codeOf(() => runJs(`while (true) {} // ${i}`, { result: '', baseUrl: SITE }, key));
    expect(codeOf(() => runJs('1 // other', { result: '', baseUrl: SITE }, key))).toBe('RULE_EVAL_FAILED');
    expect(runJs('1 // other', { result: '', baseUrl: SITE })).toBe('1');
  }, 30_000);
});

describe('source-usability 缓存口径', () => {
  const saved = process.env.ENGINE_SYNTAX_JS_EXT;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGINE_SYNTAX_JS_EXT;
    else process.env.ENGINE_SYNTAX_JS_EXT = saved;
  });

  it('翻 ENGINE_SYNTAX_JS_EXT 后 engineSourceUsable 重新判定', async () => {
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
          ruleContent: { content: '#c@html@js:eval("result")' },
        },
      };
      env.ENGINE_SYNTAX_JS_EXT = '0';
      const off = engineSourceUsable(source as never);
      env.ENGINE_SYNTAX_JS_EXT = '1';
      const on = engineSourceUsable(source as never);
      expect(off).toBe(false);
      expect(on).toBe(true);
    } finally {
      if (prev.js === undefined) delete env.ENGINE_SYNTAX_JS;
      else env.ENGINE_SYNTAX_JS = prev.js;
    }
  });
});
