// varbag1028：ENGINE_SYNTAX_VARS_BAG —— 详情页 put（`@put:{…}` / 字面量键 `java.put`）→ 目录页 get（`@get:{k}` makeUp /
// `java.get('k')`）的本书变量袋：编译期子集判定、门面带袋、准入影子腿、语义版本位。规则均为合成形态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { readabilityShadow, type AdmissionTransport } from './admission';
import { engineFetchDetail, engineFetchToc, type EngineSource } from './api';
import { compileSource, compileVarBag, engineSourceRevision } from './compile';
import type { RawSource } from './compile-smoke';
import { preloadJsSandbox } from './js-sandbox';
import { ENGINE_SEMANTICS_VAR_BAG_BIT, engineSemanticsVersion, engineSyntaxVarsBagEnabled } from './syntax-flags';

const SITE = 'https://book15.net';
const BOOK_URL = `${SITE}/b/1.html`;
const TOC_URL = `${SITE}/toc/1.html`;
const ON = { varsEnabled: true, varBagEnabled: true, jsEnabled: true, jsBindEnabled: true } as const;
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const engine = (rules: Record<string, unknown>, options: Record<string, boolean> = ON): EngineSource => ({
  url: SITE, name: '袋源', searchUrl: `${SITE}/s?q={{key}}`, compiled: compileSource(raw(rules), options),
});
const context = (pages: Map<string, string>): SourceRequestContext => ({
  page: async (url: string) => {
    const text = pages.get(url);
    if (text === undefined) throw new Error('Unexpected request: ' + url);
    return { url, text };
  },
} as unknown as SourceRequestContext);

const DETAIL = '<h1>书名</h1><span id="bid">42</span><a class="toc" href="/toc/1.html">目录</a>';
const TOC = '<li class="ch"><a href="/c/1.html">第1章</a></li><li class="ch"><a href="/c/2.html">第2章</a></li>';
const putName = { name: 'h1@text@put:{bid:"#bid@text"}', tocUrl: '.toc@href' };
const tocWith = (chapterUrl: string) => ({ chapterList: '.ch', chapterName: 'a@text', chapterUrl });

async function fetchBook(src: EngineSource, pages: Map<string, string>) {
  const detail = await engineFetchDetail(src, BOOK_URL, context(pages));
  const toc = await engineFetchToc(src, detail.tocUrl ?? BOOK_URL, context(pages), false, detail.vars);
  return { detail, urls: toc.chapters.map((c) => c.url) };
}

describe('开关与语义版本', () => {
  it('engineSyntaxVarsBagEnabled 严格口径', () => {
    expect(engineSyntaxVarsBagEnabled({})).toBe(false);
    expect(engineSyntaxVarsBagEnabled({ ENGINE_SYNTAX_VARS_BAG: '0' })).toBe(false);
    expect(engineSyntaxVarsBagEnabled({ ENGINE_SYNTAX_VARS_BAG: 'yes' })).toBe(false);
    expect(engineSyntaxVarsBagEnabled({ ENGINE_SYNTAX_VARS_BAG: ' On ' })).toBe(true);
    expect(engineSyntaxVarsBagEnabled({ ENGINE_SYNTAX_VARS_BAG: '1' })).toBe(true);
  });

  it('变量袋位 +2097152，低位逐字不变', () => {
    expect(ENGINE_SEMANTICS_VAR_BAG_BIT).toBe(2097152);
    const version = engineSemanticsVersion as (...flags: boolean[]) => number;
    const all = Array.from({ length: 20 }, () => true);
    const none = Array.from({ length: 20 }, () => false);
    expect(version(...all, false)).toBe(version(...all));
    expect(version(...all, true)).toBe(version(...all) + 2097152);
    expect(version(...none, true)).toBe(version(false) + 2097152);
  });

  it('按源判定：只有袋生效的源换版本，且要 ENGINE_SYNTAX_VARS 同开', () => {
    const opts = (varBagEnabled: boolean, varsEnabled = true) => ({ varsEnabled, varBagEnabled, jsEnabled: true });
    const bag = raw({ ruleBookInfo: putName, ruleToc: tocWith('a@href@js:result + "?b=" + java.get("bid")') });
    const plain = raw({ ruleBookInfo: { name: 'h1@text' }, ruleToc: tocWith('a@href') });
    const orphan = raw({ ruleBookInfo: { name: 'h1@text' }, ruleToc: tocWith('a@href@js:result + java.get("bid")') });
    expect(engineSourceRevision(bag, opts(true))).not.toBe(engineSourceRevision(bag, opts(false)));
    expect(engineSourceRevision(bag, opts(true, false))).toBe(engineSourceRevision(bag, opts(false, false)));
    for (const s of [plain, orphan]) expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
  });
});

describe('编译期子集', () => {
  const ok = (info: Record<string, unknown>, toc: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    compileVarBag({ ruleBookInfo: info, ruleToc: toc, ...extra }, { jsEnabled: true, jsBindEnabled: true }) !== null;
  const get = tocWith('a@href@js:result + java.get("bid")');

  it('详情 @put → 目录 java.get / @get 可解释', () => {
    expect(ok(putName, get)).toBe(true);
    expect(ok(putName, tocWith('{{@@a@href}}?b=@get:{bid}'))).toBe(true);
    expect(ok({ name: 'h1@text', tocUrl: '@js:java.put("bid", "1"); "/toc/1.html"' }, get)).toBe(true);
  });

  it('子集外一律 null', () => {
    // 动态键
    expect(ok({ name: 'h1@text', tocUrl: '@js:var k = "bid"; java.put(k, "1"); "/t"' }, get)).toBe(false);
    expect(ok(putName, tocWith('a@href@js:var k = "bid"; result + java.get(k)'))).toBe(false);
    // 内置键 / 没人 put 的键 / 两个字段放同一键 / 同字段 @put 与 java.put 重键
    expect(ok({ name: 'h1@text@put:{bookName:"h1@text"}' }, tocWith('{{@@a@href}}?b=@get:{bookName}'))).toBe(false);
    expect(ok(putName, tocWith('a@href@js:result + java.get("zz")'))).toBe(false);
    expect(ok({ ...putName, author: '.a@text@put:{bid:".a@text"}' }, get)).toBe(false);
    expect(ok({ name: 'h1@text@put:{bid:"#bid@text"}@js:java.put("bid", result)' }, get)).toBe(false);
    // put 在目录 / 搜索 / 正文；get 在详情；get 在目录列表字段；搜索 URL 读袋
    expect(ok(putName, { ...get, chapterName: 'a@text@put:{x:"a@text"}' })).toBe(false);
    expect(ok({ ...putName, author: '@js:java.get("bid")' }, get)).toBe(false);
    expect(ok(putName, { ...get, chapterList: '.ch@get:{bid}' })).toBe(false);
    expect(ok(putName, get, { searchUrl: `${SITE}/s?q={{key}}&b=@get:{bid}` })).toBe(false);
    // JS init；没有字段读袋；`@get:` 不是 `{…}` 形态
    expect(ok({ ...putName, init: '@js:result' }, get)).toBe(false);
    expect(ok(putName, tocWith('a@href'))).toBe(false);
    expect(ok(putName, tocWith('a@href##@get:bid'))).toBe(false);
  });

  it('开关关：目录读袋字段照旧 skipped', () => {
    const rules = { ruleBookInfo: putName, ruleToc: tocWith('a@href@js:result + java.get("bid")') };
    expect(engine(rules, { ...ON, varBagEnabled: false }).compiled.get('ruleToc.chapterUrl')).toEqual({ skipped: 'unsupported' });
    expect(engine(rules).compiled.get('ruleToc.chapterUrl')).toMatchObject({ varGets: true });
  });
});

describe('门面带袋', () => {
  const pages = new Map([[BOOK_URL, DETAIL], [TOC_URL, TOC]]);

  it('@put 名字段 → 目录 JS java.get', async () => {
    await preloadJsSandbox();
    const { detail, urls } = await fetchBook(engine({ ruleBookInfo: putName, ruleToc: tocWith('a@href@js:result + "?b=" + java.get("bid")') }), pages);
    expect(detail).toMatchObject({ title: '书名', tocUrl: TOC_URL, vars: { bid: '42' } });
    expect(urls).toEqual([`${SITE}/c/1.html?b=42`, `${SITE}/c/2.html?b=42`]);
  });

  it('@get makeUp 与 {{规则}} 混排（不要求宿主绑定开）', async () => {
    const src = engine({ ruleBookInfo: putName, ruleToc: tocWith('{{@@a@href}}?b=@GET:{bid}') }, { ...ON, jsBindEnabled: false });
    expect((await fetchBook(src, pages)).urls).toEqual([`${SITE}/c/1.html?b=42`, `${SITE}/c/2.html?b=42`]);
  });

  it('tocUrl 的 <js> 里 java.put，返回值照常是目录地址', async () => {
    await preloadJsSandbox();
    const src = engine({
      ruleBookInfo: { name: 'h1@text', tocUrl: '<js>java.put("tid", "7"); "/toc/1.html"</js>' },
      ruleToc: tocWith('a@href@js:result + "?t=" + java.get("tid")'),
    });
    const { detail, urls } = await fetchBook(src, pages);
    expect(detail.vars).toEqual({ tid: '7' });
    expect(urls[0]).toBe(`${SITE}/c/1.html?t=7`);
  });

  it('tocUrl 的 {{java.put()}} makeUp 拼回值', async () => {
    await preloadJsSandbox();
    const src = engine({
      ruleBookInfo: { name: 'h1@text', tocUrl: '/toc/{{java.put("n", "1")}}.html' },
      ruleToc: tocWith('{{@@a@href}}?n=@get:{n}'),
    });
    const { detail, urls } = await fetchBook(src, pages);
    expect(detail).toMatchObject({ tocUrl: TOC_URL, vars: { n: '1' } });
    expect(urls[1]).toBe(`${SITE}/c/2.html?n=1`);
  });

  it('JSON 目录：{{$.id}} 与 @get 同一条', async () => {
    const json = new Map([[BOOK_URL, DETAIL], [TOC_URL, JSON.stringify({ list: [{ n: '第1章', id: 'a' }, { n: '第2章', id: 'b' }] })]]);
    const src = engine({
      ruleBookInfo: putName,
      ruleToc: { chapterList: '$.list[*]', chapterName: '$.n', chapterUrl: '/c/{{$.id}}.html?b=@get:{bid}' },
    });
    expect((await fetchBook(src, json)).urls).toEqual([`${SITE}/c/a.html?b=42`, `${SITE}/c/b.html?b=42`]);
  });

  it('非袋源详情不带 vars；袋源目录不传袋即求值失败', async () => {
    expect(await engineFetchDetail(engine({ ruleBookInfo: { name: 'h1@text' } }), BOOK_URL, context(pages))).not.toHaveProperty('vars');
    const src = engine({ ruleBookInfo: putName, ruleToc: tocWith('{{@@a@href}}?b=@get:{bid}') });
    await expect(engineFetchToc(src, TOC_URL, context(pages))).rejects.toMatchObject({ name: 'RuleEngineError' });
  });

  it('袋是副本：目录求值不回写详情结果', async () => {
    await preloadJsSandbox();
    const src = engine({ ruleBookInfo: putName, ruleToc: tocWith('a@href@js:result + java.get("bid")') });
    const detail = await engineFetchDetail(src, BOOK_URL, context(pages));
    const vars = detail.vars!;
    await engineFetchToc(src, TOC_URL, context(pages), false, vars);
    expect(vars).toEqual({ bid: '42' });
  });
});

describe('准入影子腿带袋', () => {
  const saved = { vars: process.env.ENGINE_SYNTAX_VARS, bag: process.env.ENGINE_SYNTAX_VARS_BAG, js: process.env.ENGINE_SYNTAX_JS };
  beforeEach(() => {
    process.env.ENGINE_SYNTAX_VARS = '1';
    process.env.ENGINE_SYNTAX_VARS_BAG = '1';
    process.env.ENGINE_SYNTAX_JS = '1';
  });
  afterEach(() => {
    for (const [key, value] of [['ENGINE_SYNTAX_VARS', saved.vars], ['ENGINE_SYNTAX_VARS_BAG', saved.bag], ['ENGINE_SYNTAX_JS', saved.js]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('readabilityShadow 按 name → tocUrl 填袋后读目录', async () => {
    await preloadJsSandbox();
    const host = 'book15.net';
    const respond = (body: string) => new Response(`<html><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const routes: Record<string, string> = {
      '/b/1.html': DETAIL,
      '/toc/1.html': TOC,
      '/c/2.html': `<div class="c">${'字'.repeat(800)}</div>`,
    };
    const paths: string[] = [];
    const fetchPage = vi.fn<AdmissionTransport>(async (input) => {
      const { pathname, search } = new URL(input);
      paths.push(pathname + search);
      const body = routes[pathname];
      return body === undefined ? new Response('nf', { status: 404 }) : respond(body);
    });
    const source = {
      bookSourceUrl: SITE, bookSourceName: '袋源', searchUrl: `${SITE}/s?q={{key}}`,
      ruleBookInfo: putName, ruleToc: tocWith('a@href@js:result + "?b=" + java.get("bid")'), ruleContent: { content: '.c' },
    } as unknown as RawSource;
    const result = await readabilityShadow(source, { url: '/b/1.html', pageUrl: `${SITE}/s?q=x` }, {
      fetchPage, declaredHosts: new Set([host]), signal: new AbortController().signal, throttleMs: 0,
    });
    expect(result).toEqual({ verdict: 'readable', chapters: 2, chars: 800, error: '' });
    expect(paths).toEqual(['/b/1.html', '/toc/1.html', '/c/2.html?b=42']);
  });
});
