// t2s1029：ENGINE_SYNTAX_JS_UTIL 下的 legado `java.t2s(text)` —— 词典完整性、转换口径（期望值由 or-sim 里逐字照 quick-transfer
// 0.2.17 Java 源码写的 Python 版算出，另有 2 万条合成串差分）、沙箱致命口径、编译期只收「结果按字符串用」的位置、按源判定。
// 输入均为合成串。
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineSourceRevision, sourceUsesJsUtilSyntax } from './compile';
import { createScope, evaluateField, normalizeBody } from './evaluate';
import { preloadJsSandbox, runJs, type JsBindings } from './js-sandbox';
import { parseFieldRule, type ParseOptions, type SourceConsts } from './parse';
import { t2s } from './t2s';
import { T2S_DICT_SHA256, T2S_DICT_TEXT } from './t2s-dict';
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
const NAME = 'ruleBookInfo.name';
const ON = { jsEnabled: true, jsUtilEnabled: true } as const;
const on = (rule: string, field = NAME, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field = NAME) => parseFieldRule(rule, { jsEnabled: true, jsUtilEnabled: false, field });
const value = (field: FieldIr, text: string) => evaluateField(field, createScope(normalizeBody(text), PAGE_URL));
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const bindings = (result: string, util = true): JsBindings => ({ result, src: result, baseUrl: PAGE_URL, utilHelpers: util || undefined });
const js = (code: string, result = '', util = true) => runJs(code, bindings(result, util));

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('词典与转换口径', () => {
  it('词典文本与生成时记下的 sha256 一致', () => {
    expect(createHash('sha256').update(T2S_DICT_TEXT, 'utf8').digest('hex')).toBe(T2S_DICT_SHA256);
  });

  it('单字查表、词组取最长叶子', () => {
    expect(t2s('這裡')).toBe('这里');
    expect(t2s('表徵')).toBe('表征');
    expect(t2s('表徵圖')).toBe('图标');
    expect(t2s('乾燥')).toBe('干燥');
    // 「乾」不在单字表里：原样
    expect(t2s('乾')).toBe('乾');
    // 词典有「行兇後=行凶後」，长者胜，「後」不再单字换
    expect(t2s('行兇後')).toBe('行凶後');
    expect(t2s('')).toBe('');
    expect(t2s('abc 123')).toBe('abc 123');
  });

  it('legado fixT2sDict 排除词：多字自映射、单字删表；更长的叶子照样生效', () => {
    expect(t2s('光碟')).toBe('光碟');
    expect(t2s('光碟機')).toBe('光驱');
    expect(t2s('機車')).toBe('機車');
    expect(t2s('機')).toBe('机');
    expect(t2s('沈船')).toBe('沈船');
    expect(t2s('槃')).toBe('槃');
    expect(t2s('電單車')).toBe('電單車');
    expect(t2s('奇幻魔法Melody')).toBe('奇幻魔法Melody');
  });

  it('按 UTF-16 单元：代理对键、单字换成代理对', () => {
    expect(t2s('\u{2005e}')).toBe('\u{2003e}');
    expect(t2s('㑮')).toBe('𫝈');
  });

  it('最长的键（20 个单元，即窗口大小）能整条命中', () => {
    const line = T2S_DICT_TEXT.split('\n').find((l) => l.indexOf('=') === 20);
    expect(line).toBeDefined();
    const [key, val] = [line!.slice(0, 20), line!.slice(21)];
    expect(t2s(key)).toBe(val);
    expect(t2s(`${key}x`)).toBe(`${val}x`);
  });
});

describe('沙箱', () => {
  it('on 态求值；实参口径不定一律致命（try/catch 吞不掉）', () => {
    expect(js('java.t2s(result)', '這裡')).toBe('这里');
    expect(js('"[" + java.t2s(result) + "]"', '機車')).toBe('[機車]');
    const fatal = (code: string) => codeOf(() => js(code, '這裡'));
    for (const code of ['java.t2s()', 'java.t2s(result, result)', 'java.t2s(12)', 'java.t2s(null)', 'java.t2s("a\\ud800b")']) {
      expect(fatal(code), code).toBe('RULE_EVAL_FAILED');
      expect(fatal(`try { ${code} } catch (e) { "caught" }`), code).toBe('RULE_EVAL_FAILED');
    }
  });

  it('off 态沙箱没有 t2s', () => {
    expect(js('typeof java.t2s')).toBe('function');
    expect(js('typeof java.t2s', '', false)).toBe('undefined');
  });
});

describe('编译期：结果只按字符串用', () => {
  it('完成值、字符串拼接与 String() 实参放行并标 jsUtil', () => {
    for (const rule of [
      '@js:java.t2s(result)',
      '@js:java.t2s(result);',
      '@js:var a = 1; java.t2s(result)',
      '@js:"x" + java.t2s(result)',
      '@js:String(java.t2s(result))',
    ]) {
      expect(on(rule).jsUtil, rule).toBe(true);
    }
  });

  it('当 JS 字符串取成员/比较/取类型/取函数/算术、模板字面量实参：拒', () => {
    for (const rule of [
      '@js:java.t2s(result).length',
      '@js:java.t2s(result) === "x"',
      '@js:typeof java.t2s(result)',
      '@js:var f = java.t2s; f(result)',
      '@js:java.t2s(result) * 1',
      '@js:java.t2s(`${result}`)',
    ]) {
      expect(codeOf(() => on(rule)), rule).toBe('unsupported_js');
    }
  });

  it('off 态拒', () => {
    expect(codeOf(() => off('@js:java.t2s(result)'))).toBe('unsupported_js');
  });

  it('注释 eval 里的完成值回到外层：拒；String() 包住：过', () => {
    const parse = (comment: string) => {
      const sourceConsts: SourceConsts = { key: SITE, comment };
      return () => on('.t@text@js:eval(String(source.bookSourceComment)); f(result)', NAME,
        { jsExtEnabled: true, jsBindEnabled: true, sourceConsts });
    };
    expect(codeOf(parse('function f(s) { return s }\njava.t2s("x")'))).toBe('unsupported_js');
    expect(codeOf(parse('function f(s) { return String(java.t2s(s)) }'))).toBeUndefined();
  });

  it('字段求值', () => {
    expect(value(on('#t@text@js:java.t2s(result)'), '<div id="t">這裡 光碟</div>')).toBe('这里 光碟');
  });
});

describe('按源判定', () => {
  it('只有用到 t2s 的源换版本、算用到帮手', () => {
    const opts = (jsUtilEnabled: boolean) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled: true, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false,
      jsGetEnabled: false, jsUtilEnabled,
    });
    const used = raw({ ruleContent: { content: '#c@text@js:java.t2s(result)' } });
    const misuse = raw({ ruleContent: { content: '#c@text@js:java.t2s(result).length' } });
    const plain = raw({ ruleBookInfo: { name: '#t@text@js:result.trim()' } });
    expect(engineSourceRevision(used, opts(true))).not.toBe(engineSourceRevision(used, opts(false)));
    for (const s of [misuse, plain]) expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false,
    };
    expect(sourceUsesJsUtilSyntax(used.rules, flags)).toBe(true);
    for (const s of [misuse, plain]) expect(sourceUsesJsUtilSyntax(s.rules, flags)).toBe(false);
  });
});
