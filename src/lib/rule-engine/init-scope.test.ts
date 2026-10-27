// init1028：ENGINE_SYNTAX_INIT —— 详情字段按 legado BookInfo `setContent(getElement(init))` 在 init 结果上求值；
// 语义版本位、可复现形态判据（原文 + IR）、HTML/JSON 两侧求值口径、按源判定、门面接线。全部为合成形态。
import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchDetail, type EngineSource } from './api';
import { compileSource, engineSourceRevision, sourceUsesInitSyntax, type CompileOptions } from './compile';
import { bookInfoScope, createScope, evaluateField, evaluateInitScope, normalizeBody } from './evaluate';
import { initRuleTextSupported } from './parse';
import { ENGINE_SEMANTICS_INIT_BIT, engineSemanticsVersion, engineSyntaxInitEnabled } from './syntax-flags';
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
const ON: CompileOptions = { initEnabled: true };
const OFF: CompileOptions = { initEnabled: false };
const OPTION_KEYS = {
  orEnabled: true, xpathEnabled: true, xpathEvalEnabled: true, jsEnabled: false, regexEnabled: true, andEnabled: true, aioEnabled: true,
  listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false, jsUtilEnabled: false, jsonPathEnabled: true,
};

const sourceOf = (bookInfo: Record<string, unknown>) => ({ url: `${SITE}/engine/`, searchUrl: SEARCH_URL, rules: { ...BASE_RULES, ruleBookInfo: bookInfo } });
const compiledInit = (bookInfo: Record<string, unknown>, options: CompileOptions = ON) => {
  const entry = compileSource(sourceOf(bookInfo), options).get('ruleBookInfo.init');
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
const fieldOf = (rule: string, options: CompileOptions = {}): FieldIr => {
  const entry = compileSource(sourceOf({ name: rule }), options).get('ruleBookInfo.name');
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

const HTML_PAGE = '<h1>站点</h1><span class="writer">站长</span>'
  + '<div class="info"><h1>书名</h1><span class="writer">作者</span><a class="toc" href="/toc/1.html">目录</a></div>';

describe('开关与语义版本', () => {
  it('engineSyntaxInitEnabled 严格口径', () => {
    expect(engineSyntaxInitEnabled({})).toBe(false);
    expect(engineSyntaxInitEnabled({ ENGINE_SYNTAX_INIT: '0' })).toBe(false);
    expect(engineSyntaxInitEnabled({ ENGINE_SYNTAX_INIT: 'yes' })).toBe(false);
    expect(engineSyntaxInitEnabled({ ENGINE_SYNTAX_INIT: ' On ' })).toBe(true);
    expect(engineSyntaxInitEnabled({ ENGINE_SYNTAX_INIT: 'TRUE' })).toBe(true);
    expect(engineSyntaxInitEnabled({ ENGINE_SYNTAX_INIT: '1' })).toBe(true);
  });

  it('init 位 +32768，1–32768 逐字不变', () => {
    expect(ENGINE_SEMANTICS_INIT_BIT).toBe(32768);
    const all = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 32768);
  });
});

describe('可复现形态判据', () => {
  it('原文判据：@put/@get、##、`:` 开头、JS、XPath 支一律拒', () => {
    for (const rule of ['@put:{a:"h1@text"}', 'class.info@get:{a}', 'class.info##x##y', ':<h1>(.*?)</h1>', '<js>1</js>', '@js:result',
      '//div[@class="info"]', '@XPath://div', 'class.none||//div', ' ', 7]) {
      expect(initRuleTextSupported(rule)).toBe(false);
    }
    for (const rule of ['class.info', '$.data', 'data', '.info', '@css:.info', 'class.none||class.info']) {
      expect(initRuleTextSupported(rule)).toBe(true);
    }
  });

  it('只挂可复现的 init；模板/字面量/&&/off 态不挂', () => {
    expect(compiledInit({ init: 'class.info' })?.initScope).toBe(true);
    expect(compiledInit({ init: '$.data.book' })?.initScope).toBe(true);
    expect(compiledInit({ init: 'class.none||class.info' }, { ...ON, orEnabled: true })?.initScope).toBe(true);
    expect(compiledInit({ init: 'class.info' }, OFF)?.initScope).toBeUndefined();
    for (const init of ['{{baseUrl}}', 'https://book15.net/x', '@put:{a:"h1@text"}', 'class.info##x', 'class.a&&class.b']) {
      expect(compiledInit({ init }, { ...ON, orEnabled: true, andEnabled: true })?.initScope).toBeUndefined();
    }
  });

  it('按源判定：只有可复现 init 的源翻语义版本；off 态 identity 与不带开关一致', () => {
    const using = sourceOf({ init: 'class.info', name: 'h1@text' });
    const plain = sourceOf({ name: 'h1@text' });
    const notRepro = sourceOf({ init: '@put:{a:"h1@text"}', name: 'h1@text' });
    expect(engineSourceRevision(using, ON)).not.toBe(engineSourceRevision(using, OFF));
    expect(engineSourceRevision(plain, ON)).toBe(engineSourceRevision(plain, OFF));
    expect(engineSourceRevision(notRepro, ON)).toBe(engineSourceRevision(notRepro, OFF));
    expect(engineSourceRevision(using, OFF)).toBe(engineSourceRevision(using, { initEnabled: undefined }));
    expect(sourceUsesInitSyntax(using.rules, OPTION_KEYS)).toBe(true);
    expect(sourceUsesInitSyntax(plain.rules, OPTION_KEYS)).toBe(false);
    expect(sourceUsesInitSyntax(notRepro.rules, OPTION_KEYS)).toBe(false);
  });

  it('off 态编译产物与开关缺省一致（init 照旧不生效）', () => {
    const rules = { init: 'class.info', name: 'h1@text' };
    const off = compileSource(sourceOf(rules), OFF);
    expect([...off.keys()]).toEqual([...compileSource(sourceOf(rules), {}).keys()]);
    const scope = scopeOf(HTML_PAGE);
    expect(bookInfoScope(off, scope)).toBe(scope);
  });
});

describe('HTML：getElement 取节点集，后续字段在重新载入的片段上求值', () => {
  it('门面：name/author/tocUrl 改读 init 节点里的值；off 态读整页', async () => {
    const pages = new Map([[BOOK_URL, HTML_PAGE]]);
    const bookInfo = { init: 'class.info', name: 'h1@text', author: '.writer@text', tocUrl: '.toc@href' };
    expect(await engineFetchDetail(engineSource(bookInfo), BOOK_URL, fakeContext(pages)))
      .toEqual({ title: '书名', author: '作者', tocUrl: TOC_URL });
    const off = await engineFetchDetail(engineSource(bookInfo, OFF), BOOK_URL, fakeContext(pages));
    expect(off.title).not.toBe('书名');
  });

  it('`||` 取首个非空支；全空得空片段（字段为空）', () => {
    const init = compiledInit({ init: 'class.none||class.info' }, { ...ON, orEnabled: true })!;
    expect(evaluateField(fieldOf('h1@text'), evaluateInitScope(init, scopeOf(HTML_PAGE)))).toBe('书名');
    const empty = compiledInit({ init: 'class.none' })!;
    expect(evaluateField(fieldOf('h1@text'), evaluateInitScope(empty, scopeOf(HTML_PAGE)))).toBe('');
  });

  it('多个节点按行拼 outerHtml；正则-only 规则读的是这份文本（legado Elements.toString）', () => {
    const page = '<h1>站点</h1><div class="x"><h1>甲</h1></div><div class="x"><b>乙</b></div>';
    const scope = evaluateInitScope(compiledInit({ init: 'class.x' })!, scopeOf(page));
    expect(evaluateField(fieldOf('b@text'), scope)).toBe('乙');
    const regexOnly = fieldOf('##<h1>(.*?)</h1>##$1###', { regexEnabled: true });
    expect(evaluateField(regexOnly, scope)).toBe('甲');
  });

  it('带末端 op 的 CSS 与 JSONPath init 在 HTML 上求值失败', () => {
    expect(evalCode(() => evaluateInitScope(compiledInit({ init: 'class.info@text' })!, scopeOf(HTML_PAGE)))).toBe('RULE_EVAL_FAILED');
    expect(evalCode(() => evaluateInitScope(compiledInit({ init: '$.data' })!, scopeOf(HTML_PAGE)))).toBe('RULE_EVAL_FAILED');
  });

  it('页面 URL 与宿主绑定沿用页面作用域', () => {
    const scope = scopeOf(HTML_PAGE);
    scope.host = { origin: `${SITE}/engine/` };
    const next = evaluateInitScope(compiledInit({ init: 'class.info' })!, scope);
    expect(next.pageUrl).toBe(BOOK_URL);
    expect(next.host).toEqual({ origin: `${SITE}/engine/` });
    expect(next.source).toBeUndefined();
  });
});

describe('JSON：Jayway ctx.read 取值', () => {
  const JSON_PAGE = JSON.stringify({ code: 0, data: { novelName: '书', authorName: '作者', tocUrl: '/toc/1.html' }, list: [{ n: '甲' }, { n: '乙' }] });

  it('门面：`$.data` 后字段相对 data 求值；默认语法 `data` 补 `$.`', async () => {
    const pages = new Map([[BOOK_URL, JSON_PAGE]]);
    for (const init of ['$.data', 'data']) {
      const bookInfo = { init, name: '$.novelName', author: 'authorName', tocUrl: '$.tocUrl' };
      expect(await engineFetchDetail(engineSource(bookInfo), BOOK_URL, fakeContext(pages)))
        .toEqual({ title: '书', author: '作者', tocUrl: TOC_URL });
    }
    const off = await engineFetchDetail(engineSource({ init: '$.data', name: '$.novelName' }, OFF), BOOK_URL, fakeContext(pages));
    expect(off.title).toBeUndefined();
  });

  it('确定路径缺失或为 null 求值失败（legado 默认配置抛异常 / setContent(null)）', () => {
    const page = JSON.stringify({ data: null });
    for (const init of ['$.missing', '$.data', '$.list[5]']) {
      expect(evalCode(() => evaluateInitScope(compiledInit({ init })!, scopeOf(page)))).toBe('RULE_EVAL_FAILED');
    }
  });

  it('不确定路径取命中列表（数组作用域）', () => {
    const scope = evaluateInitScope(compiledInit({ init: '$.list[*]' })!, scopeOf(JSON_PAGE));
    expect(scope.kind).toBe('json');
    expect(evaluateField(fieldOf('$[1].n'), scope)).toBe('乙');
  });

  it('字符串值按页面重新判定 HTML/JSON；数字/布尔、显式 CSS、`||` 求值失败', () => {
    const html = evaluateInitScope(compiledInit({ init: '$.body' })!, scopeOf(JSON.stringify({ body: '<h1>书</h1>' })));
    expect(evaluateField(fieldOf('h1@text'), html)).toBe('书');
    const json = evaluateInitScope(compiledInit({ init: '$.body' })!, scopeOf(JSON.stringify({ body: '{"name":"书"}' })));
    expect(evaluateField(fieldOf('$.name'), json)).toBe('书');
    expect(json.source).toBe('{"name":"书"}');
    expect(evalCode(() => evaluateInitScope(compiledInit({ init: '$.code' })!, scopeOf(JSON_PAGE)))).toBe('RULE_EVAL_FAILED');
    expect(evalCode(() => evaluateInitScope(compiledInit({ init: '@css:.info' })!, scopeOf(JSON_PAGE)))).toBe('RULE_EVAL_FAILED');
    const or = compiledInit({ init: '$.none||$.data' }, { ...ON, orEnabled: true })!;
    expect(evalCode(() => evaluateInitScope(or, scopeOf(JSON_PAGE)))).toBe('RULE_EVAL_FAILED');
  });

  it('对象值的作用域没有原文（legado Map.toString 不复现）', () => {
    const scope = evaluateInitScope(compiledInit({ init: '$.data' })!, scopeOf(JSON_PAGE));
    expect(scope.source).toBeUndefined();
    const regexOnly = fieldOf('##书##X###', { regexEnabled: true });
    expect(evalCode(() => evaluateField(regexOnly, scope))).toBe('RULE_EVAL_FAILED');
  });
});
