// book1028：ENGINE_SYNTAX_BOOK_FIELDS —— JS 读 legado `book` 的书籍成员（name/author/bookUrl/tocUrl，按阶段递增）：编译期成员集与
// Java String 用法拒收、canReName 源整源不开、运行期缺成员即失败、门面 搜索 → 详情 → 目录 传递、准入影子腿带 book、语义版本位、
// legado formatBookName/formatBookAuthor 口径。正文两字段自 bookcontent1029 起同目录（见 bookcontent.test.ts）。规则与页面均为合成形态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { readabilityShadow, searchAdmission, type AdmissionTransport } from './admission';
import { engineFetchDetail, engineFetchToc, engineSearchBook, type EngineSource } from './api';
import { bookUrlMember, bookView, formatBookAuthor, formatBookName } from './book-format';
import { compileSource, engineSourceRevision, sourceUsesBookSyntax } from './compile';
import type { RawSource } from './compile-smoke';
import {
  compiledUsesBook, createScope, evaluateField, evaluateFieldList, normalizeBody, withBook, type EvalScope, type ScopeHost,
} from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_BOOK_FIELDS_BIT, engineSemanticsVersion, engineSyntaxBookFieldsEnabled } from './syntax-flags';
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
const ON = { jsEnabled: true, jsBindEnabled: true, bookFieldsEnabled: true } as const;
const OFF = { jsEnabled: true, jsBindEnabled: true, bookFieldsEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...OFF, ...extra, field });
const scopeOf = (text: string, host?: ScopeHost): EvalScope => {
  const scope = createScope(normalizeBody(text), PAGE_URL);
  if (host) scope.host = host;
  return scope;
};
const value = (field: FieldIr, text: string, host?: ScopeHost) => evaluateField(field, scopeOf(text, host));
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const TOC_URL_FIELD = 'ruleBookInfo.tocUrl';
const tocReadsName = { tocUrl: '.toc@href@js:result + "?n=" + String(book.name).length' };

/** 环境开关：保存 → 设置 → 恢复（pageScope / readabilityShadow 读 env）。 */
function withEnv(values: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [key, next] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = next;
    }
  });
  afterEach(() => {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

describe('开关与语义版本', () => {
  it('engineSyntaxBookFieldsEnabled 严格口径', () => {
    expect(engineSyntaxBookFieldsEnabled({})).toBe(false);
    expect(engineSyntaxBookFieldsEnabled({ ENGINE_SYNTAX_BOOK_FIELDS: '0' })).toBe(false);
    expect(engineSyntaxBookFieldsEnabled({ ENGINE_SYNTAX_BOOK_FIELDS: 'yes' })).toBe(false);
    expect(engineSyntaxBookFieldsEnabled({ ENGINE_SYNTAX_BOOK_FIELDS: ' On ' })).toBe(true);
    expect(engineSyntaxBookFieldsEnabled({ ENGINE_SYNTAX_BOOK_FIELDS: 'TRUE' })).toBe(true);
    expect(engineSyntaxBookFieldsEnabled({ ENGINE_SYNTAX_BOOK_FIELDS: '1' })).toBe(true);
  });

  it('书籍成员位 +8388608，此前各位逐字不变', () => {
    expect(ENGINE_SEMANTICS_BOOK_FIELDS_BIT).toBe(8388608);
    const all = Array.from({ length: 22 }, () => true) as boolean[];
    const none = Array.from({ length: 22 }, () => false) as boolean[];
    const call = (...args: boolean[]) => (engineSemanticsVersion as (...a: boolean[]) => number)(...args);
    expect(call(...all, false)).toBe(call(...all));
    expect(call(...all, true)).toBe(call(...all) + 8388608);
    expect(call(...none, true)).toBe(call(false) + 8388608);
  });

  it('按源判定：只有 off 拒、on 过且读到书籍成员的字段所在源换版本', () => {
    const rev = (s: ReturnType<typeof raw>, bookFieldsEnabled: boolean, jsBindEnabled = true) =>
      engineSourceRevision(s, { jsEnabled: true, jsBindEnabled, bookFieldsEnabled, jsoupEnabled: false });
    const readName = raw({ ruleBookInfo: tocReadsName });
    const tocMember = raw({ ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href@js:result + "?t=" + String(book.tocUrl).length' } });
    const originOnly = raw({ ruleContent: { content: '#c@text@js:result + book.origin' } });
    const contentName = raw({ ruleContent: { content: '#c@text@js:result + book.name' } });
    const reName = raw({ ruleBookInfo: { ...tocReadsName, canReName: '1' } });
    const withLib = raw({ ruleBookInfo: tocReadsName, jsLib: 'function f(){}' });
    for (const s of [readName, tocMember, contentName]) {
      expect(rev(s, true)).not.toBe(rev(s, false));
      expect(rev(s, true, false)).toBe(rev(s, false, false));
    }
    for (const s of [originOnly, reName, withLib]) expect(rev(s, true)).toBe(rev(s, false));
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsGetEnabled: false, jsUtilEnabled: false, jsonPathEnabled: false,
      initJsEnabled: false, jsoupEnabled: false,
    };
    for (const s of [readName, tocMember, contentName]) expect(sourceUsesBookSyntax(s.rules, flags)).toBe(true);
    for (const s of [originOnly, reName, withLib]) expect(sourceUsesBookSyntax(s.rules, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译并标成员；canReName 源与宿主绑定关时不开；两态缓存互不污染', () => {
    const compiled = (bookFieldsEnabled: boolean, rules: Record<string, unknown> = { ruleBookInfo: tocReadsName }, jsBindEnabled = true) =>
      compileSource(raw(rules), { jsEnabled: true, jsBindEnabled, bookFieldsEnabled });
    expect(compiled(false).get(TOC_URL_FIELD)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true).get(TOC_URL_FIELD)).toMatchObject({ bookMembers: ['name'] });
    expect(compiledUsesBook(compiled(true))).toBe(true);
    expect(compiled(false).get(TOC_URL_FIELD)).toEqual({ skipped: 'unsupported' });
    expect(compiledUsesBook(compiled(false))).toBe(false);
    expect(compiled(true, { ruleBookInfo: { ...tocReadsName, canReName: '1' } }).get(TOC_URL_FIELD)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true, { ruleBookInfo: tocReadsName }, false).get(TOC_URL_FIELD)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse：阶段成员', () => {
  it('搜索条目按 legado getSearchItem 顺序：author 见 name，bookUrl 见 name/author；name 与列表不开', () => {
    expect(codeOf(() => on('@js:book.name', 'ruleSearch.name'))).toBe('unsupported_js');
    expect(codeOf(() => on('.a@text@js:result + book.author', 'ruleSearch.author'))).toBe('unsupported_js');
    expect(on('.a@text@js:result + book.name', 'ruleSearch.author').bookMembers).toEqual(['name']);
    expect(on('a@href@js:result + book.name + book.author', 'ruleSearch.bookUrl').bookMembers).toEqual(['author', 'name']);
    expect(codeOf(() => on('a@href@js:result + book.bookUrl', 'ruleSearch.bookUrl'))).toBe('unsupported_js');
    expect(codeOf(() => on('@js:[book.name]', 'ruleSearch.bookList', { listJsEnabled: true, listJsGroup: true }))).toBe('unsupported_js');
  });

  it('详情见 name/author/bookUrl；目录（含 chapterName 与列表）另见 tocUrl；正文同目录（bookcontent1029）', () => {
    expect(on('@js:book.author', 'ruleBookInfo.author').bookMembers).toEqual(['author']);
    expect(on('.toc@href@js:result + book.bookUrl', TOC_URL_FIELD).bookMembers).toEqual(['bookUrl']);
    expect(codeOf(() => on('.toc@href@js:result + book.tocUrl', TOC_URL_FIELD))).toBe('unsupported_js');
    expect(on('a@href@js:result + book.tocUrl', 'ruleToc.chapterUrl').bookMembers).toEqual(['tocUrl']);
    expect(on('a@text@js:book.name + result', 'ruleToc.chapterName').bookMembers).toEqual(['name']);
    expect(on('@js:[book.name]', 'ruleToc.chapterList', { listJsEnabled: true, listJsGroup: true }).bookMembers).toEqual(['name']);
    expect(on('#c@text@js:result + book.name', 'ruleContent.content').bookMembers).toEqual(['name']);
    expect(codeOf(() => on('#c@text@js:result + book.kind', 'ruleContent.content'))).toBe('unsupported_js');
    expect(codeOf(() => on('a@href@js:result + book.kind', 'ruleToc.chapterUrl'))).toBe('unsupported_js');
  });

  it('off 态、宿主绑定关、JS 关照旧拒', () => {
    expect(codeOf(() => off('.toc@href@js:result + book.name', TOC_URL_FIELD))).toBe('unsupported_js');
    expect(codeOf(() => on('.toc@href@js:result + book.name', TOC_URL_FIELD, { jsBindEnabled: false }))).toBe('unsupported_js');
    expect(codeOf(() => on('.toc@href@js:result + book.name', TOC_URL_FIELD, { jsEnabled: false }))).toBeDefined();
  });

  it('只读到 book.origin 不算增量：off 态能编的逐字不变，靠帧换绑才过的照旧拒', () => {
    expect(on('a@href@js:book.origin + result', 'ruleSearch.bookUrl')).toEqual(off('a@href@js:book.origin + result', 'ruleSearch.bookUrl'));
    expect(on('a@href@js:book.origin + result', 'ruleSearch.bookUrl').bookMembers).toBeUndefined();
    expect(codeOf(() => on('a@text@js:result + book.origin', 'ruleToc.chapterName'))).toBe('unsupported_js');
    // 字符串里的 book.name 不是成员读
    expect(on('a@href@js:"book.name" + result', 'ruleSearch.bookUrl').bookMembers).toBeUndefined();
  });

  it('Java String 当 JS 字符串用的形态拒；String() 之后、拼接、== 照收', () => {
    const toc = (expr: string) => codeOf(() => on(`.toc@href@js:${expr}`, TOC_URL_FIELD));
    for (const expr of ['book.name.length', 'book.name.replace(/a/g, "")', 'book.name[0]', 'book.name?.length', 'typeof book.name',
      'book.name === "x"', 'book.name !== "x"', '"x" === book.name', 'book.name instanceof String', 'delete book.name',
      'book.name = "x"', 'book.name += "x"', 'book', 'book["name"]']) {
      expect(toc(expr), expr).toBe('unsupported_js');
    }
    for (const expr of ['String(book.name).length', 'result + book.name', 'book.name == "x" ? result : ""', '(book.name) + result']) {
      expect(toc(expr), expr).toBeUndefined();
    }
  });
});

describe('求值', () => {
  it('作用域带齐成员才求值；缺成员、空串、没带 book 一律失败', async () => {
    await preloadJsSandbox();
    const field = on('.toc@href@js:result + "?n=" + book.name + "&a=" + book.author', TOC_URL_FIELD);
    const html = '<a class="toc" href="/toc/1.html">目录</a>';
    expect(value(field, html, { origin: SITE, book: { name: '甲', author: '乙' } })).toBe(`${SITE}/toc/1.html?n=甲&a=乙`);
    expect(codeOf(() => value(field, html, { origin: SITE, book: { name: '甲' } }))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => value(field, html, { origin: SITE, book: { name: '甲', author: '' } }))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => value(field, html, { origin: SITE }))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => value(field, html))).toBe('RULE_EVAL_FAILED');
  });

  it('book.origin 与成员同在一个对象上；withBook 不改原作用域', async () => {
    await preloadJsSandbox();
    const field = on('#c@text@js:book.origin + "|" + book.bookUrl', TOC_URL_FIELD);
    const page = scopeOf('<div id="c">x</div>', { origin: SITE });
    const withMembers = withBook(page, { bookUrl: `${SITE}/b/1.html` });
    expect(evaluateField(field, withMembers)).toBe(`${SITE}|${SITE}/b/1.html`);
    expect(page.host).toEqual({ origin: SITE });
    expect(withBook(page, undefined)).toBe(page);
  });

  it('目录列表 JS 读 book；列表条目沿用页面的 book', async () => {
    await preloadJsSandbox();
    // 字符串条目按 HTML 重新解析（对象条目上 legado 只取键、不跑 JS，这里不用）
    const list = on('@js:["<b>" + book.name + "1</b>", "<b>" + book.name + "2</b>"]', 'ruleToc.chapterList',
      { listJsEnabled: true, listJsGroup: true });
    const name = on('b@text@js:result + "|" + book.tocUrl', 'ruleToc.chapterName');
    const page = scopeOf('<p>x</p>', { origin: SITE, book: { name: '书', tocUrl: `${SITE}/toc` } });
    expect(evaluateFieldList(list, page).map((item) => evaluateField(name, item))).toEqual([`书1|${SITE}/toc`, `书2|${SITE}/toc`]);
    expect(codeOf(() => evaluateFieldList(list, scopeOf('<p>x</p>', { origin: SITE })))).toBe('RULE_EVAL_FAILED');
  });
});

describe('legado 书名/作者格式化', () => {
  it('formatBookName：去「 作者…」「 某某 著」尾巴；Java \\s 只含 ASCII 空白，. 不过行尾', () => {
    expect(formatBookName('斗破苍穹 作者：天蚕土豆')).toBe('斗破苍穹');
    expect(formatBookName('斗破苍穹 天蚕土豆 著')).toBe('斗破苍穹');
    expect(formatBookName('  斗破苍穹  ')).toBe('斗破苍穹');
    expect(formatBookName('作者：天蚕土豆')).toBe('作者：天蚕土豆');
    expect(formatBookName('甲 作者乙\n丙')).toBe('甲\n丙');
    expect(formatBookName('斗破苍穹　作者：天蚕土豆')).toBe('斗破苍穹　作者：天蚕土豆');
    expect(formatBookName(' 作者')).toBe('');
  });

  it('formatBookAuthor：去开头「作者：」与「 著」；两端只去码点 ≤ U+0020', () => {
    expect(formatBookAuthor('作者：天蚕土豆')).toBe('天蚕土豆');
    expect(formatBookAuthor(' 作 者 : 天蚕土豆 著')).toBe('天蚕土豆');
    expect(formatBookAuthor('天蚕土豆')).toBe('天蚕土豆');
    expect(formatBookAuthor('作者')).toBe('作者');
    expect(formatBookAuthor('　天蚕土豆　')).toBe('　天蚕土豆　');
  });

  it('bookUrlMember：剥过选项后缀或过不了门的不进成员；bookView 丢空值', () => {
    const ir = { urlOptions: true } as unknown as FieldIr;
    expect(bookUrlMember(`${SITE}/b/1.html`, `${SITE}/b/1.html`, ir)).toBe(`${SITE}/b/1.html`);
    expect(bookUrlMember(`${SITE}/b/1.html,{"method":"GET"}`, `${SITE}/b/1.html`, ir)).toBeUndefined();
    expect(bookUrlMember(`${SITE}/b/1.html,{"method":"GET"}`, `${SITE}/b/1.html,{"method":"GET"}`, undefined)).toBe(`${SITE}/b/1.html,{"method":"GET"}`);
    expect(bookUrlMember(`${SITE}/b/1.html`, undefined, ir)).toBeUndefined();
    expect(bookView({ name: '甲', author: '', bookUrl: undefined })).toEqual({ name: '甲' });
  });
});

const context = (pages: Record<string, string>): SourceRequestContext => ({
  page: async (url: string) => {
    const text = pages[new URL(url).pathname];
    if (text === undefined) throw new Error('Unexpected request: ' + url);
    return { url, text };
  },
} as unknown as SourceRequestContext);

describe('门面：搜索 → 详情 → 目录', () => {
  withEnv({ ENGINE_SYNTAX_JS_BIND: '1' });
  const SEARCH = '<div class="item"><span class="t">斗破苍穹 作者：天蚕土豆</span><span class="a">作者：天蚕土豆 著</span><a href="/b/1.html">x</a></div>'
    + '<div class="item"><span class="t">凡人修仙传 忘语 著</span><span class="a">无名</span><a href="/b/2.html">x</a></div>'
    + '<div class="item"><span class="t"> </span><span class="a">空名</span><a href="/b/3.html">x</a></div>';
  const search = {
    bookList: '.item', name: '.t@text', author: '.a@text@js:result + "/" + book.name',
    bookUrl: 'a@href@js:result + "?n=" + String(book.name).length + "&a=" + String(book.author).length',
  };
  const chapterName = 'a@text@js:result + "|" + book.name + "|" + book.author + "|" + book.bookUrl + "|" + book.tocUrl';
  const rules = {
    ruleSearch: search, ruleBookInfo: { name: 'h1@text', author: '@js:book.author', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.ch', chapterName, chapterUrl: 'a@href' },
  };
  const pages = {
    '/s': SEARCH,
    '/b/1.html': '<h1>斗破苍穹</h1><a class="toc" href="/toc/1.html">目录</a>',
    '/toc/1.html': '<li class="ch"><a href="/c/1.html">第1章</a></li>',
  };
  const engine = (r: Record<string, unknown>, options: Record<string, boolean> = ON): EngineSource => ({
    url: SITE, name: '书籍成员源', searchUrl: `${SITE}/s?q={{key}}`, compiled: compileSource(raw(r), options),
  });
  const BOOK_URL = `${SITE}/b/1.html?n=4&a=9`;

  it('搜索按 legado 顺序格式化（名为空丢条），成员一路带到目录', async () => {
    const src = engine(rules);
    const results = await engineSearchBook(src, '斗破苍穹', context(pages));
    const second = `${SITE}/b/2.html?n=5&a=8`;
    expect(results).toEqual([{
      title: '斗破苍穹', author: '天蚕土豆/斗破苍穹', bookUrl: BOOK_URL,
      book: { name: '斗破苍穹', author: '天蚕土豆/斗破苍穹', bookUrl: BOOK_URL },
    }, {
      title: '凡人修仙传', author: '无名/凡人修仙传', bookUrl: second, book: { name: '凡人修仙传', author: '无名/凡人修仙传', bookUrl: second },
    }]);
    const detail = await engineFetchDetail(src, results[0].bookUrl, context(pages), results[0].book);
    expect(detail).toMatchObject({ title: '斗破苍穹', author: '天蚕土豆/斗破苍穹', tocUrl: `${SITE}/toc/1.html` });
    expect(detail.book).toEqual({ ...results[0].book, tocUrl: `${SITE}/toc/1.html` });
    const toc = await engineFetchToc(src, detail.tocUrl!, context(pages), false, detail.vars, detail.book);
    expect(toc.chapters.map((c) => c.title)).toEqual([`第1章|斗破苍穹|天蚕土豆/斗破苍穹|${BOOK_URL}|${SITE}/toc/1.html`]);
    // 不传 book（确认路径）：读成员的字段求值失败，不猜值
    await expect(engineFetchDetail(src, results[0].bookUrl, context(pages))).rejects.toThrow(RuleEngineError);
    await expect(engineFetchToc(src, detail.tocUrl!, context(pages), false, detail.vars)).rejects.toThrow(RuleEngineError);
  });

  it('不读成员的源逐字走旧路径（不格式化、不带 book）', async () => {
    const plain = { ...search, name: '.t@text', author: '.a@text', bookUrl: 'a@href' };
    const results = await engineSearchBook(engine({ ruleSearch: plain }), '斗破苍穹', context(pages));
    expect(results).toEqual([
      { title: '斗破苍穹 作者：天蚕土豆', author: '作者：天蚕土豆 著', bookUrl: `${SITE}/b/1.html` },
      { title: '凡人修仙传 忘语 著', author: '无名', bookUrl: `${SITE}/b/2.html` },
    ]);
    // 开关关：读成员的字段 skipped，同样不格式化
    const offResults = await engineSearchBook(engine(rules, OFF), '斗破苍穹', context(pages));
    expect(offResults.every((r) => r.book === undefined)).toBe(true);
  });

  it('tocUrl 为空时目录成员取 bookUrl；带选项后缀的 bookUrl 不进成员', async () => {
    const src = engine({ ...rules, ruleBookInfo: { name: 'h1@text' } });
    const book = { name: '斗破苍穹', author: '天蚕土豆', bookUrl: `${SITE}/b/1.html` };
    const detail = await engineFetchDetail(src, `${SITE}/b/1.html`, context(pages), book);
    expect(detail.tocUrl).toBeUndefined();
    expect(detail.book).toEqual({ ...book, tocUrl: `${SITE}/b/1.html` });
    const suffixed = engine({ ruleSearch: { ...search, bookUrl: `a@href@js:result + "?n=" + String(book.name).length + ',{"method":"GET"}'` } },
      { ...ON, urlOptionsEnabled: true });
    const results = await engineSearchBook(suffixed, '斗破苍穹', context(pages));
    expect(results).toEqual([{
      title: '斗破苍穹', author: '天蚕土豆/斗破苍穹', bookUrl: `${SITE}/b/1.html?n=4`,
      book: { name: '斗破苍穹', author: '天蚕土豆/斗破苍穹' },
    }, {
      title: '凡人修仙传', author: '无名/凡人修仙传', bookUrl: `${SITE}/b/2.html?n=5`, book: { name: '凡人修仙传', author: '无名/凡人修仙传' },
    }]);
  });
});

describe('准入影子腿带 book', () => {
  withEnv({ ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JS_BIND: '1', ENGINE_SYNTAX_BOOK_FIELDS: '1' });
  const HOST = 'rd.example.com';
  const BASE = `https://${HOST}`;
  const html = (body: string, status = 200) =>
    new Response(`<html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  function site(routes: Record<string, string>) {
    const paths: string[] = [];
    const fetchPage = vi.fn<AdmissionTransport>(async (input) => {
      const { pathname, search } = new URL(input);
      paths.push(pathname + search);
      const body = routes[pathname];
      return body === undefined ? html('nf', 404) : html(body);
    });
    return { fetchPage, paths };
  }
  const options = (fetchPage: AdmissionTransport) => ({ fetchPage, declaredHosts: new Set([HOST]), signal: new AbortController().signal, throttleMs: 0 });
  const source = (over: Record<string, unknown> = {}) => ({
    bookSourceUrl: BASE, bookSourceName: '合成源', searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: '.t@text', author: '.a@text', bookUrl: 'a@href' },
    ruleBookInfo: { tocUrl: '.tocl@href@js:result + "?u=" + String(book.bookUrl).length' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href@js:result + "?n=" + String(book.name).length + "&t=" + String(book.tocUrl).length' },
    ruleContent: { content: '.c' },
    ...over,
  }) as unknown as RawSource;
  const SEARCH = '<div class="i"><span class="t">别的书</span><span class="a">某</span><a href="/b/9">x</a></div>'
    + '<div class="i"><span class="t">斗破苍穹 作者：天蚕土豆</span><span class="a">作者：天蚕土豆</span><a href="/b/1">x</a></div>';
  const toc = (n: number) => `<ul class="toc">${Array.from({ length: n }, (_, i) => `<li><a href="${BASE}/c/${i}">第${i + 1}章</a></li>`).join('')}</ul>`;
  const routes = {
    '/s': SEARCH,
    '/b/1': '<a class="tocl" href="/b/1/toc">目录</a>',
    '/b/1/toc': toc(4),
    '/c/2': `<div class="c">${'字'.repeat(800)}</div>`,
  };

  it('只有详情/目录读成员时，搜索样本也按 legado 格式化并带 book', async () => {
    await preloadJsSandbox();
    const stub = site(routes);
    const result = await searchAdmission(source(), { ...options(stub.fetchPage), sampleBook: true });
    expect(result.sample).toEqual({
      title: '斗破苍穹', url: `${BASE}/b/1`, pageUrl: expect.stringContaining(`${BASE}/s?q=`),
      book: { name: '斗破苍穹', author: '天蚕土豆', bookUrl: `${BASE}/b/1` },
    });
  });

  it('readabilityShadow：详情带 bookUrl（过门后），目录另带 tocUrl', async () => {
    await preloadJsSandbox();
    const stub = site(routes);
    const book = { name: '斗破苍穹', author: '天蚕土豆', bookUrl: '/b/1' };
    const result = await readabilityShadow(source(), { url: '/b/1', pageUrl: `${BASE}/s?q=x`, book }, options(stub.fetchPage));
    expect(result).toEqual({ verdict: 'readable', chapters: 4, chars: 800, error: '' });
    const tocUrl = `${BASE}/b/1/toc?u=${`${BASE}/b/1`.length}`;
    expect(stub.paths).toEqual(['/b/1', `/b/1/toc?u=${`${BASE}/b/1`.length}`, `/c/2?n=4&t=${tocUrl.length}`]);
  });

  it('样本没带 book：读成员的字段求值失败，不算可读', async () => {
    await preloadJsSandbox();
    const stub = site(routes);
    const result = await readabilityShadow(source(), { url: '/b/1', pageUrl: `${BASE}/s?q=x` }, options(stub.fetchPage));
    expect(result.verdict).not.toBe('readable');
    expect(result.error).toContain('book.bookUrl');
  });

  it('开关关：样本形状逐字不变（不带 book、不格式化）', async () => {
    process.env.ENGINE_SYNTAX_BOOK_FIELDS = '0';
    const stub = site(routes);
    const result = await searchAdmission(source({ ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' } }),
      { ...options(stub.fetchPage), sampleBook: true });
    expect(result.sample).toEqual({ title: '斗破苍穹 作者：天蚕土豆', url: `${BASE}/b/1`, pageUrl: expect.stringContaining(`${BASE}/s?q=`) });
  });
});
