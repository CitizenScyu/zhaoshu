// srcbind1028：ENGINE_SYNTAX_SOURCE_BIND —— JS 里的 legado `source`（BookSource）常量在编译期代入：书源地址（key/getKey()/
// bookSourceUrl/getBookSourceUrl()）与 `eval(String(source.bookSourceComment))`。开关、位值、代入口径、两态、准入按 env、求值。
// 规则与书源均为合成形态。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileAdmission } from './admission';
import { compileSource, engineSourceRevision, sourceConstsOf, type CompileOptions } from './compile';
import type { RawSource } from './compile-smoke';
import { createHtmlScope, evaluateField } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type SourceConsts } from './parse';
import { ENGINE_SEMANTICS_SOURCE_BIND_BIT, engineSemanticsVersion, engineSyntaxSourceBindEnabled } from './syntax-flags';
import type { FieldIr } from './types';

const SITE = 'https://example.com';
const NAME = 'ruleSearch.name';
const HTML = '<div class="t">ab</div>';
const KEY: SourceConsts = { key: SITE };
const ON: CompileOptions = { jsEnabled: true, jsExtEnabled: true, jsBindEnabled: true, sourceBindEnabled: true };
const OFF: CompileOptions = { ...ON, sourceBindEnabled: false };
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: { bookSourceUrl: SITE, ...rules } });
const parse = (rule: string, sourceConsts: SourceConsts | null = KEY, field = NAME, jsExtEnabled = true) =>
  parseFieldRule(rule, { field, jsEnabled: true, jsExtEnabled, jsBindEnabled: true, sourceConsts: sourceConsts ?? undefined });
const passes = (rule: string, consts?: SourceConsts | null, field?: string, jsExt?: boolean) => {
  try {
    parse(rule, consts, field, jsExt);
    return true;
  } catch {
    return false;
  }
};
const jsCode = (ir: FieldIr) => ir.chain?.filter((s) => s.kind === 'js').map((s) => (s as { code: string }).code);
const run = (ir: FieldIr) => evaluateField(ir, createHtmlScope(HTML, `${SITE}/`));

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('开关与语义版本', () => {
  it('engineSyntaxSourceBindEnabled 严格口径', () => {
    expect(engineSyntaxSourceBindEnabled({})).toBe(false);
    expect(engineSyntaxSourceBindEnabled({ ENGINE_SYNTAX_SOURCE_BIND: '0' })).toBe(false);
    expect(engineSyntaxSourceBindEnabled({ ENGINE_SYNTAX_SOURCE_BIND: 'yes' })).toBe(false);
    expect(engineSyntaxSourceBindEnabled({ ENGINE_SYNTAX_SOURCE_BIND: ' On ' })).toBe(true);
    expect(engineSyntaxSourceBindEnabled({ ENGINE_SYNTAX_SOURCE_BIND: 'TRUE' })).toBe(true);
    expect(engineSyntaxSourceBindEnabled({ ENGINE_SYNTAX_SOURCE_BIND: '1' })).toBe(true);
  });

  it('书源常量位 +536870912，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_SOURCE_BIND_BIT).toBe(536870912);
    const t = true;
    const f = false;
    const base = engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, f)).toBe(base);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t)).toBe(base + 536870912);
    expect(engineSemanticsVersion(f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, t))
      .toBe(engineSemanticsVersion(false) + 536870912);
  });

  it('按源判定：有字段因代入才编译通过才换版本；不读 source、代入也不过、JS 关都不换', () => {
    const uses = raw({ ruleSearch: { name: '.t@text@js:source.key + result' } });
    const plain = raw({ ruleSearch: { name: '.t@text@js:result + "x"' } });
    const stillRejected = raw({ ruleSearch: { name: '.t@text@js:source.key.match(/e/)[0]' } });
    const noKey = { ...uses, rules: { ...uses.rules, bookSourceUrl: '' } };
    expect(engineSourceRevision(uses, ON)).not.toBe(engineSourceRevision(uses, OFF));
    for (const s of [plain, stillRejected, noKey]) expect(engineSourceRevision(s, ON)).toBe(engineSourceRevision(s, OFF));
    expect(engineSourceRevision(uses, { ...ON, jsEnabled: false })).toBe(engineSourceRevision(uses, { ...OFF, jsEnabled: false }));
  });
});

describe('sourceConstsOf', () => {
  it('开关关、地址缺失/非字符串/空串 → 不给；注释空白或带 jsLib → 只给地址', () => {
    expect(sourceConstsOf({ bookSourceUrl: SITE }, false)).toBeUndefined();
    for (const bookSourceUrl of [undefined, 1, '']) expect(sourceConstsOf({ bookSourceUrl }, true)).toBeUndefined();
    expect(sourceConstsOf({ bookSourceUrl: SITE, bookSourceComment: '  ' }, true)).toEqual({ key: SITE });
    expect(sourceConstsOf({ bookSourceUrl: SITE, bookSourceComment: 'var a = 1', jsLib: 'var b = 2' }, true)).toEqual({ key: SITE });
    expect(sourceConstsOf({ bookSourceUrl: SITE, bookSourceComment: 'var a = 1' }, true)).toEqual({ key: SITE, comment: 'var a = 1' });
  });
});

describe('代入口径', () => {
  it('四种写法、字符串拼接、String()：代入成字面量', () => {
    expect(jsCode(parse('.t@text@js:source.key + result'))).toEqual([`"${SITE}" + result`]);
    expect(jsCode(parse('.t@text@js:result + source.getKey()'))).toEqual([`result + "${SITE}"`]);
    expect(jsCode(parse('.t@text@js:String(source.bookSourceUrl)'))).toEqual([`String("${SITE}")`]);
    expect(jsCode(parse('.t@text@js:var u = source.getBookSourceUrl() + "/a"; u + result'))).toEqual([`var u = "${SITE}" + "/a"; u + result`]);
    expect(jsCode(parse('.t@text@js:"/b" + source . key + result'))).toEqual([`"/b" + "${SITE}" + result`]);
  });

  it('只换代码位置：字符串/注释里的原样', () => {
    expect(jsCode(parse('.t@text@js:"source.key" + result'))).toEqual(['"source.key" + result']);
    expect(jsCode(parse('.t@text@js:result // source.key'))).toEqual(['result // source.key']);
  });

  it('Rhino 口径可能不同的位置不代入（照旧拒）', () => {
    for (const code of [
      'source.key.match(/e/)[0]', 'var k = source.key; k', 'source.key === result', 'typeof source.key', 'result - source.key',
      'source.key.length', 'source.key[0]', 'source.key * 1', 'return +source.key', 'source.key += result', 'source.keys',
      'source.getKey().split("/")[2]', 'source.bookSourceName',
    ]) expect(passes(`.t@text@js:${code}`), code).toBe(false);
  });

  it('`.replace(字面量, 字面量)` 折叠：目标至多出现一次、替换不含 $；否则不代入', () => {
    expect(jsCode(parse('.t@text@js:source.getKey().replace("https://", "http://") + result'))).toEqual(['"http://example.com" + result']);
    expect(jsCode(parse(".t@text@js:source.key.replace('www.', '').replace('.com', '.net') + result"))).toEqual(['"https://example.net" + result']);
    expect(jsCode(parse('.t@text@js:source.key.replace("zz", "y") + result'))).toEqual([`"${SITE}" + result`]);
    expect(passes('.t@text@js:source.key.replace("e", "y") + result')).toBe(false); // 出现两次：Java 全换、JS 只换首个
    expect(passes('.t@text@js:source.key.replace("https", "$&s") + result')).toBe(false);
    expect(passes('.t@text@js:source.key.replace(/e/g, "y") + result')).toBe(false);
  });

  it('字面量转义 {}#@<>：代入后拼不出 {{/##/@get', () => {
    const ir = parse('.t@text@js:source.key + result', { key: 'https://example.com/#{a}@<b>' });
    expect(jsCode(ir)).toEqual(['"https://example.com/\\u0023\\u007ba\\u007d\\u0040\\u003cb\\u003e" + result']);
    expect(run(ir)).toBe('https://example.com/#{a}@<b>ab');
  });

  it('off（不给书源常量）逐字照旧拒', () => {
    for (const rule of ['.t@text@js:source.key + result', '.t@text@js:String(source.bookSourceUrl)', '{{source.getKey()}}/x']) {
      expect(passes(rule, null, rule.startsWith('{{') ? 'ruleBookInfo.tocUrl' : NAME)).toBe(false);
    }
  });

  it('`{{}}` 模板整段是常量（或折叠后的常量）：代入', () => {
    const ir = parse('{{source.getKey()}}/x', KEY, 'ruleBookInfo.tocUrl');
    expect(ir.makeUp?.parts).toEqual([{ kind: 'js', code: `"${SITE}"` }, { kind: 'text', text: '/x' }]);
    const folded = parse('{{source.getKey().replace("https", "http")}}/x', KEY, 'ruleBookInfo.tocUrl');
    expect(folded.makeUp?.parts[0]).toEqual({ kind: 'js', code: '"http://example.com"' });
    expect(passes('{{source.getKey().length}}', KEY, 'ruleBookInfo.tocUrl')).toBe(false);
  });
});

describe('注释 eval', () => {
  const DEF = 'function f(s) { return s + "!" }\nvar base = source.key + "/b";';
  const consts: SourceConsts = { key: SITE, comment: DEF };
  it('注释代码过同段白名单后整段代入；注释里的书源地址先代入', () => {
    const ir = parse('.t@text@js:eval(String(source.bookSourceComment)); f(result) + base', consts);
    const code = jsCode(ir)?.[0] ?? '';
    expect(code.startsWith('eval(String("function f(s) \\u007b return s + \\"!\\" \\u007d\\nvar base = \\"https://example.com\\" + \\"/b\\";"))')).toBe(true);
    expect(run(ir)).toBe('ab!https://example.com/b');
  });
  it('jsext 关（eval 不放行）、注释含沙箱不提供的名字、没给注释：拒', () => {
    expect(passes('.t@text@js:eval(String(source.bookSourceComment)); f(result)', consts, NAME, false)).toBe(false);
    expect(passes('.t@text@js:eval(String(source.bookSourceComment)); f(result)', { key: SITE, comment: 'cookie.removeCookie(1)' })).toBe(false);
    expect(passes('.t@text@js:eval(String(source.bookSourceComment)); f(result)', KEY)).toBe(false);
  });
});

describe('compileSource 两态与准入', () => {
  it('off 态 skipped（逐字照旧）；on 态编译并求值', () => {
    const rules = { ruleSearch: { name: '.t@text@js:source.key + "/" + result' } };
    expect(compileSource(raw(rules), OFF).get(NAME)).toEqual({ skipped: 'unsupported' });
    const on = compileSource(raw(rules), ON).get(NAME) as FieldIr;
    expect(run(on)).toBe(`${SITE}/ab`);
    expect(compileSource(raw(rules), OFF).get(NAME)).toEqual({ skipped: 'unsupported' }); // 两态缓存互不污染
  });

  describe('compileAdmission 走 env', () => {
    const KEYS = ['ENGINE_SYNTAX_JS', 'ENGINE_SYNTAX_SOURCE_BIND'] as const;
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
    const admissionSource = {
      bookSourceUrl: SITE, bookSourceName: '常量源', searchUrl: `${SITE}/s?q={{key}}`, checkKeyWord: '测试关键字',
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text@js:result + source.key' },
      ruleToc: { chapterList: 'li', chapterName: 'text', chapterUrl: 'href' }, ruleContent: { content: '.c' },
    } as unknown as RawSource;
    it('开关开时可解释；开关关照旧拒', () => {
      expect(compileAdmission(admissionSource).ok).toBe(true);
      process.env.ENGINE_SYNTAX_SOURCE_BIND = '0';
      const off = compileAdmission(admissionSource);
      expect(off.ok).toBe(false);
      expect(off.reason).toContain('ruleBookInfo.name');
    });
  });
});
