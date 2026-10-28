// itemvars1028：ENGINE_SYNTAX_ITEM_VARS —— 搜索条目袋（legado SearchBook 以搜索 RuleData 为初值）：条目字段 `@put` / 字面量键
// `java.put` → 后面的条目字段、详情、目录读回；袋随搜索结果带给详情。编译期子集、门面、准入搜索腿与影子腿、语义版本位。规则均为合成形态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { compileAdmission, readabilityShadow, searchAdmission, type AdmissionTransport } from './admission';
import { engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { compileItemVars, compileSource, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import { preloadJsSandbox } from './js-sandbox';
import { prepareSearchJs } from './search-js';
import { ENGINE_SEMANTICS_ITEM_VARS_BIT, engineSemanticsVersion, engineSyntaxItemVarsEnabled } from './syntax-flags';

const SITE = 'https://book15.net'; // 内置 host（运行时 host 门放行）
const PLAIN_URL = `${SITE}/s?q={{key}}`;
const PUT_URL = `<js>java.put('cat', '7')</js>${SITE}/s?q={{key}}`;
const BOOK_URL = `${SITE}/b/1.html`;
const TOC_URL = `${SITE}/toc/1.html`;
const SEARCH = '<div class="i"><span class="t">甲书</span><b class="n">7</b><a href="/b/1.html">x</a></div>'
  + '<div class="i"><span class="t">乙书</span><b class="n">8</b><a href="/b/2.html">x</a></div>';
const DETAIL = '<h1>书名</h1><span id="bid">42</span><a class="toc" href="/toc/1.html">目录</a>';
const TOC = '<li class="ch"><a href="/c/1.html">第1章</a></li><li class="ch"><a href="/c/2.html">第2章</a></li>';
const ON = {
  varsEnabled: true, jsEnabled: true, listJsEnabled: true, jsBindEnabled: true, searchJsEnabled: true, searchVarsEnabled: true,
  itemVarsEnabled: true,
} as const;
const putBid = { bookList: '.i', name: '.t@text@put:{bid:".n@text"}', bookUrl: 'a@href' };
const tocWith = (chapterUrl: string) => ({ chapterList: '.ch', chapterName: 'a@text', chapterUrl });
const tocGet = tocWith('{{@@a@href}}?b=@get:{bid}');
const raw = (rules: Record<string, unknown>, searchUrl = PLAIN_URL) => ({ url: SITE, searchUrl, rules });
const engine = (rules: Record<string, unknown>, options: Record<string, boolean> = ON, searchUrl = PLAIN_URL): EngineSource => ({
  url: SITE, name: '条目袋源', searchUrl, compiled: compileSource(raw(rules, searchUrl), options),
});
const context = (urls: string[] = []) => ({
  page: async (url: string) => {
    urls.push(url);
    const { pathname } = new URL(url);
    const text = pathname === '/s' ? SEARCH : pathname === '/b/1.html' ? DETAIL : pathname === '/toc/1.html' ? TOC : undefined;
    if (text === undefined) throw new Error('Unexpected request: ' + url);
    return { url, text };
  },
} as unknown as SourceRequestContext);

// 搜索 JS 与准入走 env；门面编译用显式选项。
const ENV_KEYS = [
  'ENGINE_POST_SEARCH', 'ENGINE_SEARCH_JS', 'ENGINE_SYNTAX_VARS', 'ENGINE_SYNTAX_SEARCH_VARS', 'ENGINE_SYNTAX_ITEM_VARS', 'ENGINE_SYNTAX_JS',
  'ENGINE_SYNTAX_LIST_JS',
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
  it('engineSyntaxItemVarsEnabled 严格口径', () => {
    expect(engineSyntaxItemVarsEnabled({})).toBe(false);
    expect(engineSyntaxItemVarsEnabled({ ENGINE_SYNTAX_ITEM_VARS: '0' })).toBe(false);
    expect(engineSyntaxItemVarsEnabled({ ENGINE_SYNTAX_ITEM_VARS: 'yes' })).toBe(false);
    expect(engineSyntaxItemVarsEnabled({ ENGINE_SYNTAX_ITEM_VARS: ' On ' })).toBe(true);
    expect(engineSyntaxItemVarsEnabled({ ENGINE_SYNTAX_ITEM_VARS: '1' })).toBe(true);
  });

  it('条目袋位 +33554432，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_ITEM_VARS_BIT).toBe(33554432);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 24 }, () => true);
    const none = Array.from({ length: 24 }, () => false);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 33554432);
    expect(version(...none, true)).toBe(version(false) + 33554432);
  });

  it('按源判定：只有条目袋生效的源换版本，且要搜索袋同开', () => {
    const opts = (itemVarsEnabled: boolean, searchVarsEnabled = true) => ({ ...ON, itemVarsEnabled, searchVarsEnabled });
    const bag = raw({ ruleSearch: putBid, ruleToc: tocGet });
    const plain = raw({ ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleToc: tocWith('a@href') });
    const orphan = raw({ ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleToc: tocGet });
    expect(engineSourceRevision(bag, opts(true))).not.toBe(engineSourceRevision(bag, opts(false)));
    expect(engineSourceRevision(bag, opts(true, false))).toBe(engineSourceRevision(bag, opts(false, false)));
    for (const s of [plain, orphan]) expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
  });
});

describe('编译期子集', () => {
  const ok = (rules: Record<string, unknown>, searchUrl = PLAIN_URL) =>
    compileItemVars(raw(rules, searchUrl), { jsEnabled: true, listJsEnabled: true, jsBindEnabled: true }) !== null;
  const search = (fields: Record<string, unknown>) => ({ bookList: '.i', name: '.t@text', bookUrl: 'a@href', ...fields });

  it('条目 put → 更后的条目字段 / 详情 / 目录读回可解释', () => {
    expect(ok({ ruleSearch: search({ name: '.t@text@put:{bid:".n@text"}', bookUrl: '{{@@a@href}}?b=@get:{bid}' }) })).toBe(true);
    expect(ok({ ruleSearch: search({ kind: '.n@text@put:{bid:".n@text"}', bookUrl: '{{@@a@href}}?b=@get:{bid}' }) })).toBe(true);
    expect(ok({ ruleSearch: search({ name: '.t@text@js:java.put("bid", "n" + result.length); result' }), ruleToc: tocGet })).toBe(true);
    expect(ok({ ruleSearch: putBid, ruleToc: tocGet })).toBe(true);
    expect(ok({ ruleSearch: putBid, ruleBookInfo: { name: 'h1@text@js:result + java.get("bid")' } })).toBe(true);
    // searchUrl 的键带到详情 / 目录
    expect(ok({ ruleSearch: search({}), ruleToc: tocWith('{{@@a@href}}?c=@get:{cat}') }, PUT_URL)).toBe(true);
  });

  it('子集外一律 null', () => {
    // 动态键；java.put 在 kind；放 java.put 的字段同时读袋
    expect(ok({ ruleSearch: search({ name: '.t@text@js:var k = "bid"; java.put(k, result); result' }), ruleToc: tocGet })).toBe(false);
    expect(ok({ ruleSearch: search({ kind: '@js:java.put("bid", "1")' }), ruleToc: tocGet })).toBe(false);
    expect(ok({ ruleSearch: search({ name: '.t@text@js:java.put("bid", java.get("cat")); result' }), ruleToc: tocGet }, PUT_URL)).toBe(false);
    // 读求值顺序上更后字段放的键；bookList 读条目键
    expect(ok({ ruleSearch: search({ author: '.a@text@js:result + java.get("u")', bookUrl: 'a@href@put:{u:".n@text"}' }) })).toBe(false);
    expect(ok({ ruleSearch: search({ ...putBid, bookList: '.i@js:java.get("bid"); result' }), ruleToc: tocGet })).toBe(false);
    // 重键（两个条目字段 / 与 searchUrl）；保留键；没人放的键
    expect(ok({ ruleSearch: search({ ...putBid, author: '.a@text@put:{bid:".a@text"}' }), ruleToc: tocGet })).toBe(false);
    expect(ok({ ruleSearch: search({ name: '.t@text@put:{cat:".n@text"}' }), ruleToc: tocWith('{{@@a@href}}?c=@get:{cat}') }, PUT_URL)).toBe(false);
    expect(ok({ ruleSearch: search({ name: '.t@text@put:{bookName:".n@text"}' }), ruleToc: tocWith('{{@@a@href}}?b=@get:{bookName}') })).toBe(false);
    expect(ok({ ruleSearch: putBid, ruleToc: tocWith('{{@@a@href}}?b=@get:{zz}') })).toBe(false);
    // 目录 put；目录列表字段读袋；正文读袋；JS init
    expect(ok({ ruleSearch: putBid, ruleToc: { ...tocGet, chapterName: 'a@text@put:{x:"a@text"}' } })).toBe(false);
    expect(ok({ ruleSearch: putBid, ruleToc: { ...tocGet, chapterList: '.ch@get:{bid}' } })).toBe(false);
    expect(ok({ ruleSearch: putBid, ruleToc: tocGet, ruleContent: { content: '.c@js:result + java.get("bid")' } })).toBe(false);
    expect(ok({ ruleSearch: putBid, ruleBookInfo: { init: '@js:result' }, ruleToc: tocGet })).toBe(false);
    // 只有搜索字段读 searchUrl 的键（归搜索袋）；没有字段读袋
    expect(ok({ ruleSearch: search({ bookUrl: '{{@@a@href}}?c=@get:{cat}' }) }, PUT_URL)).toBe(false);
    expect(ok({ ruleSearch: putBid, ruleToc: tocWith('a@href') })).toBe(false);
    // 搜索组是 AllInOne
    expect(compileItemVars(raw({ ruleSearch: { bookList: ':(\\d+)', name: '$1@put:{bid:"$1"}', bookUrl: '$1' }, ruleToc: tocGet }), {
      aioEnabled: true, jsEnabled: true,
    })).toBeNull();
  });

  it('开关关：读条目袋的字段照旧 skipped；开时挂 itemVars', () => {
    const rules = { ruleSearch: { ...putBid, bookUrl: '{{@@a@href}}?b=@get:{bid}' }, ruleToc: tocGet };
    const off = engine(rules, { ...ON, itemVarsEnabled: false }).compiled;
    expect(off.get('ruleSearch.bookUrl')).toEqual({ skipped: 'unsupported' });
    expect(off.get('ruleToc.chapterUrl')).toEqual({ skipped: 'unsupported' });
    const on = engine(rules).compiled;
    expect(on.get('ruleSearch.name')).toMatchObject({ itemVars: true });
    expect(on.get('ruleSearch.bookUrl')).toMatchObject({ itemVars: true, varGets: true });
    expect(on.get('ruleToc.chapterUrl')).toMatchObject({ itemVars: true, varGets: true });
  });
});

describe('门面逐条建袋', () => {
  it('条目 @put → bookUrl @get，每条各一只袋', async () => {
    const src = engine({ ruleSearch: { ...putBid, bookUrl: '{{@@a@href}}?b=@get:{bid}' } });
    expect(await engineSearchBook(src, '书', context())).toEqual([
      { title: '甲书', author: '', bookUrl: `${SITE}/b/1.html?b=7`, vars: { bid: '7' } },
      { title: '乙书', author: '', bookUrl: `${SITE}/b/2.html?b=8`, vars: { bid: '8' } },
    ]);
  });

  it('kind 的 @put 挪到 bookUrl 前求值；name 的 java.put', async () => {
    await preloadJsSandbox();
    const kind = engine({ ruleSearch: { bookList: '.i', name: '.t@text', kind: '.n@text@put:{bid:".n@text"}', bookUrl: '{{@@a@href}}?b=@get:{bid}' } });
    expect((await engineSearchBook(kind, '书', context())).map((hit) => hit.bookUrl)).toEqual([`${SITE}/b/1.html?b=7`, `${SITE}/b/2.html?b=8`]);
    const java = engine({
      ruleSearch: { bookList: '.i', name: '.t@text@js:java.put("bid", "n" + result.length); result', bookUrl: '{{@@a@href}}?b=@get:{bid}' },
    });
    expect((await engineSearchBook(java, '书', context()))[0]).toMatchObject({ title: '甲书', bookUrl: `${SITE}/b/1.html?b=n2`, vars: { bid: 'n2' } });
  });

  it('搜索 put → 目录 get：袋经详情带到目录；详情不带袋取页前即失败', async () => {
    const src = engine({ ruleSearch: putBid, ruleBookInfo: { name: 'h1@text', tocUrl: '.toc@href' }, ruleToc: tocGet });
    const [hit] = await engineSearchBook(src, '书', context());
    expect(hit).toMatchObject({ bookUrl: BOOK_URL, vars: { bid: '7' } });
    const detail = await engineFetchDetail(src, hit.bookUrl, context(), undefined, hit.vars);
    expect(detail).toMatchObject({ title: '书名', tocUrl: TOC_URL, vars: { bid: '7' } });
    const toc = await engineFetchToc(src, detail.tocUrl!, context(), false, detail.vars);
    expect(toc.chapters.map((c) => c.url)).toEqual([`${SITE}/c/1.html?b=7`, `${SITE}/c/2.html?b=7`]);
    const urls: string[] = [];
    await expect(engineFetchDetail(src, BOOK_URL, context(urls))).rejects.toMatchObject({ name: 'RuleEngineError' });
    expect(urls).toEqual([]);
  });

  it('searchUrl 的 java.put 带到详情字段', async () => {
    await preloadJsSandbox();
    await prepareSearchJs();
    const src = engine({
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleBookInfo: { name: 'h1@text@js:result + "-" + java.get("cat")' },
    }, ON, PUT_URL);
    const [hit] = await engineSearchBook(src, '书', context());
    expect(hit.vars).toEqual({ cat: '7' });
    expect((await engineFetchDetail(src, hit.bookUrl, context(), undefined, hit.vars)).title).toBe('书名-7');
  });

  it('详情放同一键覆盖搜索侧的值（详情不强制带袋）', async () => {
    const src = engine({ ruleSearch: putBid, ruleBookInfo: { name: 'h1@text@put:{bid:"#bid@text"}', tocUrl: '.toc@href' }, ruleToc: tocGet });
    const detail = await engineFetchDetail(src, BOOK_URL, context(), undefined, { bid: '7' });
    expect(detail.vars).toEqual({ bid: '42' });
    expect((await engineFetchDetail(src, BOOK_URL, context())).vars).toEqual({ bid: '42' });
  });

  it('开关关：结果不带 vars，读袋 bookUrl 无结果', async () => {
    const off = { ...ON, itemVarsEnabled: false };
    expect(await engineSearchBook(engine({ ruleSearch: { ...putBid, bookUrl: '{{@@a@href}}?b=@get:{bid}' } }, off), '书', context())).toEqual([]);
    expect((await engineSearchBook(engine({ ruleSearch: putBid, ruleToc: tocWith('a@href') }, ON), '书', context()))[0]).not.toHaveProperty('vars');
  });
});

describe('准入带袋', () => {
  const source = () => ({
    bookSourceUrl: SITE, bookSourceName: '条目袋源', searchUrl: PLAIN_URL, checkKeyWord: '测试关键字',
    ruleSearch: putBid, ruleBookInfo: { name: 'h1@text', tocUrl: '.toc@href' }, ruleToc: tocGet, ruleContent: { content: '.c' },
  } as unknown as RawSource);
  const respond = (body: string) => new Response(`<html><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const routes: Record<string, string> = {
    '/s': SEARCH, '/b/1.html': DETAIL, '/toc/1.html': TOC, '/c/2.html': `<div class="c">${'字'.repeat(800)}</div>`,
  };
  const transport = (paths: string[] = []) => vi.fn<AdmissionTransport>(async (input) => {
    const { pathname, search } = new URL(input);
    paths.push(pathname + search);
    const body = routes[pathname];
    return body === undefined ? new Response('nf', { status: 404 }) : respond(body);
  });
  const options = (fetchPage: AdmissionTransport) => ({
    fetchPage, declaredHosts: new Set(['book15.net']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('compileAdmission：开关开时读条目袋的目录字段可解释，关时照旧拒', () => {
    expect(compileAdmission(source()).ok).toBe(true);
    process.env.ENGINE_SYNTAX_ITEM_VARS = '0';
    const off = compileAdmission(source());
    expect(off.ok).toBe(false);
    expect(off.reason).toContain('ruleToc.chapterUrl');
  });

  it('搜索腿样本带袋，影子腿以它为初值读目录', async () => {
    const search = await searchAdmission(source(), { ...options(transport()), sampleBook: true });
    expect(search).toMatchObject({ verdict: 'ok', candidateCount: 2, sample: { title: '甲书', vars: { bid: '7' } } });
    const paths: string[] = [];
    const result = await readabilityShadow(source(), search.sample!, options(transport(paths)));
    expect(result).toEqual({ verdict: 'readable', chapters: 2, chars: 800, error: '' });
    expect(paths).toEqual(['/b/1.html', '/toc/1.html', '/c/2.html?b=7']);
  });

  it('影子腿：样本没带袋即 eval_error，不发请求', async () => {
    const paths: string[] = [];
    const result = await readabilityShadow(source(), { url: '/b/1.html', pageUrl: `${SITE}/s?q=x` }, options(transport(paths)));
    expect(result).toMatchObject({ verdict: 'eval_error', chapters: 0, chars: 0 });
    expect(result.error.startsWith('detail:')).toBe(true);
    expect(paths).toEqual([]);
  });
});
