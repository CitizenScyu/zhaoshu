// initjs1028：ENGINE_SYNTAX_INIT_JS —— 详情页 init 的 JS 模式（legado BookInfo `setContent(getElement(init))` → `evalJS(init, content)`）：
// 开关与语义版本位、getString 别名白名单、字符串/对象返回、第二实参校验、按源判定、准入初筛与门面接线。全部为合成形态。
import { beforeAll, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchDetail, type EngineSource } from './api';
import { compileSource, engineSourceRevision, type CompileOptions } from './compile';
import { selectCandidates, type RawSource } from './compile-smoke';
import { bookInfoScope, createScope, evaluateField, evaluateInitScope, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { initJsRuleSupported } from './parse';
import { ENGINE_SEMANTICS_INIT_JS_BIT, engineInitJsActive, engineSemanticsVersion, engineSyntaxInitJsEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const SITE = 'https://book15.net';
const SEARCH_URL = `${SITE}/s?q={{key}}`;
const BOOK_URL = `${SITE}/detail/1.html`;
const TOC_URL = `${SITE}/toc/1.html`;
const BASE_RULES: Record<string, unknown> = {
  ruleSearch: { bookList: '.book', name: '.name@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text' },
  ruleContent: { content: '.content@text' },
};
const ON: CompileOptions = { jsEnabled: true, jsGetEnabled: true, regexEnabled: true, initEnabled: true, initJsEnabled: true };
const OFF: CompileOptions = { ...ON, initJsEnabled: false };

const sourceOf = (bookInfo: Record<string, unknown>) => ({ url: `${SITE}/engine/`, searchUrl: SEARCH_URL, rules: { ...BASE_RULES, ruleBookInfo: bookInfo } });
const compiledInit = (init: string, options: CompileOptions = ON) => {
  const entry = compileSource(sourceOf({ init }), options).get('ruleBookInfo.init');
  return entry && !('skipped' in entry) ? entry : undefined;
};
const engineSource = (bookInfo: Record<string, unknown>, options: CompileOptions = ON): EngineSource => ({
  url: `${SITE}/engine/`, name: '引擎源', searchUrl: SEARCH_URL, compiled: compileSource(sourceOf(bookInfo), options),
});
const fakeContext = (pages: Map<string, string>): SourceRequestContext => ({
  page: async (url: string) => {
    const text = pages.get(url);
    if (text === undefined) throw new Error('Unexpected engine request: ' + url);
    return { url, text };
  },
}) as unknown as SourceRequestContext;
const scopeOf = (text: string) => createScope(normalizeBody(text), BOOK_URL);
const fieldOf = (rule: string): FieldIr => {
  const entry = compileSource(sourceOf({ name: rule }), ON).get('ruleBookInfo.name');
  if (!entry || 'skipped' in entry) throw new Error('fixture rule did not compile');
  return entry;
};
const evalCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.code : `non-engine:${String(err)}`;
  }
};

const HTML_PAGE = '<h1>站点</h1><div class="info"><h1>书名</h1><span class="writer">作者：某人</span><a class="toc" href="/toc/1.html">目录</a></div>';
const ALIAS_INIT = '@js:var X = (x) => java.getString(x);\n'
  + '({name: X(".info h1@text"), author: X(".writer@text"), tocUrl: X(".toc@href")})';
const DOLLAR_INIT = '@js:$ = _ => java.getString(_, result);\n({name: $(".info h1@text"), author: $(".writer@text")})';

beforeAll(async () => {
  await preloadJsSandbox();
});

describe('开关与语义版本', () => {
  it('engineSyntaxInitJsEnabled 严格口径；engineInitJsActive 须 ENGINE_SYNTAX_INIT 同开', () => {
    expect(engineSyntaxInitJsEnabled({})).toBe(false);
    expect(engineSyntaxInitJsEnabled({ ENGINE_SYNTAX_INIT_JS: '0' })).toBe(false);
    expect(engineSyntaxInitJsEnabled({ ENGINE_SYNTAX_INIT_JS: 'yes' })).toBe(false);
    expect(engineSyntaxInitJsEnabled({ ENGINE_SYNTAX_INIT_JS: ' On ' })).toBe(true);
    expect(engineSyntaxInitJsEnabled({ ENGINE_SYNTAX_INIT_JS: 'TRUE' })).toBe(true);
    expect(engineSyntaxInitJsEnabled({ ENGINE_SYNTAX_INIT_JS: '1' })).toBe(true);
    expect(engineInitJsActive({ ENGINE_SYNTAX_INIT_JS: '1' })).toBe(false);
    expect(engineInitJsActive({ ENGINE_SYNTAX_INIT: '1' })).toBe(false);
    expect(engineInitJsActive({ ENGINE_SYNTAX_INIT: '1', ENGINE_SYNTAX_INIT_JS: '1' })).toBe(true);
  });

  it('JS init 位 +524288，前 19 位逐字不变', () => {
    expect(ENGINE_SEMANTICS_INIT_JS_BIT).toBe(524288);
    const all = Array<boolean>(19).fill(true) as [boolean, ...boolean[]];
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 524288);
  });
});

describe('可复现形态判据（编译期）', () => {
  it('整条一段 JS 的 init 挂 initScope；off 态、JS 链关、init 关一律不挂', () => {
    expect(compiledInit(ALIAS_INIT)?.initScope).toBe(true);
    expect(compiledInit(DOLLAR_INIT)?.initScope).toBe(true);
    expect(compiledInit('@js:result')?.initScope).toBe(true);
    expect(compiledInit('<js>result</js>')?.initScope).toBe(true);
    expect(compiledInit(ALIAS_INIT, OFF)).toBeUndefined();
    expect(compiledInit(ALIAS_INIT, { ...ON, jsEnabled: false })).toBeUndefined();
    expect(compiledInit(ALIAS_INIT, { ...ON, initEnabled: false })?.initScope).toBeUndefined();
  });

  it('规则段接 JS、JS 后接 ## 替换不复现', () => {
    expect(compiledInit('class.info@js:result')?.initScope).toBeUndefined();
    expect(compiledInit('@js:result##a##b')?.initScope).toBeUndefined();
  });

  it('别名的非字面量用法、重定义、形参≠实参一律拒', () => {
    for (const init of [
      '@js:var X = (x) => java.getString(x); var k = "h1@text"; X(k)',
      '@js:var X = (x) => java.getString(x); X = 1; X("h1@text")',
      '@js:var X = (x) => java.getString(x); [X].map((f) => f("h1@text"))',
      '@js:var X = (x) => java.getString(y); X("h1@text")',
      '@js:var java2 = 1; var result = (x) => java.getString(x); result("h1@text")',
    ]) {
      expect(compiledInit(init)?.initScope).toBeUndefined();
    }
  });

  it('initJsRuleSupported：非字符串/不含 JS/不可复现为 false', () => {
    expect(initJsRuleSupported('@js:result')).toBe(true);
    expect(initJsRuleSupported('class.info')).toBe(false);
    expect(initJsRuleSupported(7)).toBe(false);
    expect(initJsRuleSupported('class.info@js:result')).toBe(false);
  });
});

describe('求值：legado evalJS(init, content)', () => {
  it('返回对象：详情字段按原文首段键名直取，## 替换照旧', async () => {
    const pages = new Map([[BOOK_URL, HTML_PAGE]]);
    const bookInfo = { init: ALIAS_INIT, name: 'name', author: 'author##作者：', tocUrl: 'tocUrl' };
    expect(await engineFetchDetail(engineSource(bookInfo), BOOK_URL, fakeContext(pages)))
      .toEqual({ title: '书名', author: '某人', tocUrl: TOC_URL });
  });

  it('`$ = _ => java.getString(_, result)` 别名：第二实参是 result 时照取', () => {
    const compiled = compileSource(sourceOf({ init: DOLLAR_INIT, name: 'name', intro: 'missing' }), ON);
    const scope = bookInfoScope(compiled, scopeOf(HTML_PAGE));
    const field = (name: string) => compiled.get(name) as FieldIr;
    expect(evaluateField(field('ruleBookInfo.name'), scope)).toBe('书名');
    expect(evaluateField(field('ruleBookInfo.intro'), scope)).toBe('');
  });

  it('第二实参不是详情页原文时求值失败', () => {
    const init = compiledInit('@js:var X = (x) => java.getString(x, result); result = "<p>别处</p>"; ({name: X("h1@text")})')!;
    expect(init.initScope).toBe(true);
    expect(evalCode(() => evaluateInitScope(init, scopeOf(HTML_PAGE)))).toBe('RULE_EVAL_FAILED');
  });

  it('返回字符串：按内容重新判定为新页面', () => {
    const scope = evaluateInitScope(compiledInit('@js:result.replace("<h1>站点</h1>", "")')!, scopeOf(HTML_PAGE));
    expect(evaluateField(fieldOf('h1@text'), scope)).toBe('书名');
    const json = evaluateInitScope(compiledInit('@js:JSON.stringify({name: "书"})')!, scopeOf(HTML_PAGE));
    expect(evaluateField(fieldOf('$.name'), json)).toBe('书');
  });

  it('null/undefined、数组、数字返回求值失败', () => {
    for (const init of ['@js:null', '@js:undefined', '@js:[1]', '@js:1']) {
      expect(evalCode(() => evaluateInitScope(compiledInit(init)!, scopeOf(HTML_PAGE)))).toBe('RULE_EVAL_FAILED');
    }
  });

  it('off 态编译产物与开关缺省一致，详情字段读整页', () => {
    const rules = { init: ALIAS_INIT, name: '.info h1@text' };
    const off = compileSource(sourceOf(rules), OFF);
    expect([...off.keys()]).toEqual([...compileSource(sourceOf(rules), { ...ON, initJsEnabled: undefined }).keys()]);
    const scope = scopeOf(HTML_PAGE);
    expect(bookInfoScope(off, scope)).toBe(scope);
  });
});

describe('按源判定与准入初筛', () => {
  it('只有 JS init 的源翻语义版本；jsLib 源与普通源不翻', () => {
    const using = sourceOf({ init: ALIAS_INIT, name: 'name' });
    const plain = sourceOf({ init: 'class.info', name: 'h1@text' });
    const notRepro = sourceOf({ init: 'class.info@js:result', name: 'h1@text' });
    const withLib = { ...using, rules: { ...using.rules, jsLib: 'function f(){}' } };
    expect(engineSourceRevision(using, ON)).not.toBe(engineSourceRevision(using, OFF));
    expect(engineSourceRevision(plain, ON)).toBe(engineSourceRevision(plain, OFF));
    expect(engineSourceRevision(notRepro, ON)).toBe(engineSourceRevision(notRepro, OFF));
    expect(engineSourceRevision(withLib, ON)).toBe(engineSourceRevision(withLib, OFF));
    expect(engineSourceRevision(using, { ...ON, initEnabled: false }))
      .toBe(engineSourceRevision(using, { ...OFF, initEnabled: false }));
  });

  it('selectCandidates：JS init 只在 coreJs 与 initJs 同开时放行', () => {
    const cand = {
      bookSourceUrl: SITE, searchUrl: SEARCH_URL,
      ruleSearch: { bookList: '.book', name: '.name@text', bookUrl: 'a@href' }, ruleContent: { content: '#c@html' },
      ruleBookInfo: { init: '@js:result', name: 'h1@text' },
    } as unknown as RawSource;
    expect(selectCandidates([cand], { coreJs: true }).length).toBe(0);
    expect(selectCandidates([cand], { initJs: true }).length).toBe(0);
    expect(selectCandidates([cand], { coreJs: true, initJs: true }).length).toBe(1);
    expect(selectCandidates([{ ...cand, jsLib: 'function f(){}' }], { coreJs: true, initJs: true }).length).toBe(0);
    const bad = { ...cand, ruleBookInfo: { init: 'class.info@js:result', name: 'h1@text' } } as unknown as RawSource;
    expect(selectCandidates([bad], { coreJs: true, initJs: true }).length).toBe(0);
  });
});
