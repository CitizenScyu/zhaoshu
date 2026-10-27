// bind1028：ENGINE_SYNTAX_JS_BIND —— JS 里放行 legado evalJS 的宿主只读绑定（`book.origin`、`chapter.title`/`title`，按字段），
// 以及非 JS 规则里旧路径拒收的 `{{}}` 按 legado SourceRule makeUp 拼值；语义版本位、门面注入与 source-usability 缓存口径。
// 规则均为合成形态。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent, engineFetchToc, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesJsBindSyntax } from './compile';
import { contentNeedsHtmlToText } from './content-html';
import { createScope, evaluateField, evaluateFieldList, normalizeBody, type EvalScope, type ScopeHost } from './evaluate';
import { preloadJsSandbox, runJs } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_JS_BIND_BIT, engineSemanticsVersion, engineSyntaxJsBindEnabled } from './syntax-flags';
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
const ORIGIN = 'http://book15.net#raw';
const ON = { jsEnabled: true, jsBindEnabled: true } as const;
const OFF = { jsEnabled: true, jsBindEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field: string) => parseFieldRule(rule, { ...OFF, field });
const scopeOf = (text: string, host?: ScopeHost): EvalScope => {
  const scope = createScope(normalizeBody(text), PAGE_URL);
  if (host) scope.host = host;
  return scope;
};
const value = (field: FieldIr, text: string, host?: ScopeHost, multi = false) => evaluateField(field, scopeOf(text, host), multi);
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });

describe('开关与语义版本', () => {
  it('engineSyntaxJsBindEnabled 严格口径', () => {
    expect(engineSyntaxJsBindEnabled({})).toBe(false);
    expect(engineSyntaxJsBindEnabled({ ENGINE_SYNTAX_JS_BIND: '0' })).toBe(false);
    expect(engineSyntaxJsBindEnabled({ ENGINE_SYNTAX_JS_BIND: 'yes' })).toBe(false);
    expect(engineSyntaxJsBindEnabled({ ENGINE_SYNTAX_JS_BIND: ' On ' })).toBe(true);
    expect(engineSyntaxJsBindEnabled({ ENGINE_SYNTAX_JS_BIND: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsBindEnabled({ ENGINE_SYNTAX_JS_BIND: '1' })).toBe(true);
  });

  it('宿主绑定位 +2048，1–2048 逐字不变', () => {
    expect(ENGINE_SEMANTICS_JS_BIND_BIT).toBe(2048);
    const all = [true, true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 2048);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, false, false, false, true))
      .toBe(engineSemanticsVersion(false) + 2048);
  });

  it('按源判定：只有 off 拒、on 过的字段所在源换版本', () => {
    const opts = (jsBindEnabled: boolean, jsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled,
    });
    const bindJs = raw({ ruleContent: { content: '#c@text@js:result + book.origin' } });
    const makeUp = raw({ ruleBookInfo: { tocUrl: '{{book.origin}}/toc' } });
    const ruleTpl = raw({ ruleBookInfo: { name: '{{@@#a@text}}-{{@@#b@text}}' } });
    const plainJs = raw({ ruleContent: { content: '#c@html@js:result.trim()' } });
    const jsonTpl = raw({ ruleBookInfo: { name: '{{$.x}}' } });
    const bothReject = raw({ ruleBookInfo: { tocUrl: '{{host}}/toc' } });
    const bookName = raw({ ruleContent: { content: '#c@text@js:book.name' } });
    const chapterOnItem = raw({ ruleSearch: { bookUrl: 'a@href@js:result + chapter.title' } });
    const withLib = raw({ ...bindJs.rules, jsLib: 'function f(){}' });
    for (const s of [plainJs, jsonTpl, bothReject, bookName, chapterOnItem, withLib]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    }
    for (const s of [bindJs, makeUp, ruleTpl]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      expect(engineSourceRevision(s, opts(true, false))).toBe(engineSourceRevision(s, opts(false, false)));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: false, jsExtEnabled: false,
    };
    expect(sourceUsesJsBindSyntax(bindJs.rules, flags)).toBe(true);
    expect(sourceUsesJsBindSyntax(makeUp.rules, flags)).toBe(true);
    expect(sourceUsesJsBindSyntax(plainJs.rules, flags)).toBe(false);
    expect(sourceUsesJsBindSyntax(jsonTpl.rules, flags)).toBe(false);
    expect(sourceUsesJsBindSyntax(bothReject.rules, flags)).toBe(false);
    expect(sourceUsesJsBindSyntax(withLib.rules, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译；两态缓存互不污染', () => {
    const rules = { ruleContent: { content: '#c@text@js:result + chapter.title' } };
    const compiled = (jsBindEnabled: boolean) => compileSource(raw(rules), { jsEnabled: true, jsBindEnabled }).get('ruleContent.content');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true)).not.toHaveProperty('skipped');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse：宿主绑定', () => {
  it('off：绑定名照旧是禁用标识符；on 但 JS 关：照旧拒', () => {
    expect(codeOf(() => off('#c@text@js:result + book.origin', 'ruleContent.content'))).toBe('unsupported_js');
    expect(codeOf(() => off('#c@text@js:result + title', 'ruleContent.content'))).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule('{{book.origin}}/x', { jsEnabled: false, jsBindEnabled: true, field: 'ruleBookInfo.tocUrl' })))
      .toBe('unsupported_template_var');
  });

  it('按字段放行：book.origin 全部 JS 字段；chapter.title/title 只在 chapterUrl 与正文两字段', () => {
    expect(codeOf(() => on('#c@text@js:result + book.origin', 'ruleContent.content'))).toBeUndefined();
    expect(codeOf(() => on('a@href@js:book.origin + result', 'ruleSearch.bookUrl'))).toBeUndefined();
    expect(codeOf(() => on('#c@text@js:result + chapter.title + title', 'ruleContent.content'))).toBeUndefined();
    expect(codeOf(() => on('.n@href@js:result + title', 'ruleContent.nextContentUrl'))).toBeUndefined();
    expect(codeOf(() => on('a@href@js:result + "#" + title', 'ruleToc.chapterUrl'))).toBeUndefined();
    expect(codeOf(() => on('a@href@js:result + title', 'ruleSearch.bookUrl'))).toBe('unsupported_js');
    expect(codeOf(() => on('#t@text@js:result + chapter.title', 'ruleBookInfo.name'))).toBe('unsupported_js');
    // chapterName 求值时章节名还没出来，book 也不开
    expect(codeOf(() => on('a@text@js:result + book.origin', 'ruleToc.chapterName'))).toBe('unsupported_js');
  });

  it('只读白名单成员：其余成员、裸对象、赋值与自增自减一律拒', () => {
    const content = (code: string) => codeOf(() => on(`#c@text@js:${code}`, 'ruleContent.content'));
    expect(content('book.name')).toBe('unsupported_js');
    expect(content('book')).toBe('unsupported_js');
    expect(content('book["origin"]')).toBe('unsupported_js');
    expect(content('chapter.url')).toBe('unsupported_js');
    expect(content('title.length + chapter.title.trim()')).toBeUndefined();
    expect(content('book.origin = "x"')).toBe('unsupported_js');
    expect(content('title += "x"')).toBe('unsupported_js');
    expect(content('title++')).toBe('unsupported_js');
    expect(content('--title')).toBe('unsupported_js');
    expect(content('title == "x" ? result : ""')).toBeUndefined();
    expect(content('"book.origin" + result')).toBeUndefined();
  });
});

describe('parse：规则级 makeUp', () => {
  it('旧路径收得下的模板两态同路（不走 makeUp）', () => {
    const json = on('{{$.x}}', 'ruleBookInfo.name');
    expect(json).toEqual(off('{{$.x}}', 'ruleBookInfo.name'));
    expect(json.makeUp).toBeUndefined();
    expect(on('{{baseUrl}}', 'ruleBookInfo.tocUrl')).toEqual(off('{{baseUrl}}', 'ruleBookInfo.tocUrl'));
  });

  it('off 拒、on 收：{{@@规则}}/{{JS}}；首个 {{ 前无 ## 为 Regex 模式', () => {
    expect(codeOf(() => off('{{@@#a@text}}-x', 'ruleBookInfo.name'))).toBe('unsupported_template_rule');
    expect(on('{{@@#a@text}}-x', 'ruleBookInfo.name').makeUp?.regexMode).toBe(true);
    expect(on('x{{book.origin}}', 'ruleBookInfo.tocUrl').makeUp?.regexMode).toBe(true);
    const tail = on('#c@text##{{@@#p@text}}', 'ruleBookInfo.name');
    expect(tail.makeUp?.regexMode).toBe(false);
    expect(tail.rules).toHaveLength(1);
  });

  it('不猜的形态照旧拒：tpl_var 根、模板外 $N、@get/@put、%%、条目字段读 result', () => {
    expect(codeOf(() => on('{{host}}/x', 'ruleBookInfo.tocUrl'))).toBe('unsupported_template_var');
    expect(codeOf(() => on('{{key}}', 'ruleBookInfo.name'))).toBe('unsupported_template_var');
    expect(codeOf(() => on('{{@@a@text}}$1', 'ruleBookInfo.name'))).toBe('unsupported_template_var');
    expect(codeOf(() => on('#c$1@text##{{@@#p@text}}', 'ruleBookInfo.name'))).toBe('unsupported_template_var');
    expect(codeOf(() => on('@get:{k}{{@@a@text}}', 'ruleBookInfo.name'))).toBe('unsupported_var_get');
    expect(codeOf(() => on('{{@@a@text}}%%b', 'ruleBookInfo.name'))).toBe('unsupported_operator');
    expect(codeOf(() => on('{{result}}x', 'ruleSearch.name'))).toBe('unsupported_template_js');
    expect(codeOf(() => on('{{chapter.title}}', 'ruleSearch.name'))).toBe('unsupported_js');
    expect(codeOf(() => on('{{@@}}', 'ruleBookInfo.name'))).toBe('unsupported_template_rule');
  });

  it('只有核心字符串字段走 makeUp', () => {
    expect(codeOf(() => on('{{@@a@text}}', 'ruleBookInfo.intro'))).toBeDefined();
  });
});

describe('求值', () => {
  const HOST: ScopeHost = { origin: ORIGIN, chapterTitle: '第1章' };

  it('JS 读宿主绑定；未注入时照旧 ReferenceError ⇒ 求值失败', async () => {
    await preloadJsSandbox();
    const field = on('#c@text@js:result + "|" + book.origin + "|" + chapter.title + "|" + title', 'ruleContent.content');
    expect(value(field, '<div id="c">甲</div>', HOST)).toBe(`甲|${ORIGIN}|第1章|第1章`);
    expect(codeOf(() => value(field, '<div id="c">甲</div>'))).toBe('RULE_EVAL_FAILED');
    const originOnly = on('#c@text@js:result + book.origin', 'ruleContent.content');
    expect(value(originOnly, '<div id="c">甲</div>', { origin: ORIGIN })).toBe(`甲${ORIGIN}`);
  });

  it('宿主对象只读：编译期拒裸对象，沙箱里冻结兜底', async () => {
    await preloadJsSandbox();
    const code = '(function(b){ try { b.origin = "x"; b.extra = 1; } catch (e) {} return b.origin + "|" + b.extra; })(book)';
    expect(codeOf(() => on(`#c@text@js:${code}`, 'ruleContent.content'))).toBe('unsupported_js');
    expect(runJs(code, { result: '', baseUrl: SITE, objects: { book: { origin: 'o' } } })).toBe('o|undefined');
  });

  it('列表条目作用域沿用页面的宿主绑定', async () => {
    await preloadJsSandbox();
    const page = scopeOf('<li><a href="/c/1.html">一</a></li><li><a href="/c/2.html">二</a></li>', { origin: ORIGIN });
    const items = evaluateFieldList(parseFieldRule('li', { field: 'ruleSearch.bookList' }), page);
    const url = on('a@href@js:book.origin + "|" + result', 'ruleSearch.bookUrl');
    expect(items.map((item) => evaluateField(url, item))).toEqual([`${ORIGIN}|${SITE}/c/1.html`, `${ORIGIN}|${SITE}/c/2.html`]);
  });

  it('makeUp Regex 模式：拼值即结果；{{JS}} 得 null 不拼', async () => {
    await preloadJsSandbox();
    const html = '<b id="a">甲</b><b id="b">乙</b>';
    expect(value(on('{{@@#a@text}}-{{@@#b@text}}', 'ruleBookInfo.name'), html)).toBe('甲-乙');
    expect(value(on('{{book.origin}}/toc', 'ruleBookInfo.tocUrl'), html, HOST)).toBe(`${ORIGIN}/toc`);
    expect(value(on('{{(null)}}abc', 'ruleBookInfo.name'), html)).toBe('abc');
    // 首段为空且有替换：对页面原文替换
    expect(value(on('{{""}}##[<>]##', 'ruleBookInfo.name'), 'xy')).toBe('xy');
  });

  it('makeUp 非 Regex 模式：主体照旧取值，{{}} 拼出动态正则；编译失败按 legado 回退', async () => {
    await preloadJsSandbox();
    const field = on('#c@text##{{@@#p@text}}##X', 'ruleBookInfo.name');
    expect(value(field, '<div id="c">甲乙丙乙</div><i id="p">乙</i>')).toBe('甲X丙X');
    // 动态正则编译失败：非 replaceFirst 按字面全替换
    expect(value(field, '<div id="c">a(b(</div><i id="p">(</i>')).toBe('aXbX');
    // replaceFirst（≥4 段）编译失败：整体换成替换串
    expect(value(on('#c@text##{{@@#p@text}}##X###', 'ruleBookInfo.name'), '<div id="c">a(b(</div><i id="p">(</i>')).toBe('X');
  });

  it('非正文字段的未解码值按 unescapeHtml4 口径（只认带分号的实体）解码', async () => {
    await preloadJsSandbox();
    expect(value(on('{{"a&amp;b&ampc"}}', 'ruleBookInfo.name'), '<p>x</p>')).toBe('a&b&ampc');
  });

  it('正文 Regex 模式 makeUp 交 HTML→纯文本；非 Regex 模式按主体规则判', () => {
    expect(contentNeedsHtmlToText(on('{{@@#c@html}}', 'ruleContent.content'))).toBe(true);
    expect(contentNeedsHtmlToText(on('#c@text##{{@@#p@text}}', 'ruleContent.content'))).toBe(false);
  });
});

describe('门面注入', () => {
  const saved = { bind: process.env.ENGINE_SYNTAX_JS_BIND };
  beforeEach(() => { process.env.ENGINE_SYNTAX_JS_BIND = '1'; });
  afterEach(() => {
    if (saved.bind === undefined) delete process.env.ENGINE_SYNTAX_JS_BIND;
    else process.env.ENGINE_SYNTAX_JS_BIND = saved.bind;
  });

  const TOC_URL = `${SITE}/toc/1.html`;
  const engine = (rules: Record<string, unknown>, origin?: string): EngineSource => ({
    url: SITE, name: 'bind 源', searchUrl: `${SITE}/s?q={{key}}`, origin,
    compiled: compileSource(raw(rules), { jsEnabled: true, jsBindEnabled: true }),
  });
  const context = (pages: Map<string, string>): SourceRequestContext => ({
    page: async (url: string) => {
      const text = pages.get(url);
      if (text === undefined) throw new Error('Unexpected request: ' + url);
      return { url, text };
    },
  } as unknown as SourceRequestContext);

  it('目录 chapterUrl 读本条章节名；book.origin 取书源原文地址', async () => {
    await preloadJsSandbox();
    const src = engine({
      ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href@js:result + "?t=" + title.length + (book.origin === "http://x.example" ? "&o" : "")' },
      ruleContent: { content: '#c@text' },
    }, 'http://x.example');
    const pages = new Map([[TOC_URL, '<li class="ch"><a href="/c/1.html">第1章</a></li><li class="ch"><a href="/c/2.html">第十二章</a></li>']]);
    const { chapters } = await engineFetchToc(src, TOC_URL, context(pages));
    expect(chapters.map((c) => c.url)).toEqual([`${SITE}/c/1.html?t=3&o`, `${SITE}/c/2.html?t=4&o`]);
  });

  it('正文读调用方给的章节名；缺省 origin 回退源 url', async () => {
    await preloadJsSandbox();
    const src = engine({ ruleContent: { content: '#c@text@js:title + "|" + book.origin + "|" + result' } });
    const url = `${SITE}/c/1.html`;
    const pages = new Map([[url, '<div id="c">正文</div>']]);
    expect((await engineFetchContent(src, url, context(pages), false, undefined, '第1章')).text).toBe(`第1章|${SITE}|正文`);
  });

  it('开关关：页面作用域不挂宿主，读绑定的 JS 求值失败（off 态编译期本就 skipped）', async () => {
    await preloadJsSandbox();
    process.env.ENGINE_SYNTAX_JS_BIND = '0';
    const src = engine({ ruleContent: { content: '#c@text@js:result + book.origin' } });
    const url = `${SITE}/c/1.html`;
    await expect(engineFetchContent(src, url, context(new Map([[url, '<div id="c">正文</div>']])))).rejects.toThrow();
  });
});

describe('source-usability 缓存口径', () => {
  const saved = process.env.ENGINE_SYNTAX_JS_BIND;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGINE_SYNTAX_JS_BIND;
    else process.env.ENGINE_SYNTAX_JS_BIND = saved;
  });

  it('翻 ENGINE_SYNTAX_JS_BIND 后 engineSourceUsable 重新判定', async () => {
    const { engineSourceUsable } = await import('../source-usability');
    const env = process.env;
    const prev = { js: env.ENGINE_SYNTAX_JS };
    env.ENGINE_SYNTAX_JS = '1';
    try {
      const source = {
        url: 'https://book15.net/', name: 'x', searchUrl: 'https://book15.net/s?q={{key}}', // 默认 host 门白名单
        rules: {
          ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
          ruleToc: { chapterList: '.c', chapterName: 'a@text', chapterUrl: 'a@href' },
          ruleContent: { content: '#c@text@js:result + chapter.title' },
        },
      };
      env.ENGINE_SYNTAX_JS_BIND = '0';
      const offState = engineSourceUsable(source as never);
      env.ENGINE_SYNTAX_JS_BIND = '1';
      const onState = engineSourceUsable(source as never);
      expect(offState).toBe(false);
      expect(onState).toBe(true);
    } finally {
      if (prev.js === undefined) delete env.ENGINE_SYNTAX_JS;
      else env.ENGINE_SYNTAX_JS = prev.js;
    }
  });
});
