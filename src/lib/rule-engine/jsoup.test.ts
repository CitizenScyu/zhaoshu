// jsoup1028：ENGINE_SYNTAX_JSOUP —— JS 链直连 jsoup DOM（java.getElement(s)、org.jsoup.Jsoup.parse、条目级 result/src 是 Element、
// 列表链首段规则交 Elements 给 JS）；off 态被拒的字段才重试，语义版本位按源判定。规则与页面均为合成形态。
import { describe, expect, it } from 'vitest';
import { compileSource, engineSourceRevision, sourceUsesJsoupSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody, type EvalScope } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_JSOUP_BIT, engineSemanticsVersion, engineSyntaxJsoupEnabled } from './syntax-flags';
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
const ON = { jsEnabled: true, jsoupEnabled: true } as const;
const OFF = { jsEnabled: true, jsoupEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...OFF, ...extra, field });
const scopeOf = (text: string): EvalScope => createScope(normalizeBody(text), PAGE_URL);
const value = (field: FieldIr, text: string) => evaluateField(field, scopeOf(text));
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const CONTENT = 'ruleContent.content';
const NAME = 'ruleSearch.name';
const LIST = 'ruleSearch.bookList';
const PAGE = '<div id="c"><p>甲</p><p class="x">乙</p></div><ul><li class="item"><a href="/b/1">一</a></li><li class="item on"><a href="/b/2">二</a></li></ul>';

describe('开关与语义版本', () => {
  it('engineSyntaxJsoupEnabled 严格口径', () => {
    expect(engineSyntaxJsoupEnabled({})).toBe(false);
    expect(engineSyntaxJsoupEnabled({ ENGINE_SYNTAX_JSOUP: '0' })).toBe(false);
    expect(engineSyntaxJsoupEnabled({ ENGINE_SYNTAX_JSOUP: 'yes' })).toBe(false);
    expect(engineSyntaxJsoupEnabled({ ENGINE_SYNTAX_JSOUP: ' On ' })).toBe(true);
    expect(engineSyntaxJsoupEnabled({ ENGINE_SYNTAX_JSOUP: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsoupEnabled({ ENGINE_SYNTAX_JSOUP: '1' })).toBe(true);
  });

  it('jsoup 位 +4194304，此前各位逐字不变', () => {
    expect(ENGINE_SEMANTICS_JSOUP_BIT).toBe(4194304);
    const all = Array.from({ length: 21 }, () => true) as boolean[];
    const call = (...args: boolean[]) => (engineSemanticsVersion as (...a: boolean[]) => number)(...args);
    const base = call(...all);
    expect(call(...all, false)).toBe(base);
    expect(call(...all, true)).toBe(base + 4194304);
  });

  it('按源判定：只有 off 拒、on 过的字段所在源换版本', () => {
    const opts = (jsoupEnabled: boolean, jsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: true, jsExtEnabled: false, jsBindEnabled: false,
      jsGetEnabled: false, jsUtilEnabled: false, jsonPathEnabled: false, jsoupEnabled,
    });
    const getEls = raw({ ruleContent: { content: '@js:java.getElements("p").text()' } });
    const itemJs = raw({ ruleSearch: { bookList: '.item', name: '@js:result.selectFirst("a").text()', bookUrl: 'a@href' } });
    const listHead = raw({ ruleSearch: { bookList: '.item@js:result', name: 'a@text', bookUrl: 'a@href' } });
    const plainJs = raw({ ruleContent: { content: '#c@text@js:result.trim()' } });
    const bothReject = raw({ ruleContent: { content: '@js:java.getElements("p").text() + java.ajax("x")' } });
    const withLib = raw({ ...getEls.rules, jsLib: 'function f(){}' });
    for (const s of [plainJs, bothReject, withLib]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    }
    for (const s of [getEls, itemJs, listHead]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      expect(engineSourceRevision(s, opts(true, false))).toBe(engineSourceRevision(s, opts(false, false)));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: true, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false, jsUtilEnabled: false,
      jsonPathEnabled: false,
    };
    for (const s of [getEls, itemJs, listHead]) expect(sourceUsesJsoupSyntax(s.rules, flags)).toBe(true);
    for (const s of [plainJs, bothReject, withLib]) expect(sourceUsesJsoupSyntax(s.rules, flags)).toBe(false);
  });

  it('其余各位先按 jsoup 关判：jsoup 救活别的开关的 off 态时不清该位', () => {
    // 条目首段 JS 不读 result：jsExt 开时 detached 起链；jsExt 关、jsoup 开时也能以 Element 起链编过。
    const s = raw({ ruleSearch: { bookList: '.item', name: '@js:"固定"', bookUrl: 'a@href' } });
    const rev = (jsExtEnabled: boolean, jsoupEnabled: boolean) => engineSourceRevision(s, {
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled: true, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled, jsBindEnabled: false,
      jsGetEnabled: false, jsUtilEnabled: false, jsonPathEnabled: false, jsoupEnabled,
    });
    expect(codeOf(() => parseFieldRule('@js:"固定"', { ...OFF, jsExtEnabled: false, field: NAME }))).toBe('unsupported_js');
    expect(parseFieldRule('@js:"固定"', { ...ON, jsExtEnabled: false, field: NAME }).jsoup).toBe(true);
    expect(rev(true, true)).toBe(rev(true, false));
    expect(rev(true, true)).not.toBe(rev(false, false));
    expect(rev(false, true)).not.toBe(rev(false, false));
  });

  it('compileSource：off 态照旧 skipped，on 态编译；两态缓存互不污染', () => {
    const rules = { ruleContent: { content: '@js:java.getElements("p").text()' } };
    const compiled = (jsoupEnabled: boolean) => compileSource(raw(rules), { jsEnabled: true, jsoupEnabled }).get(CONTENT);
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true)).toMatchObject({ jsoup: true });
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    // JS 关：jsoup 开也不生效
    expect(compileSource(raw(rules), { jsEnabled: false, jsoupEnabled: true }).get(CONTENT)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse：只重试 off 态被拒的字段', () => {
  it('off 拒、on 过：getElements / Jsoup.parse / 条目级 result', () => {
    for (const rule of ['@js:java.getElements("p").text()', '@js:java.getElement("p").text()',
      '@js:org.jsoup.Jsoup.parse(result).select("p").text()', '@js:Packages.org.jsoup.Jsoup.parse(result).text()']) {
      expect(codeOf(() => off(rule, CONTENT))).toBe('unsupported_js');
      expect(on(rule, CONTENT).jsoup).toBe(true);
    }
    expect(codeOf(() => off('@js:result.selectFirst("a").text()', NAME))).toBe('unsupported_js');
    expect(on('@js:result.selectFirst("a").text()', NAME).jsoup).toBe(true);
    expect(on('@js:src.text()', NAME).jsoup).toBe(true);
  });

  it('off 态能编的字段 on 态逐字不变（不挂 jsoup）', () => {
    for (const [rule, field] of [['#c@text@js:result.trim()', CONTENT], ['a@text@js:result + "x"', NAME]] as const) {
      expect(on(rule, field)).toEqual(off(rule, field));
      expect(on(rule, field).jsoup).toBeUndefined();
    }
  });

  it('getElements 实参白名单：字面量、取节点的规则；去重', () => {
    const field = on('@js:java.getElements("p").size() + java.getElement(\'p\').size() + java.getElements("#c p").size()', CONTENT);
    expect([...(field.jsElements?.keys() ?? [])]).toEqual(['p', '#c p']);
    expect(on('@js:org.jsoup.Jsoup.parse(result).text()', CONTENT).jsElements).toBeUndefined();
  });

  it('不收的形态照旧拒', () => {
    const rejected = (code: string, field = CONTENT) => codeOf(() => on(`@js:${code}`, field));
    expect(rejected('java.getElements("p@text")')).toBe('unsupported_js'); // 取文本不是取节点
    expect(rejected('java.getElements("$.a")')).toBe('unsupported_js');
    expect(rejected('var r = "p"; java.getElements(r)')).toBe('unsupported_js');
    expect(rejected('java.getElements("p", 1)')).toBe('unsupported_js');
    expect(rejected('java.getElements("p").text() + java.ajax("x")')).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule('@js:java.getElements("p").text()', { jsEnabled: false, jsoupEnabled: true, field: CONTENT })))
      .toBe('unsupported_js');
    // init 不走 jsoup 重试
    expect(codeOf(() => on('@js:java.getElements("p").text()', 'ruleBookInfo.init', { initJsEnabled: true }))).toBe('unsupported_js');
    // jsoup 帧里的 {{}} 模板段保守拒
    expect(codeOf(() => on('@js:java.getElements("p").text() + "{{@@#c@text}}"', CONTENT, { jsExtEnabled: true }))).toBe('unsupported_js');
  });

  it('列表链：首段规则 + JS 只在 jsoup 下放行，首段须取节点', () => {
    const opts = { listJsEnabled: true };
    expect(codeOf(() => off('.item@js:result', LIST, opts))).toBe('unsupported_js');
    expect(on('.item@js:result', LIST, opts).jsoup).toBe(true);
    expect(codeOf(() => on('.item@text@js:result', LIST, opts))).toBe('unsupported_js');
    expect(codeOf(() => on('$.list@js:result', LIST, opts))).toBe('unsupported_js');
  });
});

describe('求值', () => {
  it('getElements 在字段作用域上取 Elements；Elements/Element 方法', async () => {
    await preloadJsSandbox();
    expect(value(on('@js:java.getElements("p").text()', CONTENT), PAGE)).toBe('甲 乙');
    expect(value(on('@js:java.getElements("p").size() + "|" + java.getElements("p").get(1).className()', CONTENT), PAGE)).toBe('2|x');
    expect(value(on('@js:java.getElement("#c").select("p.x").first().text()', CONTENT), PAGE)).toBe('乙');
    expect(value(on('@js:java.getElements("li a").attr("href")', CONTENT), PAGE)).toBe('/b/1');
    expect(value(on('@js:java.getElements("#none").isEmpty()', CONTENT), PAGE)).toBe('true');
  });

  it('Java 字符串：typeof object、length 是方法；JS 字符串化后可照常用', async () => {
    await preloadJsSandbox();
    expect(value(on('@js:typeof java.getElements("p").text()', CONTENT), PAGE)).toBe('object');
    expect(value(on('@js:java.getElements("p").text().length()', CONTENT), PAGE)).toBe('3');
    expect(value(on('@js:String(java.getElements("p").text()).length', CONTENT), PAGE)).toBe('3');
    expect(codeOf(() => value(on('@js:java.getElements("p").text().length + 1', CONTENT), PAGE))).toBe('RULE_EVAL_FAILED');
  });

  it('末段 Element/Elements 按 outerHtml 取字符串', async () => {
    await preloadJsSandbox();
    expect(value(on('@js:java.getElements("p.x").first()', CONTENT), PAGE)).toBe('<p class="x">乙</p>');
  });

  it('Java 字符串交给下一段 JS 失败，String() 之后可以', async () => {
    await preloadJsSandbox();
    expect(codeOf(() => value(on('<js>java.getElements("p").text()</js><js>result + "x"</js>', CONTENT), PAGE))).toBe('RULE_EVAL_FAILED');
    expect(value(on('<js>String(java.getElements("p").text())</js><js>result + "x"</js>', CONTENT), PAGE)).toBe('甲 乙x');
  });

  it('Jsoup.parse 建新文档（含 Packages 前缀）', async () => {
    await preloadJsSandbox();
    expect(value(on('@js:org.jsoup.Jsoup.parse("<b>x</b><b>y</b>").select("b").text()', CONTENT), PAGE)).toBe('x y');
    expect(value(on('#c@html@js:Packages.org.jsoup.Jsoup.parse(result).select("p").size()', CONTENT), PAGE)).toBe('2');
  });

  it('JS 里 catch 掉的宿主失败照旧致命；未知成员致命', async () => {
    await preloadJsSandbox();
    expect(codeOf(() => value(on('@js:try { java.getElements("p").foo() } catch (e) {} "ok"', CONTENT), PAGE))).toBe('RULE_EVAL_FAILED');
    expect(codeOf(() => value(on('@js:java.getElements("p").map(function (x) { return x; })', CONTENT), PAGE))).toBe('RULE_EVAL_FAILED');
  });

  it('白名单外的键求值失败', async () => {
    await preloadJsSandbox();
    const field = on('@js:java.getElements("p").text()', CONTENT);
    const forged: FieldIr = { ...field, jsElements: new Map() };
    expect(codeOf(() => value(forged, PAGE))).toBe('RULE_EVAL_FAILED');
  });

  it('条目级：result/src 是条目 Element', async () => {
    await preloadJsSandbox();
    const items = evaluateFieldList(parseFieldRule('.item', { field: LIST }), scopeOf(PAGE));
    const name = on('@js:result.selectFirst("a").text() + "|" + src.hasClass("on")', NAME);
    expect(items.map((item) => evaluateField(name, item))).toEqual(['一|false', '二|true']);
    // 条目级 getElements 作用域是条目
    const count = on('@js:java.getElements("a").size()', NAME);
    expect(items.map((item) => evaluateField(count, item))).toEqual(['1', '1']);
  });

  it('列表链：首段规则的 Elements 交给 JS；JS 返回 Elements/Element 数组作条目', async () => {
    await preloadJsSandbox();
    const page = scopeOf(PAGE);
    const name = parseFieldRule('a@text', { field: NAME });
    const opts = { listJsEnabled: true };
    const all = evaluateFieldList(on('.item@js:result', LIST, opts), page);
    expect(all.map((item) => evaluateField(name, item))).toEqual(['一', '二']);
    const picked = evaluateFieldList(on('.item@js:var out = []; result.forEach(function (e) { if (e.hasClass("on")) out.push(e); }); out', LIST, opts), page);
    expect(picked.map((item) => evaluateField(name, item))).toEqual(['二']);
    expect(codeOf(() => evaluateFieldList(on('.item@js:result.text()', LIST, opts), page))).toBe('RULE_EVAL_FAILED');
  });
});
