// listjs1027：ENGINE_SYNTAX_LIST_JS —— 列表字段 JS（legado AnalyzeRule.getElements 的 Js 模式）的编译、沙箱条目导出、
// 对象条目键值直取（legado getString 的 NativeObject 分支）、`-` 整表反转与语义版本。规则均为合成形态。
import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesListJsSyntax } from './compile';
import { compileCoreFieldsFromRules, selectCandidates, sourceHasJsChainField, type RawSource } from './compile-smoke';
import { createScope, evaluateField, evaluateFieldList, normalizeBody, type EvalScope } from './evaluate';
import { preloadJsSandbox, runJsItems } from './js-sandbox';
import { listJsGroups, listJsGroupsFlat, parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_LIST_JS_BIT, engineSemanticsVersion, engineSyntaxListJsEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const PAGE_URL = `${SITE}/s?q=x`;
const ON = { jsEnabled: true, listJsEnabled: true } as const;
const list = (rule: string, field = 'ruleSearch.bookList', extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const item = (rule: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, listJsGroup: true, ...extra, field: 'ruleSearch.name' });
const scopeOf = (text: string): EvalScope => createScope(normalizeBody(text), PAGE_URL);
const values = (items: EvalScope[], field: FieldIr) => items.map((scope) => evaluateField(field, scope));
const bindings = (result = '') => ({ result, src: result, baseUrl: SITE });

const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });

function source(rules: Record<string, unknown>, listJsEnabled = true): EngineSource {
  const r = raw(rules);
  return { url: SITE, name: '列表 JS 源', searchUrl: r.searchUrl, compiled: compileSource(r, { jsEnabled: true, listJsEnabled }) };
}

function context(pages: Map<string, string>): SourceRequestContext {
  return {
    page: async (url: string) => {
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  } as unknown as SourceRequestContext;
}

const anyPage = (text: string) => ({ page: async (url: string) => ({ url, text }) } as unknown as SourceRequestContext);

describe('开关与语义版本', () => {
  it('engineSyntaxListJsEnabled 严格口径', () => {
    expect(engineSyntaxListJsEnabled({})).toBe(false);
    expect(engineSyntaxListJsEnabled({ ENGINE_SYNTAX_LIST_JS: '0' })).toBe(false);
    expect(engineSyntaxListJsEnabled({ ENGINE_SYNTAX_LIST_JS: 'yes' })).toBe(false);
    expect(engineSyntaxListJsEnabled({ ENGINE_SYNTAX_LIST_JS: ' On ' })).toBe(true);
    expect(engineSyntaxListJsEnabled({ ENGINE_SYNTAX_LIST_JS: 'TRUE' })).toBe(true);
    expect(engineSyntaxListJsEnabled({ ENGINE_SYNTAX_LIST_JS: '1' })).toBe(true);
  });

  it('列表 JS 位 +512，1–512 逐字不变', () => {
    expect(ENGINE_SEMANTICS_LIST_JS_BIT).toBe(512);
    const base = engineSemanticsVersion(true, true, true, true, true, true, true, true, true);
    expect(engineSemanticsVersion(true, true, true, true, true, true, true, true, true, false)).toBe(base);
    expect(engineSemanticsVersion(true, true, true, true, true, true, true, true, true, true)).toBe(base + 512);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, false, true)).toBe(engineSemanticsVersion(false) + 512);
  });

  it('按源判定：只有列表含 JS、JS 链生效的源换版本', () => {
    const opts = (listJsEnabled: boolean, jsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled,
    });
    const listJs = raw({ ruleSearch: { bookList: '@js:[]', name: 'n', bookUrl: 'u' } });
    const tocJs = raw({ ruleToc: { chapterList: '-<js>[]</js>', chapterName: 'n' } });
    const plain = raw({ ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' } });
    const withLib = raw({ ...listJs.rules, jsLib: 'function f(){}' });
    expect(engineSourceRevision(plain, opts(true))).toBe(engineSourceRevision(plain, opts(false)));
    expect(engineSourceRevision(listJs, opts(true))).not.toBe(engineSourceRevision(listJs, opts(false)));
    expect(engineSourceRevision(tocJs, opts(true))).not.toBe(engineSourceRevision(tocJs, opts(false)));
    expect(engineSourceRevision(listJs, opts(true, false))).toBe(engineSourceRevision(listJs, opts(false, false)));
    expect(engineSourceRevision(withLib, opts(true))).toBe(engineSourceRevision(withLib, opts(false)));
    expect(sourceUsesListJsSyntax(listJs.rules)).toBe(true);
    expect(sourceUsesListJsSyntax(withLib.rules)).toBe(false);
    expect(sourceUsesListJsSyntax(plain.rules)).toBe(false);
  });

  it('listJsGroups / listJsGroupsFlat：AllInOne `:` 列表与非列表字段的 JS 不算', () => {
    expect([...listJsGroups({ ruleSearch: { bookList: '@js:[]' }, ruleToc: { chapterList: ':(a)@js:1' } })]).toEqual(['ruleSearch']);
    expect(listJsGroups({ ruleSearch: { bookList: '.a', name: '@js:1' } }).size).toBe(0);
    expect([...listJsGroupsFlat({ 'ruleToc.chapterList': '<js>[]</js>', 'ruleSearch.bookList': '.a' })]).toEqual(['ruleToc']);
  });

  it('compileSource：off 态列表照旧 skipped、条目不挂 objectKey；on 态两态缓存互不污染', () => {
    const rules = { ruleSearch: { bookList: '@js:[]', name: 'n', bookUrl: 'u' } };
    const off = source(rules, false).compiled;
    const on = source(rules, true).compiled;
    expect(off.get('ruleSearch.bookList')).toEqual({ skipped: 'unsupported' });
    expect(off.get('ruleSearch.name')).not.toHaveProperty('objectKey');
    expect(on.get('ruleSearch.bookList')).toEqual({ rules: [], chain: [{ kind: 'js', code: '[]' }] });
    expect(on.get('ruleSearch.name')).toMatchObject({ objectKey: { key: 'n' } });
    expect(source(rules, false).compiled.get('ruleSearch.bookList')).toEqual({ skipped: 'unsupported' });
  });

  it('compileCoreFieldsFromRules：on 态列表 JS 编译通过，off 态照旧失败', () => {
    const core = { 'ruleSearch.bookList': '@js:[]', 'ruleSearch.name': 'n', 'ruleSearch.bookUrl': 'u' };
    expect(compileCoreFieldsFromRules(core, { jsEnabled: true, listJsEnabled: true }).ok).toBe(true);
    const off = compileCoreFieldsFromRules(core, { jsEnabled: true, listJsEnabled: false });
    expect(off.ok).toBe(false);
    expect(off.failures.map((failure) => failure.field)).toEqual(['ruleSearch.bookList']);
    expect(compileCoreFieldsFromRules(core, { jsEnabled: false, listJsEnabled: true }).ok).toBe(false);
  });

  it('selectCandidates / sourceHasJsChainField：列表 JS 只在 coreJs 与 listJs 同开时放行', () => {
    const cand = {
      bookSourceUrl: SITE, searchUrl: `${SITE}/s?q={{key}}`,
      ruleSearch: { bookList: '@js:[]', name: 'n', bookUrl: 'u' }, ruleContent: { content: '#c@html' },
    } as unknown as RawSource;
    expect(selectCandidates([cand], { coreJs: true }).length).toBe(0);
    expect(selectCandidates([cand], { listJs: true }).length).toBe(0);
    expect(selectCandidates([cand], { coreJs: true, listJs: true }).length).toBe(1);
    expect(selectCandidates([{ ...cand, jsLib: 'function f(){}' }], { coreJs: true, listJs: true }).length).toBe(0);
    expect(sourceHasJsChainField(cand, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(sourceHasJsChainField(cand, { ENGINE_SYNTAX_LIST_JS: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('runJsItems（沙箱条目导出）', () => {
  it('null/undefined → null；非数组 → 求值失败（legado 强转 List 失败）', async () => {
    await preloadJsSandbox();
    expect(runJsItems('null', bindings())).toBeNull();
    expect(runJsItems('undefined', bindings())).toBeNull();
    for (const code of ['"s"', '1', '({a: "x"})', 'true']) expect(codeOf(() => runJsItems(code, bindings()))).toBe('RULE_EVAL_FAILED');
  });

  it('字符串项原样；对象项：字符串/布尔取值，null/undefined 不入表，其余值记 null', async () => {
    await preloadJsSandbox();
    const items = runJsItems('["a", {n: "x", b: true, f: false, z: 1, o: {}, l: [], u: undefined, nn: null}]', bindings());
    expect(items).toEqual(['a', new Map<string, string | null>([['n', 'x'], ['b', 'true'], ['f', 'false'], ['z', null], ['o', null], ['l', null]])]);
  });

  it('访问器不触发、记 null；JSON 解析出的 __proto__ 键按自有属性收', async () => {
    await preloadJsSandbox();
    const getter = runJsItems('var o = {}; Object.defineProperty(o, "g", {get: function () { return "x"; }, enumerable: true}); [o]', bindings());
    expect(getter).toEqual([new Map([['g', null]])]);
    const proto = runJsItems('[JSON.parse(result)]', bindings('{"__proto__":"p","n":"x"}'));
    expect(proto).toEqual([new Map([['__proto__', 'p'], ['n', 'x']])]);
  });

  it('数组含数字/数组/非普通对象 → 求值失败', async () => {
    await preloadJsSandbox();
    for (const code of ['[1]', '[["a"]]', '[new Date(0)]', '[null]', '["a", function () {}]']) {
      expect(codeOf(() => runJsItems(code, bindings()))).toBe('RULE_EVAL_FAILED');
    }
  });

  it('result 绑定页面原文', async () => {
    await preloadJsSandbox();
    expect(runJsItems('JSON.parse(result).map(function (x) { return x.n; })', bindings('[{"n":"a"},{"n":"b"}]'))).toEqual(['a', 'b']);
  });
});

describe('parse：列表 JS 链', () => {
  it('off：列表字段含 JS 照旧拒', () => {
    expect(codeOf(() => parseFieldRule('@js:[]', { jsEnabled: true, listJsEnabled: false, field: 'ruleSearch.bookList' }))).toBeDefined();
    expect(codeOf(() => parseFieldRule('@js:[]', { jsEnabled: false, listJsEnabled: true, field: 'ruleSearch.bookList' }))).toBeDefined();
  });

  it('纯 JS 段与 JS + 末段规则；末段模式按前缀', () => {
    expect(list('@js:[]')).toEqual({ rules: [], chain: [{ kind: 'js', code: '[]' }] });
    expect(list('<js>a</js><js>b</js>').chain).toEqual([{ kind: 'js', code: 'a' }, { kind: 'js', code: 'b' }]);
    const tail = (rule: string) => {
      const stage = list(rule).chain?.[1];
      return stage?.kind === 'rule' ? stage.mode : undefined;
    };
    expect(tail('<js>result</js>\n@css:.item')).toBe('html');
    expect(tail('<js>result</js>@CSS:.item')).toBe('html');
    expect(tail('<js>result</js>@@.item')).toBe('html');
    expect(tail('<js>result</js>.item')).toBe('default');
    expect(tail('<js>result</js>$.data[*]')).toBe('json');
    expect(tail('<js>result</js>@Json:$.data[*]')).toBe('json');
  });

  it('`-` 前缀记 reverse（先剥 `-` 再剥 `+`）', () => {
    expect(list('-@js:[]', 'ruleToc.chapterList').reverse).toBe(true);
    expect(list('-+@js:[]', 'ruleToc.chapterList').reverse).toBe(true);
    expect(list('+@js:[]')).not.toHaveProperty('reverse');
  });

  it('拒绝不能对齐 legado 的形态', () => {
    for (const rule of [
      '.a@js:result', // 首段是规则（节点要 Java 互操作）
      '<js>a</js>.b<js>c</js>', // JS 段之间夹规则段
      '<js>a</js>.b##x', '<js>a</js>.b@get:{k}', '<js>a</js>$1', '<js>a</js>:x', // 末段 ##/@get/$N/`:`
      '@js:java.ajax("x")', '@js:book.name', // 沙箱不提供
    ]) {
      expect(codeOf(() => list(rule)), rule).toBeDefined();
    }
  });
});

describe('parse：对象条目键值直取（objectKey）', () => {
  it('首段规则文本即键：剥 @@，`$.` 留在键里（legado 取不到 ⇒ 空串）', () => {
    expect(item('bookName').objectKey).toEqual({ key: 'bookName' });
    expect(item('@@bookName').objectKey).toEqual({ key: 'bookName' });
    expect(item('$.name').objectKey).toEqual({ key: '$.name' });
  });

  it('`##` 替换按 Kotlin split：第 4 段起 replaceFirst', () => {
    expect(item('name##a##b').objectKey).toEqual({ key: 'name', regex: { pattern: 'a', replacement: 'b' } });
    expect(item('name##a').objectKey).toEqual({ key: 'name', regex: { pattern: 'a', replacement: '' } });
    expect(item('name##a##b###', { regexEnabled: true }).objectKey)
      .toEqual({ key: 'name', regex: { pattern: 'a', replacement: 'b', first: true } });
  });

  it('带 JS 段的条目字段：只取 JS 之前的首段当键；首段即 JS 的条目字段照旧编译期拒', () => {
    expect(item('n@js:result + 1').objectKey).toEqual({ key: 'n' });
    expect(codeOf(() => item('@js:result.n'))).toBeDefined();
  });

  it('只挂在列表 JS 组的非列表字段上，且 JS 与列表 JS 都开', () => {
    expect(parseFieldRule('n', { ...ON, field: 'ruleSearch.name' })).not.toHaveProperty('objectKey');
    expect(item('n', { listJsEnabled: false })).not.toHaveProperty('objectKey');
    expect(item('n', { jsEnabled: false })).not.toHaveProperty('objectKey');
    expect(list('@js:[]', 'ruleSearch.bookList', { listJsGroup: true })).not.toHaveProperty('objectKey');
  });
});

describe('求值', () => {
  it('HTML 页上的对象条目：键值直取、## 替换、实体解码、trim；缺键 ⇒ 空串，数字值求值失败', async () => {
    await preloadJsSandbox();
    const items = evaluateFieldList(list('@js:[{n: "甲&amp;书 ", u: "/b/1"}, {n: "乙", b: true, z: 1}]'), scopeOf('<p>x</p>'));
    expect(items).toHaveLength(2);
    expect(values(items, item('n'))).toEqual(['甲&书', '乙']);
    expect(evaluateField(item('n##书##本'), items[0])).toBe('甲&本');
    expect(evaluateField(item('u'), items[0])).toBe('/b/1');
    expect(evaluateField(item('missing'), items[0])).toBe('');
    expect(evaluateField(item('b'), items[1])).toBe('true');
    expect(codeOf(() => evaluateField(item('z'), items[1]))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => evaluateField({ rules: [] }, items[0]))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => evaluateField({ rules: [], objectKey: { unsupported: 'x' } }, items[0]))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => evaluateFieldList(list('@js:[]'), items[0]))).toBe('RULE_EVAL_FAILED'); // 条目作用域没有页面原文
  });

  it('HTML 页上的字符串条目按 HTML 重新解析', async () => {
    await preloadJsSandbox();
    const items = evaluateFieldList(list('@js:["<a href=\\"/b/1\\">甲</a>", "<a href=\\"/b/2\\">乙</a>"]'), scopeOf('<p>x</p>'));
    expect(values(items, parseFieldRule('a@text', { field: 'ruleSearch.name' }))).toEqual(['甲', '乙']);
  });

  it('JSON 页：对象条目键值直取；字符串条目按 JSON 解析，非 JSON 求值失败', async () => {
    await preloadJsSandbox();
    const page = scopeOf('{"data":[{"n":"甲"},{"n":"乙"}]}');
    expect(values(evaluateFieldList(list('@js:JSON.parse(result).data'), page), item('n'))).toEqual(['甲', '乙']);
    const strings = evaluateFieldList(list('@js:JSON.parse(result).data.map(function (x) { return JSON.stringify(x); })'), page);
    expect(values(strings, parseFieldRule('$.n', { field: 'ruleSearch.name' }))).toEqual(['甲', '乙']);
    expect(codeOf(() => evaluateFieldList(list('@js:["<p>x</p>"]'), page))).toBe('RULE_EVAL_FAILED');
  });

  it('JS + 末段规则：把 JS 产出的字符串按原页面模式重新解析；模式对不上求值失败', async () => {
    await preloadJsSandbox();
    const html = scopeOf('<ul><li><a href="/b/1">甲</a></li><li><a href="/b/2">乙</a></li></ul>');
    const name = parseFieldRule('a@text', { field: 'ruleSearch.name' });
    expect(values(evaluateFieldList(list('<js>result.replace("甲", "丙")</js>li'), html), name)).toEqual(['丙', '乙']);
    expect(values(evaluateFieldList(list('<js>result</js>@css:li'), html), name)).toEqual(['甲', '乙']);
    expect(codeOf(() => evaluateFieldList(list('<js>result</js>$.data[*]'), html))).toBe('RULE_EVAL_FAILED');
    const json = scopeOf('{"data":[{"n":"甲"}]}');
    expect(values(evaluateFieldList(list('<js>result</js>$.data[*]'), json), parseFieldRule('$.n', { field: 'ruleSearch.name' })))
      .toEqual(['甲']);
    expect(codeOf(() => evaluateFieldList(list('<js>result</js>@css:li'), json))).toBe('RULE_EVAL_FAILED');
  });

  it('中间段 null ⇒ 空列表；中间段数组求值失败；末段 null ⇒ 空列表', async () => {
    await preloadJsSandbox();
    const page = scopeOf('<p>x</p>');
    expect(evaluateFieldList(list('<js>null</js><js>["a"]</js>'), page)).toEqual([]);
    expect(evaluateFieldList(list('@js:null'), page)).toEqual([]);
    expect(codeOf(() => evaluateFieldList(list('<js>["a"]</js><js>[result]</js>'), page))).toBe('RULE_EVAL_FAILED');
  });
});

describe('api：反转与去重（legado BookList / BookChapterList）', () => {
  const searchRules = (bookList: string) => ({ ruleSearch: { bookList, name: 'n', bookUrl: 'u', author: 'a' } });
  const books = '[{n: "甲", u: "/b/1"}, {n: "乙", u: "/b/2", a: "张"}, {n: "甲二", u: "/b/1"}]';

  it('engineSearchBook：首次出现去重；`-` 去重后整表反转', async () => {
    expect(await engineSearchBook(source(searchRules(`@js:${books}`)), '书', anyPage('<p>x</p>'))).toEqual([
      { title: '甲', author: '', bookUrl: `${SITE}/b/1` },
      { title: '乙', author: '张', bookUrl: `${SITE}/b/2` },
    ]);
    expect(await engineSearchBook(source(searchRules(`-@js:${books}`)), '书', anyPage('<p>x</p>'))).toEqual([
      { title: '乙', author: '张', bookUrl: `${SITE}/b/2` },
      { title: '甲', author: '', bookUrl: `${SITE}/b/1` },
    ]);
  });

  it('engineSearchBook：off 态列表 skipped，无结果', async () => {
    expect(await engineSearchBook(source(searchRules(`@js:${books}`), false), '书', anyPage('<p>x</p>'))).toEqual([]);
  });

  it('engineFetchToc：同 url 保留最后一次出现；`-` 先整表反转再去重', async () => {
    const tocUrl = `${SITE}/book/1/`;
    const chapters = '[{n: "一", u: "/c/1"}, {n: "二", u: "/c/2"}, {n: "一重", u: "/c/1"}]';
    const toc = (chapterList: string) => source({ ruleToc: { chapterList, chapterName: 'n', chapterUrl: 'u' } });
    const pages = new Map([[tocUrl, '<p>x</p>']]);
    const forward = await engineFetchToc(toc(`@js:${chapters}`), tocUrl, context(pages));
    expect(forward.chapters).toEqual([{ url: `${SITE}/c/2`, title: '二' }, { url: `${SITE}/c/1`, title: '一重' }]);
    const reversed = await engineFetchToc(toc(`-@js:${chapters}`), tocUrl, context(pages));
    expect(reversed.chapters).toEqual([{ url: `${SITE}/c/2`, title: '二' }, { url: `${SITE}/c/1`, title: '一' }]);
  });
});
