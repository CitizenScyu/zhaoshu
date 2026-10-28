// initjsoup1028：ENGINE_SYNTAX_INIT_JSOUP —— 详情页 JS init 的 jsoup 口径（legado BookInfo `evalJS(init, content)` 里
// `org.jsoup.Jsoup.parse(result)` / `java.getElement(s)`）：开关与位值、编译期两态、返回值口径、按源判定、准入按 env。全部为合成形态。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchDetail, type EngineSource } from './api';
import { compileSource, engineSourceRevision, type CompileOptions } from './compile';
import { selectCandidates, type RawSource } from './compile-smoke';
import { createScope, evaluateField, evaluateInitScope, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { initJsRuleSupported } from './parse';
import { ENGINE_SEMANTICS_INIT_JSOUP_BIT, engineSemanticsVersion, engineSyntaxInitJsoupEnabled } from './syntax-flags';
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
const ON: CompileOptions = {
  jsEnabled: true, jsGetEnabled: true, regexEnabled: true, initEnabled: true, initJsEnabled: true, jsoupEnabled: true, initJsoupEnabled: true,
};
const OFF: CompileOptions = { ...ON, initJsoupEnabled: false };

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
const evalError = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? `${err.code}:${err.message}` : `non-engine:${String(err)}`;
  }
};
const versionOf = (revision: string) => Number(revision.split(':')[0]);

const HTML_PAGE = '<head><meta property="og:novel:book_name" content="书名"><meta property="og:novel:read_url" content="/toc/1.html"></head>'
  + '<body><div class="info"><h1>书名</h1><span class="writer">作者：某人</span></div></body>';
// 形态取自真实书源 init 的打码骨架：Jsoup.parse 整页、箭头函数取 meta/text、返回对象字面量。
const SOUP_INIT = '@js:var doc = org.jsoup.Jsoup.parse(result);\n'
  + 'var meta = (p) => String(doc.select("meta[property=og:novel:" + p + "]").attr("content"));\n'
  + 'var txt = (s) => String(doc.select(s).text());\n'
  + '({name: meta("book_name"), author: txt(".writer").replace("作者：", ""), tocUrl: meta("read_url")})';

beforeAll(async () => {
  await preloadJsSandbox();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('开关与语义版本', () => {
  it('engineSyntaxInitJsoupEnabled 严格口径', () => {
    expect(engineSyntaxInitJsoupEnabled({})).toBe(false);
    expect(engineSyntaxInitJsoupEnabled({ ENGINE_SYNTAX_INIT_JSOUP: '0' })).toBe(false);
    expect(engineSyntaxInitJsoupEnabled({ ENGINE_SYNTAX_INIT_JSOUP: 'yes' })).toBe(false);
    expect(engineSyntaxInitJsoupEnabled({ ENGINE_SYNTAX_INIT_JSOUP: ' On ' })).toBe(true);
    expect(engineSyntaxInitJsoupEnabled({ ENGINE_SYNTAX_INIT_JSOUP: 'TRUE' })).toBe(true);
    expect(engineSyntaxInitJsoupEnabled({ ENGINE_SYNTAX_INIT_JSOUP: '1' })).toBe(true);
  });

  it('jsoup init 位 +1073741824，前 29 位逐字不变，全开仍在 int4 内', () => {
    expect(ENGINE_SEMANTICS_INIT_JSOUP_BIT).toBe(1073741824);
    const all = Array<boolean>(29).fill(true) as [boolean, ...boolean[]];
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 1073741824);
    expect(engineSemanticsVersion(...all, true)).toBeLessThanOrEqual(2147483647);
  });
});

describe('编译期两态', () => {
  it('jsoup init：on 态挂 initScope 且标 jsoup；off 态、jsoup 关、JS init 关一律不挂', () => {
    const on = compiledInit(SOUP_INIT);
    expect(on?.initScope).toBe(true);
    expect(on?.jsoup).toBe(true);
    expect(compiledInit(SOUP_INIT, OFF)).toBeUndefined();
    expect(compiledInit(SOUP_INIT, { ...ON, jsoupEnabled: false })).toBeUndefined();
    expect(compiledInit(SOUP_INIT, { ...ON, initJsEnabled: false })).toBeUndefined();
    expect(compiledInit(SOUP_INIT, { ...ON, jsEnabled: false })).toBeUndefined();
  });

  it('off 态编得过的 init 逐字不变（不标 jsoup）', () => {
    for (const init of ['@js:result', '@js:var X = (x) => java.getString(x); ({name: X("h1@text")})']) {
      const on = compiledInit(init);
      expect(on?.jsoup).toBeUndefined();
      expect(on).toEqual(compiledInit(init, OFF));
    }
  });

  it('jsoup 帧照旧的限制：动态 getElements 实参、联网、{{}} 模板拒', () => {
    for (const init of [
      '@js:var r = "h1"; ({name: String(java.getElements(r).text())})',
      '@js:org.jsoup.Jsoup.parse(java.ajax("x")).text()',
      '@js:org.jsoup.Jsoup.parse(result).select("{{h1}}").text()',
    ]) {
      expect(compiledInit(init)).toBeUndefined();
    }
  });

  it('initJsRuleSupported 按 env：ENGINE_SYNTAX_INIT_JSOUP 开（且 jsoup 开）才收 jsoup init', () => {
    vi.stubEnv('ENGINE_SYNTAX_INIT', '1');
    vi.stubEnv('ENGINE_SYNTAX_INIT_JS', '1');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
    expect(initJsRuleSupported(SOUP_INIT)).toBe(false);
    vi.stubEnv('ENGINE_SYNTAX_INIT_JSOUP', '1');
    expect(initJsRuleSupported(SOUP_INIT)).toBe(true);
    vi.stubEnv('ENGINE_SYNTAX_JSOUP', '0');
    expect(initJsRuleSupported(SOUP_INIT)).toBe(false);
  });
});

describe('求值', () => {
  it('返回对象：详情字段按键名直取（含 Java 字符串值）', async () => {
    const pages = new Map([[BOOK_URL, HTML_PAGE]]);
    const bookInfo = { init: SOUP_INIT, name: 'name', author: 'author', tocUrl: 'tocUrl' };
    expect(await engineFetchDetail(engineSource(bookInfo), BOOK_URL, fakeContext(pages)))
      .toEqual({ title: '书名', author: '某人', tocUrl: TOC_URL });
    const javaStr = compiledInit('@js:var d = org.jsoup.Jsoup.parse(result); ({name: d.select("h1").text()})')!;
    const scope = evaluateInitScope(javaStr, scopeOf(HTML_PAGE));
    const compiled = compileSource(sourceOf({ init: '@js:var d = org.jsoup.Jsoup.parse(result); ({name: d.select("h1").text()})', name: 'name' }), ON);
    expect(evaluateField(compiled.get('ruleBookInfo.name') as FieldIr, scope)).toBe('书名');
  });

  it('java.getElements 在页面作用域上取节点', () => {
    const init = compiledInit('@js:({name: String(java.getElements(".info h1").text())})')!;
    expect(init.jsoup).toBe(true);
    const compiled = compileSource(sourceOf({ init: '@js:({name: String(java.getElements(".info h1").text())})', name: 'name' }), ON);
    expect(evaluateField(compiled.get('ruleBookInfo.name') as FieldIr, evaluateInitScope(init, scopeOf(HTML_PAGE)))).toBe('书名');
  });

  it('返回字符串（Java 字符串）：按内容重新判定为新页面', () => {
    const scope = evaluateInitScope(compiledInit('@js:org.jsoup.Jsoup.parse(result).select(".info").outerHtml()')!, scopeOf(HTML_PAGE));
    expect(evaluateField(fieldOf('h1@text'), scope)).toBe('书名');
    expect(evaluateField(fieldOf('meta@content'), scope)).toBe('');
  });

  it('返回 Element/Elements、数组、数字、null 求值失败', () => {
    for (const [init, message] of [
      ['@js:org.jsoup.Jsoup.parse(result).select(".info").first()', 'Element'],
      ['@js:org.jsoup.Jsoup.parse(result).select(".info")', 'Element'],
      ['@js:org.jsoup.Jsoup.parse(result); [1]', '不是字符串/普通对象'],
      ['@js:org.jsoup.Jsoup.parse(result); 1', '不是字符串/普通对象'],
      ['@js:org.jsoup.Jsoup.parse(result); null', 'null/undefined'],
    ] as const) {
      const err = evalError(() => evaluateInitScope(compiledInit(init)!, scopeOf(HTML_PAGE)));
      expect(err).toMatch(/^RULE_EVAL_FAILED:/);
      expect(err).toContain(message);
    }
  });
});

describe('按源判定', () => {
  it('jsoup init 的源只多翻 jsoup init 位；普通 JS init、非 JS init、jsoup 关不翻', () => {
    const using = sourceOf({ init: SOUP_INIT, name: 'name' });
    expect(versionOf(engineSourceRevision(using, ON)) - versionOf(engineSourceRevision(using, OFF))).toBe(ENGINE_SEMANTICS_INIT_JSOUP_BIT);
    for (const init of ['@js:result', 'class.info']) {
      const plain = sourceOf({ init, name: 'h1@text' });
      expect(engineSourceRevision(plain, ON)).toBe(engineSourceRevision(plain, OFF));
    }
    expect(engineSourceRevision(using, { ...ON, jsoupEnabled: false })).toBe(engineSourceRevision(using, { ...OFF, jsoupEnabled: false }));
    expect(engineSourceRevision(using, { ...ON, initJsEnabled: false })).toBe(engineSourceRevision(using, { ...OFF, initJsEnabled: false }));
  });

  it('off 态编译产物与开关缺省（env 关）一致', () => {
    const rules = { init: SOUP_INIT, name: '.info h1@text' };
    const off = compileSource(sourceOf(rules), OFF);
    const dflt = compileSource(sourceOf(rules), { ...ON, initJsoupEnabled: undefined });
    expect([...off.entries()]).toEqual([...dflt.entries()]);
  });

  it('selectCandidates：jsoup init 只在 env 开时放行', () => {
    vi.stubEnv('ENGINE_SYNTAX_INIT', '1');
    vi.stubEnv('ENGINE_SYNTAX_INIT_JS', '1');
    vi.stubEnv('ENGINE_SYNTAX_JSOUP', '1');
    const cand = {
      bookSourceUrl: SITE, searchUrl: SEARCH_URL,
      ruleSearch: { bookList: '.book', name: '.name@text', bookUrl: 'a@href' }, ruleContent: { content: '#c@html' },
      ruleBookInfo: { init: SOUP_INIT, name: 'name' },
    } as unknown as RawSource;
    expect(selectCandidates([cand], { coreJs: true, initJs: true }).length).toBe(0);
    vi.stubEnv('ENGINE_SYNTAX_INIT_JSOUP', '1');
    expect(selectCandidates([cand], { coreJs: true, initJs: true }).length).toBe(1);
  });
});
