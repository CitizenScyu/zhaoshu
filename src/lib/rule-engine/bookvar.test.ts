// bookvar1028：ENGINE_SYNTAX_BOOK_VARIABLE —— jsoup + 书籍成员重试帧里放行字面量键的 legado `book.getVariable("键")`
// （源内没人放该键 ⇒ BaseBook.getVariable 落空得 Java 空串）；源级放变量扫描、语义版本位、按源判定、编译与门面求值。
// 规则均为合成形态。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { compileAdmission } from './admission';
import { engineFetchToc, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceBookVariablePuts, sourceUsesBookVariableSyntax, type CompileOptions } from './compile';
import type { RawSource } from './compile-smoke';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_BOOK_VARIABLE_BIT, engineSemanticsVersion, engineSyntaxBookVariableEnabled } from './syntax-flags';
import { RuleEngineError } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const TOC_URL = `${SITE}/book/1/`;
const BASE = { jsEnabled: true, listJsEnabled: true, jsBindEnabled: true, jsoupEnabled: true, bookFieldsEnabled: true } as const;
const ON = { ...BASE, bookVariableEnabled: true } as const;
const OFF = { ...BASE, bookVariableEnabled: false } as const;
const TOC = 'ruleToc.chapterList';
const NONE: ReadonlySet<string> = new Set();
const list = (rule: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...BASE, bookVariablePuts: NONE, ...extra, field: TOC });
const raw = (rules: Record<string, unknown>, searchUrl: unknown = `${SITE}/s?q={{key}}`) => ({ url: SITE, searchUrl, rules });

// kk169 形态：目录列表先取节点，JS 按用户设的「custom」截掉末尾若干章；没人设时原样返回
const TRIM = 'li.chapter@a <js>var r=result;\nvar v=book.getVariable("custom")\nvar b=[];\n'
  + 'if(v!=""){for(i=0;i<r.length-v;i++){b.push(r[i]);}result=b;}\nresult</js>';
const PAGE = '<ul><li class="chapter"><a href="/c/1.html">第一章</a></li><li class="chapter"><a href="/c/2.html">第二章</a></li></ul>';
const tocRules = (chapterList: string, chapterName = 'text') => ({ ruleToc: { chapterList, chapterName, chapterUrl: 'href' } });

function source(rules: Record<string, unknown>, options: CompileOptions = ON): EngineSource {
  const r = raw(rules);
  return { url: SITE, name: '书籍变量源', searchUrl: String(r.searchUrl), compiled: compileSource(r, options) };
}

const anyPage = (text: string) => ({ page: async (url: string) => ({ url, text }) } as unknown as SourceRequestContext);

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('开关与语义版本', () => {
  it('engineSyntaxBookVariableEnabled 严格口径', () => {
    expect(engineSyntaxBookVariableEnabled({})).toBe(false);
    expect(engineSyntaxBookVariableEnabled({ ENGINE_SYNTAX_BOOK_VARIABLE: '0' })).toBe(false);
    expect(engineSyntaxBookVariableEnabled({ ENGINE_SYNTAX_BOOK_VARIABLE: 'yes' })).toBe(false);
    expect(engineSyntaxBookVariableEnabled({ ENGINE_SYNTAX_BOOK_VARIABLE: ' On ' })).toBe(true);
    expect(engineSyntaxBookVariableEnabled({ ENGINE_SYNTAX_BOOK_VARIABLE: 'TRUE' })).toBe(true);
    expect(engineSyntaxBookVariableEnabled({ ENGINE_SYNTAX_BOOK_VARIABLE: '1' })).toBe(true);
  });

  it('书籍变量位 +134217728，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_BOOK_VARIABLE_BIT).toBe(134217728);
    const t = true;
    const f = false;
    const base = engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, f)).toBe(base);
    expect(engineSemanticsVersion(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t)).toBe(base + 134217728);
    expect(engineSemanticsVersion(f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, t))
      .toBe(engineSemanticsVersion(false) + 134217728);
  });

  it('源级放变量扫描：字面量键收集，动态键 / java 别名 / 下标 / eval / 转义字面量整源 null', () => {
    const puts = (rules: Record<string, unknown>, searchUrl?: unknown) => {
      const out = sourceBookVariablePuts(raw(rules, searchUrl));
      return out === null ? null : [...out].sort();
    };
    expect(puts(tocRules(TRIM))).toEqual([]);
    expect(puts({ ruleBookInfo: { name: '@js:java.put("a", result)' }, ruleSearch: { bookList: 'li@put:{b:"@text", "c":"x"}' } }))
      .toEqual(['a', 'b', 'c']);
    expect(puts({ jsLib: 'function f(){ book.putCustomVariable("9") }' })).toEqual(['custom']);
    expect(puts({}, `${SITE}/s?q={{java.put('k', key)}}`)).toEqual(['k']);
    expect(puts({ ruleBookInfo: { name: '@js:var k="custom";java.put(k, result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:java.put("cu" + "stom", result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:book.putVariable(1 ? "a" : "b", result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:book.putVariable("b" , result)' } })).toEqual(['b']);
    expect(puts({ ruleBookInfo: { name: '@js:var j=java;j.put("custom", result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:java["put"]("custom", result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:eval(result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:java.put("cu\\u0073tom", result)' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@put:name' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:book.setVariable("{}");result' } })).toBeNull();
    expect(puts({ ruleBookInfo: { name: '@js:source.setVariable("x");result' } })).toEqual([]);
  });

  it('按源判定：只有 off 拒、on 过的源换版本；源内放了该键、依赖开关关都不换', () => {
    const opts = (bookVariableEnabled: boolean, extra: Record<string, boolean> = {}) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, searchJsEnabled: false, jsExtEnabled: false, jsGetEnabled: false, ...BASE, bookVariableEnabled, ...extra,
    });
    const trim = raw(tocRules(TRIM));
    const putCustom = raw({ ...tocRules(TRIM), ruleBookInfo: { intro: '@js:java.put("custom", "1");result' } });
    const dynamicPut = raw({ ...tocRules(TRIM), ruleBookInfo: { intro: '@js:var k="x";java.put(k, "1");result' } });
    const plain = raw(tocRules('li.chapter@a'));
    expect(engineSourceRevision(trim, opts(true))).not.toBe(engineSourceRevision(trim, opts(false)));
    for (const s of [putCustom, dynamicPut, plain]) expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    for (const dep of ['jsoupEnabled', 'bookFieldsEnabled', 'jsBindEnabled']) {
      expect(engineSourceRevision(trim, opts(true, { [dep]: false }))).toBe(engineSourceRevision(trim, opts(false, { [dep]: false })));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: true, jsExtEnabled: false, jsGetEnabled: false, jsUtilEnabled: false, jsonPathEnabled: false,
      initJsEnabled: false, listGetEnabled: false,
    };
    expect(sourceUsesBookVariableSyntax(trim, flags)).toBe(true);
    for (const s of [putCustom, dynamicPut, plain]) expect(sourceUsesBookVariableSyntax(s, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译并挂 bookVars；两态缓存互不污染', () => {
    const compiled = (options: CompileOptions) => compileSource(raw(tocRules(TRIM)), options).get(TOC);
    expect(compiled(OFF)).toEqual({ skipped: 'unsupported' });
    const on = compiled(ON);
    expect(on).not.toHaveProperty('skipped');
    expect(on).toMatchObject({ jsoup: true, bookVars: ['custom'] });
    expect(on).not.toHaveProperty('bookMembers');
    expect(compiled({ ...ON, jsoupEnabled: false })).toEqual({ skipped: 'unsupported' });
    expect(compiled(OFF)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse', () => {
  it('缺源级键集、jsoup 或书籍成员关：照旧拒', () => {
    expect(codeOf(() => list(TRIM, { bookVariablePuts: undefined }))).toBe('unsupported_js');
    expect(codeOf(() => list(TRIM, { jsoupEnabled: false }))).toBe('unsupported_js');
    expect(codeOf(() => list(TRIM, { bookFieldsEnabled: false }))).toBe('unsupported_js');
    expect(list(TRIM).bookVars).toEqual(['custom']);
  });

  it('只收字面量键且键不在源级放变量集里；其余用法照旧拒', () => {
    expect(codeOf(() => list(TRIM, { bookVariablePuts: new Set(['custom']) }))).toBe('unsupported_js');
    expect(codeOf(() => list('li@a <js>var k="custom";book.getVariable(k);result</js>'))).toBe('unsupported_js');
    expect(codeOf(() => list('li@a <js>var f=book.getVariable;result</js>'))).toBe('unsupported_js');
    expect(codeOf(() => list('li@a <js>book.getVariable("a","b");result</js>'))).toBe('unsupported_js');
    expect(codeOf(() => list('li@a <js>book.putVariable("a","b");result</js>'))).toBe('unsupported_js');
    // 与书籍成员同用：两者都挂
    const both = parseFieldRule('@js:book.getVariable("k")+book.name', { ...BASE, bookVariablePuts: NONE, field: 'ruleToc.chapterName' });
    expect(both).toMatchObject({ bookVars: ['k'], bookMembers: ['name'] });
  });
});

describe('准入核心字段（走 env）', () => {
  const KEYS = [
    'ENGINE_SYNTAX_JS', 'ENGINE_SYNTAX_LIST_JS', 'ENGINE_SYNTAX_JS_BIND', 'ENGINE_SYNTAX_JSOUP', 'ENGINE_SYNTAX_BOOK_FIELDS',
    'ENGINE_SYNTAX_BOOK_VARIABLE', 'ADMISSION_NONCORE_JS',
  ] as const;
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
  const admissionSource = () => ({
    bookSourceUrl: SITE, bookSourceName: '书籍变量源', searchUrl: `${SITE}/s?q={{key}}`, checkKeyWord: '测试关键字',
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: TRIM.replace(' <js>', '\n<js>'), chapterName: 'text', chapterUrl: 'href' }, ruleContent: { content: '.c' },
  } as unknown as RawSource);

  it('compileAdmission：开关开时目录列表可解释；关或源内放了 custom 时照旧拒', () => {
    expect(compileAdmission(admissionSource()).ok).toBe(true);
    const put = admissionSource() as unknown as Record<string, Record<string, string>>;
    put.ruleBookInfo.intro = '@js:book.putCustomVariable("2");result';
    const putResult = compileAdmission(put as unknown as RawSource);
    expect(putResult.ok).toBe(false);
    expect(putResult.reason).toContain('ruleToc.chapterList');
    process.env.ENGINE_SYNTAX_BOOK_VARIABLE = '0';
    const off = compileAdmission(admissionSource());
    expect(off.ok).toBe(false);
    expect(off.reason).toContain('ruleToc.chapterList');
  });
});

describe('求值', () => {
  it('engineFetchToc：kk169 形态没人设 custom，原样返回全部章节', async () => {
    const toc = await engineFetchToc(source(tocRules(TRIM)), TOC_URL, anyPage(PAGE));
    expect(toc.chapters).toEqual([
      { url: `${SITE}/c/1.html`, title: '第一章' },
      { url: `${SITE}/c/2.html`, title: '第二章' },
    ]);
  });

  it('engineFetchToc：off 态列表 skipped，无章节', async () => {
    const toc = await engineFetchToc(source(tocRules(TRIM), OFF), TOC_URL, anyPage(PAGE)).catch(() => undefined);
    expect(toc?.chapters ?? []).toEqual([]);
  });

  it('得 Rhino Java 空串：typeof object、真值为真、与 "" 宽松相等、length 是方法', async () => {
    const name = '<js>var v=book.getVariable("k");typeof v+":"+(v?"t":"f")+":"+(v==""?"eq":"ne")+":"+v.length()+":"+result.text()</js>';
    const toc = await engineFetchToc(source(tocRules('li.chapter@a', name)), TOC_URL, anyPage(PAGE));
    expect(toc.chapters.map((c) => c.title)).toEqual(['object:t:eq:0:第一章', 'object:t:eq:0:第二章']);
  });
});
