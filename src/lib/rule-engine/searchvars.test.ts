// searchvars1028：ENGINE_SYNTAX_SEARCH_VARS —— 搜索 URL JS put（`java.put('k', …)`）→ 搜索字段 get（书籍列表 JS 的 `java.get('k')`、
// 条目字段的 `@get:{k}` / `java.get('k')`）：编译期子集、门面带袋、准入搜索腿、语义版本位。规则均为合成形态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { compileAdmission, searchAdmission, type AdmissionTransport } from './admission';
import { engineSearchBook, type EngineSource } from './api';
import { compileSearchVars, compileSource, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import { createScope, evaluateFieldList, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { prepareSearchJs } from './search-js';
import { ENGINE_SEMANTICS_SEARCH_VARS_BIT, engineSemanticsVersion, engineSyntaxSearchVarsEnabled } from './syntax-flags';
import { searchVarPlan } from './vars-subset';

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const PUT_URL = `<js>java.put('cat', '7')</js>${SITE}/s?q={{key}}`;
const JSON_PAGE = JSON.stringify({ list: [{ n: '甲书', u: '/b/1', c: '7' }, { n: '乙书', u: '/b/2', c: '8' }] });
const HTML_PAGE = '<div class="i"><span class="t">甲书</span><a href="/b/1">x</a></div>';
const FILTER = "@js:JSON.parse(result).list.filter(function(x){return x.c == java.get('cat')})";
const listRules = { bookList: FILTER, name: 'n', bookUrl: 'u' };
const ON = {
  varsEnabled: true, jsEnabled: true, listJsEnabled: true, jsBindEnabled: true, searchJsEnabled: true, searchVarsEnabled: true,
} as const;
const raw = (search: Record<string, unknown>, searchUrl = PUT_URL) => ({ url: SITE, searchUrl, rules: { ruleSearch: search } });
const engine = (search: Record<string, unknown>, options: Record<string, boolean> = ON, searchUrl = PUT_URL): EngineSource => ({
  url: SITE, name: '搜索袋源', searchUrl, compiled: compileSource(raw(search, searchUrl), options),
});
const anyPage = (text: string, urls: string[] = []) => ({
  page: async (url: string) => {
    urls.push(url);
    return { url, text };
  },
} as unknown as SourceRequestContext);

const ENV_KEYS = [
  'ENGINE_POST_SEARCH', 'ENGINE_SEARCH_JS', 'ENGINE_SYNTAX_VARS', 'ENGINE_SYNTAX_SEARCH_VARS', 'ENGINE_SYNTAX_JS', 'ENGINE_SYNTAX_LIST_JS',
] as const;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of ENV_KEYS) {
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

describe('开关与语义版本', () => {
  it('engineSyntaxSearchVarsEnabled 严格口径', () => {
    expect(engineSyntaxSearchVarsEnabled({})).toBe(false);
    expect(engineSyntaxSearchVarsEnabled({ ENGINE_SYNTAX_SEARCH_VARS: '0' })).toBe(false);
    expect(engineSyntaxSearchVarsEnabled({ ENGINE_SYNTAX_SEARCH_VARS: 'yes' })).toBe(false);
    expect(engineSyntaxSearchVarsEnabled({ ENGINE_SYNTAX_SEARCH_VARS: ' On ' })).toBe(true);
    expect(engineSyntaxSearchVarsEnabled({ ENGINE_SYNTAX_SEARCH_VARS: '1' })).toBe(true);
  });

  it('搜索袋位 +16777216，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_SEARCH_VARS_BIT).toBe(16777216);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 23 }, () => true);
    const none = Array.from({ length: 23 }, () => false);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 16777216);
    expect(version(...none, true)).toBe(version(false) + 16777216);
  });

  it('按源判定：只有搜索袋生效的源换版本，且要 ENGINE_SYNTAX_VARS 与搜索 JS 同开', () => {
    const opts = (searchVarsEnabled: boolean, varsEnabled = true, searchJsEnabled = true) => ({ ...ON, searchVarsEnabled, varsEnabled, searchJsEnabled });
    const bag = raw(listRules);
    const plain = raw({ bookList: '.i', name: '.t@text', bookUrl: 'a@href' });
    const orphan = raw({ ...listRules, bookList: FILTER.replace("'cat'", "'dog'") });
    expect(engineSourceRevision(bag, opts(true))).not.toBe(engineSourceRevision(bag, opts(false)));
    expect(engineSourceRevision(bag, opts(true, false))).toBe(engineSourceRevision(bag, opts(false, false)));
    expect(engineSourceRevision(bag, opts(true, true, false))).toBe(engineSourceRevision(bag, opts(false, true, false)));
    for (const s of [plain, orphan]) expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
  });
});

describe('编译期子集', () => {
  const ok = (search: Record<string, unknown>, searchUrl = PUT_URL) =>
    compileSearchVars(raw(search, searchUrl), { jsEnabled: true, listJsEnabled: true, jsBindEnabled: true }) !== null;

  it('searchUrl put → bookList JS / 条目 @get、java.get 可解释', () => {
    expect(ok(listRules)).toBe(true);
    expect(ok({ bookList: '.i', name: '.t@text@js:result + java.get("cat")', bookUrl: '{{@@a@href}}?c=@get:{cat}' })).toBe(true);
    expect(ok(listRules, `${SITE}/s?q={{key}}&c={{java.put('cat', '7')}}`)).toBe(true);
    expect(searchVarPlan({ ruleSearch: listRules }, PUT_URL)).toEqual({ puts: new Set(['cat']), gets: new Map([['bookList', new Set(['cat'])]]) });
  });

  it('子集外一律 null', () => {
    // searchUrl 不 put / 动态键 put；get 的键没被 put；动态键 get；内置键
    expect(ok(listRules, `<js>java.get('x')</js>${SITE}/s?q={{key}}`)).toBe(false);
    expect(ok(listRules, `<js>var k = 'cat'; java.put(k, '7')</js>${SITE}/s?q={{key}}`)).toBe(false);
    expect(ok({ ...listRules, bookList: FILTER.replace("'cat'", "'dog'") })).toBe(false);
    expect(ok({ ...listRules, bookList: "@js:var k = 'cat'; JSON.parse(result).list.filter(function(x){return x.c == java.get(k)})" })).toBe(false);
    expect(ok({ ...listRules, bookList: "@js:JSON.parse(result).list.filter(function(x){return x.n == java.get('bookName')})" }, `<js>java.put('bookName', '7')</js>${SITE}/s?q={{key}}`)).toBe(false);
    // 搜索字段自身 put（条目 put，另一套语义）
    expect(ok({ ...listRules, name: 'n@put:{x:"n"}' })).toBe(false);
    expect(ok({ ...listRules, author: '@js:java.put("x", "1")' })).toBe(false);
    // 只在非门面字段 get；没有字段读袋；`@get:` 不是 `{…}` 形态
    expect(ok({ bookList: '.i', name: '.t@text', bookUrl: 'a@href', kind: '@js:java.get("cat")' })).toBe(false);
    expect(ok({ bookList: '.i', name: '.t@text', bookUrl: 'a@href' })).toBe(false);
    expect(ok({ bookList: '.i', name: '.t@text##@get:cat', bookUrl: 'a@href' })).toBe(false);
    // 搜索组是 AllInOne
    expect(compileSearchVars(raw({ bookList: ':(\\d+)', name: '$1', bookUrl: "@js:java.get('cat')" }), { aioEnabled: true, jsEnabled: true })).toBeNull();
  });

  it('开关关：读袋搜索字段照旧 skipped；开时挂 varGets', () => {
    expect(engine(listRules, { ...ON, searchVarsEnabled: false }).compiled.get('ruleSearch.bookList')).toEqual({ skipped: 'unsupported' });
    expect(engine(listRules).compiled.get('ruleSearch.bookList')).toMatchObject({ varGets: true });
    expect(engine(listRules).compiled.get('ruleSearch.name')).not.toHaveProperty('varGets');
  });
});

describe('门面带袋', () => {
  it('书籍列表 JS 用 searchUrl put 的变量过滤条目', async () => {
    await preloadJsSandbox();
    await prepareSearchJs();
    const urls: string[] = [];
    const results = await engineSearchBook(engine(listRules), '书', anyPage(JSON_PAGE, urls));
    expect(results).toEqual([{ title: '甲书', author: '', bookUrl: `${SITE}/b/1` }]);
    expect(urls).toEqual([`${SITE}/s?q=%E4%B9%A6`]);
  });

  it('条目字段 @get makeUp 与 JS java.get', async () => {
    await preloadJsSandbox();
    await prepareSearchJs();
    const src = engine({ bookList: '.i', name: '.t@text@js:result + "-" + java.get("cat")', bookUrl: '{{@@a@href}}?c=@get:{cat}' });
    expect(await engineSearchBook(src, '书', anyPage(HTML_PAGE))).toEqual([{ title: '甲书-7', author: '', bookUrl: `${SITE}/b/1?c=7` }]);
  });

  it('袋按次求值：put 读搜索词', async () => {
    await preloadJsSandbox();
    await prepareSearchJs();
    const src = engine({ bookList: '.i', name: '.t@text', bookUrl: '{{@@a@href}}?k=@get:{kw}' }, ON, `<js>java.put('kw', key)</js>${SITE}/s?q={{key}}`);
    expect((await engineSearchBook(src, '甲', anyPage(HTML_PAGE)))[0].bookUrl).toBe(`${SITE}/b/1?k=%E7%94%B2`);
    expect((await engineSearchBook(src, '乙', anyPage(HTML_PAGE)))[0].bookUrl).toBe(`${SITE}/b/1?k=%E4%B9%99`);
  });

  it('读袋字段在没带袋的作用域上求值失败', async () => {
    await preloadJsSandbox();
    const ir = engine(listRules).compiled.get('ruleSearch.bookList');
    if (!ir || 'skipped' in ir) throw new Error('bookList 未编译');
    expect(() => evaluateFieldList(ir, createScope(normalizeBody(JSON_PAGE), `${SITE}/s`))).toThrow(expect.objectContaining({ name: 'RuleEngineError' }));
  });

  it('开关关：逐字走旧路径（读袋字段 skipped，搜索无结果）', async () => {
    await preloadJsSandbox();
    await prepareSearchJs();
    expect(await engineSearchBook(engine(listRules, { ...ON, searchVarsEnabled: false }), '书', anyPage(JSON_PAGE))).toEqual([]);
  });
});

describe('准入带袋', () => {
  const source = (search: Record<string, unknown> = listRules) => ({
    bookSourceUrl: SITE, bookSourceName: '搜索袋源', searchUrl: PUT_URL, checkKeyWord: '测试关键字',
    ruleSearch: search,
    ruleToc: { chapterList: '.toc li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
  } as unknown as RawSource);

  it('compileAdmission：开关开时读袋搜索字段可解释，关时照旧拒', () => {
    expect(compileAdmission(source()).ok).toBe(true);
    process.env.ENGINE_SYNTAX_SEARCH_VARS = '0';
    const off = compileAdmission(source());
    expect(off.ok).toBe(false);
    expect(off.reason).toContain('ruleSearch.bookList');
  });

  it('searchAdmission：同一次求值的袋过滤候选', async () => {
    await preloadJsSandbox();
    await prepareSearchJs();
    const fetchPage = vi.fn<AdmissionTransport>(async () => new Response(JSON_PAGE, { headers: { 'content-type': 'application/json' } }));
    const result = await searchAdmission(source(), {
      fetchPage, declaredHosts: new Set(['book15.net']), signal: new AbortController().signal, throttleMs: 0,
    });
    expect(result).toEqual({ verdict: 'ok', candidateCount: 1, status: 200, error: '' });
  });
});
