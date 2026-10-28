// jslib1028：ENGINE_SYNTAX_JS_LIB —— legado 书源 jsLib（公共函数库）在共享作用域先求值、规则读得到库里的顶层名字。
// 库的静态判定（analyzeJsLib / jsLibRuleProblem）、语义版本位、compileSource 两态、准入按 env、沙箱求值。规则均为合成形态。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileAdmission } from './admission';
import { compileSource, engineSourceRevision, type CompileOptions } from './compile';
import type { RawSource } from './compile-smoke';
import { createHtmlScope, evaluateField } from './evaluate';
import { analyzeJsLib, jsLibRuleProblem, type JsLib } from './js-lib';
import { preloadJsSandbox } from './js-sandbox';
import { ENGINE_SEMANTICS_JS_LIB_BIT, engineSemanticsVersion, engineSyntaxJsLibEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const SITE = 'https://example.com';
const NAME = 'ruleSearch.name';
const DBL = 'function dbl(s) {\n  var t = String(s);\n  return t + t;\n}\nvar SEP = "-";';
const ON: CompileOptions = { jsEnabled: true, jsLibEnabled: true };
const OFF: CompileOptions = { jsEnabled: true, jsLibEnabled: false };
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const lib = (code: string): JsLib => {
  const out = analyzeJsLib(code);
  if (out === null) throw new Error('库不可分析');
  return out;
};
const field = (rules: Record<string, unknown>, options: CompileOptions, name = NAME): FieldIr | { skipped: string } | undefined =>
  compileSource(raw(rules), options).get(name);

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('开关与语义版本', () => {
  it('engineSyntaxJsLibEnabled 严格口径', () => {
    expect(engineSyntaxJsLibEnabled({})).toBe(false);
    expect(engineSyntaxJsLibEnabled({ ENGINE_SYNTAX_JS_LIB: '0' })).toBe(false);
    expect(engineSyntaxJsLibEnabled({ ENGINE_SYNTAX_JS_LIB: 'yes' })).toBe(false);
    expect(engineSyntaxJsLibEnabled({ ENGINE_SYNTAX_JS_LIB: ' On ' })).toBe(true);
    expect(engineSyntaxJsLibEnabled({ ENGINE_SYNTAX_JS_LIB: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsLibEnabled({ ENGINE_SYNTAX_JS_LIB: '1' })).toBe(true);
  });

  it('jsLib 位 +268435456，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_JS_LIB_BIT).toBe(268435456);
    const t = true;
    const f = false;
    const base = engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, f)).toBe(base);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t)).toBe(base + 268435456);
    expect(engineSemanticsVersion(f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, t))
      .toBe(engineSemanticsVersion(false) + 268435456);
  });

  it('按源判定：库可复现且有字段带 JS 才换版本；库不可分析、无 JS 字段、JS 关都不换', () => {
    const withJs = raw({ jsLib: DBL, ruleSearch: { name: '.t@text@js:dbl(result)' } });
    const noJs = raw({ jsLib: DBL, ruleSearch: { name: '.t@text' } });
    const jsonLib = raw({ jsLib: '{"a":"https://example.com/lib.js"}', ruleSearch: { name: '.t@text@js:dbl(result)' } });
    expect(engineSourceRevision(withJs, ON)).not.toBe(engineSourceRevision(withJs, OFF));
    for (const s of [noJs, jsonLib]) expect(engineSourceRevision(s, ON)).toBe(engineSourceRevision(s, OFF));
    expect(engineSourceRevision(withJs, { jsEnabled: false, jsLibEnabled: true }))
      .toBe(engineSourceRevision(withJs, { jsEnabled: false, jsLibEnabled: false }));
  });
});

describe('analyzeJsLib', () => {
  it('不可分析：非字符串/空白/JSON 形/模板字面量/class/箭头/顶层调用/顶层名撞保留名', () => {
    for (const code of [
      undefined, 1, '', '   ', '{"k":"https://example.com/a.js"}', 'var a = `x`', 'class A {}', 'var f = (x) => x',
      'init()', 'var x = f()', 'var java = 1', 'function result() {}', 'var __x = 1', 'function f() { return 1 ',
      'var s = "未闭合', 'if (a) { b = 1 }',
    ]) expect(analyzeJsLib(code)).toBeNull();
  });

  it('pure：函数体只用参数/局部名/顶层名/安全内建', () => {
    const out = lib(DBL);
    expect(out.pure).toBe(true);
    expect([...out.topNames].sort()).toEqual(['SEP', 'dbl']);
    expect(lib('function f(url) { return url + Math.max(1, 2) }').pure).toBe(true);
    expect(lib('var g = function (a) { return a.replace(/x/g, "y") };').pure).toBe(true);
  });

  it('impure：读宿主名、this、改内建/顶层名、可变初值、嵌套函数里的保留名、解构声明', () => {
    const why = (code: string) => lib(code).impureReason;
    expect(why('function f() { return java.md5Encode("a") }')).toBe('自由变量 java');
    expect(why('function f() { return this }')).toBe('this');
    expect(why('function f() { String.prototype.x = 1 }')).toBe('改 String 的成员');
    expect(why('function f(o) { return o.constructor }')).toBe('成员 constructor');
    expect(why('var c = 0; function inc() { c++ }')).toBe('给顶层名 c 赋值');
    expect(why('var M = {}; function f() { return 1 }')).toBe('顶层初值有数组/对象');
    expect(why('function f(url) { return [1].map(function (x) { return url + x }) }')).toBe('嵌套函数里声明了保留名 url');
    expect(why('function f() { const {java} = this; return java }')).toBe('声明后跟 {');
    expect(why('var o = 1; function f() { Math.k = o }')).toBe('改 Math 的成员');
  });
});

describe('jsLibRuleProblem', () => {
  const pure = lib(DBL);
  const impure = lib('function dec(s) { return java.base64Decode(s) }');
  it('规则不跑 JS：与库无关', () => {
    expect(jsLibRuleProblem(impure, '.dec@text')).toBeUndefined();
    expect(jsLibRuleProblem(pure, 'a@href')).toBeUndefined();
  });
  it('引用顶层名：库须 pure，不许赋值/重新声明顶层名或内建', () => {
    expect(jsLibRuleProblem(pure, '@js:dbl(result)+SEP')).toBeUndefined();
    expect(jsLibRuleProblem(impure, '@js:dec(result)')).toContain('dec');
    expect(jsLibRuleProblem(pure, '@js:dbl = 1; result')).toContain('赋值');
    expect(jsLibRuleProblem(pure, '@js:var SEP = "+"; dbl(result)')).toContain('SEP');
    expect(jsLibRuleProblem(pure, '@js:Math = 1; dbl(result)')).toContain('Math');
    expect(jsLibRuleProblem(pure, '@js:++SEP; dbl(result)')).toContain('SEP');
  });
  it('库函数内部的名字不算引用；不引用时 impure 库只拦动态取名', () => {
    expect(jsLibRuleProblem(pure, '@js:var t = 1; dbl(result) + t')).toBeUndefined();
    expect(jsLibRuleProblem(impure, '@js:result.trim()')).toBeUndefined();
    expect(jsLibRuleProblem(impure, '<js>eval("de" + "c")(result)</js>')).toContain('eval');
    expect(jsLibRuleProblem(impure, '@js:this[result](1)')).toContain('this');
    // 整段原文扫名字：字符串里出现顶层名也算引用（宁可多拒）
    expect(jsLibRuleProblem(impure, '@js:result + "dec"')).toContain('dec');
  });
});

describe('compileSource', () => {
  const rules = { jsLib: DBL, ruleSearch: { name: '.t@text@js:dbl(result)', author: '.a@text' } };
  it('off 态整源不开 JS 链（逐字照旧）；on 态编译并挂库原文', () => {
    expect(field(rules, OFF)).toEqual({ skipped: 'unsupported' });
    const on = field(rules, ON) as FieldIr;
    expect(on.chain?.map((s) => s.kind)).toEqual(['rule', 'js']);
    expect(on.jsLib).toBe(DBL);
    expect(field(rules, ON, 'ruleSearch.author')).not.toHaveProperty('jsLib');
    expect(field(rules, OFF)).toEqual({ skipped: 'unsupported' }); // 两态缓存互不污染
  });
  it('库不可分析或字段过不了 jsLibRuleProblem：照旧 skipped', () => {
    expect(field({ ...rules, jsLib: 'init()\nfunction dbl(s) { return s }' }, ON)).toEqual({ skipped: 'unsupported' });
    expect(field({ ...rules, jsLib: 'function dbl(s) { return java.md5Encode(s) }' }, ON)).toEqual({ skipped: 'unsupported' });
    expect(field({ ...rules, ruleSearch: { name: '@js:dbl = 1; result' } }, ON)).toEqual({ skipped: 'unsupported' });
  });
});

describe('求值', () => {
  const HTML = '<div class="t">ab</div>';
  it('规则调用库函数、读库里的顶层变量', () => {
    const ir = field({ jsLib: DBL, ruleSearch: { name: '.t@text@js:dbl(result) + SEP' } }, ON) as FieldIr;
    expect(evaluateField(ir, createHtmlScope(HTML, `${SITE}/`))).toBe('abab-');
  });
  it('库求值抛错：字段求值失败（legado 共享作用域口径）', () => {
    const broken = 'function dbl(s) { return s +* 1 }';
    expect(analyzeJsLib(broken)?.pure).toBe(true);
    const ir = field({ jsLib: broken, ruleSearch: { name: '.t@text@js:result' } }, ON) as FieldIr;
    expect(ir.jsLib).toBe(broken);
    expect(() => evaluateField(ir, createHtmlScope(HTML, `${SITE}/`))).toThrowError(/jsLib 求值失败/);
  });
  it('子字段沿用外层库，求值后不残留到别的字段', () => {
    const ir = field({ jsLib: DBL, ruleSearch: { name: '.t@text@js:dbl(result)' } }, ON) as FieldIr;
    const plain = field({ ruleSearch: { name: '.t@text@js:typeof dbl' } }, ON) as FieldIr;
    expect(evaluateField(ir, createHtmlScope(HTML, `${SITE}/`))).toBe('abab');
    expect(evaluateField(plain, createHtmlScope(HTML, `${SITE}/`))).toBe('undefined');
    expect(() => evaluateField(ir, createHtmlScope('<div class="t"></div>', `${SITE}/`))).not.toThrowError(RuleEngineError);
  });
});

describe('准入核心字段（走 env）', () => {
  const KEYS = ['ENGINE_SYNTAX_JS', 'ENGINE_SYNTAX_JS_LIB'] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      process.env[key] = '1';
    }
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const admissionSource = (jsLib: string) => ({
    bookSourceUrl: SITE, bookSourceName: '函数库源', searchUrl: `${SITE}/s?q={{key}}`, checkKeyWord: '测试关键字', jsLib,
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text@js:dbl(result)' },
    ruleToc: { chapterList: 'li', chapterName: 'text', chapterUrl: 'href' }, ruleContent: { content: '.c' },
  } as unknown as RawSource);

  it('compileAdmission：开关开且库可复现时可解释；库不纯或开关关照旧拒', () => {
    expect(compileAdmission(admissionSource(DBL)).ok).toBe(true);
    const impure = compileAdmission(admissionSource('function dbl(s) { return java.md5Encode(s) }'));
    expect(impure.ok).toBe(false);
    expect(impure.reason).toContain('ruleBookInfo.name');
    process.env.ENGINE_SYNTAX_JS_LIB = '0';
    expect(compileAdmission(admissionSource(DBL)).ok).toBe(false);
  });
});
