// attrquote1030：jsoup `[k=v]` 值可含空格（ENGINE_SYNTAX_ATTR_QUOTE）——无引号、含空格的属性值改写成带 i 标志的引号串。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesAttrQuoteSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule, quoteLegadoAttrValues, ruleMayUseAttrQuote } from './parse';
import { ENGINE_SEMANTICS_ATTR_QUOTE_BIT, engineSemanticsVersion, engineSyntaxAttrQuoteEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成属性值含空白验证不能访问数据库'); } }));

const SITE = 'https://cc56.test';
const opts = (attrQuoteEnabled: boolean, field: string) => ({ field, orEnabled: true, andEnabled: true, regexEnabled: true, attrQuoteEnabled });
const CONTENT_PAGE = '<div class="nav">导航</div><div style="text-indent: 2em;"><p>第一段</p><p>第二段</p></div>'
  + '<div style="text-indent:2em">不算</div>';
const LIST_PAGE = '<ul><li class="tab-detail on"><a href="/b/1">书一</a></li><li class="tab-detail"><a href="/b/2">书二</a></li>'
  + '<li class="tab-detail on"><a href="/b/3">书三</a></li></ul>';
const scope = (html: string) => createScope(normalizeBody(html), `${SITE}/p`);

describe('开关', () => {
  it('engineSyntaxAttrQuoteEnabled 严格口径', () => {
    expect(engineSyntaxAttrQuoteEnabled({})).toBe(false);
    expect(engineSyntaxAttrQuoteEnabled({ ENGINE_SYNTAX_ATTR_QUOTE: '0' })).toBe(false);
    expect(engineSyntaxAttrQuoteEnabled({ ENGINE_SYNTAX_ATTR_QUOTE: 'yes' })).toBe(false);
    expect(engineSyntaxAttrQuoteEnabled({ ENGINE_SYNTAX_ATTR_QUOTE: ' On ' })).toBe(true);
    expect(engineSyntaxAttrQuoteEnabled({ ENGINE_SYNTAX_ATTR_QUOTE: 'true' })).toBe(true);
  });

  it('语义位 2^43，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_ATTR_QUOTE_BIT).toBe(8796093022208);
    const f = false;
    const flags = (doctype: boolean, quote: boolean) => engineSemanticsVersion(
      f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, doctype, quote);
    expect(flags(false, true) - flags(false, false)).toBe(8796093022208);
    expect(flags(true, true) - flags(true, false)).toBe(8796093022208);
  });
});

describe('改写口径', () => {
  it('无引号含空格的 = ^= $= *= 改写，其余逐字不变', () => {
    expect(quoteLegadoAttrValues('div[style=text-indent: 2em;]')).toBe('div[style="text-indent: 2em;" i]');
    expect(quoteLegadoAttrValues('[class = tab-detail on ] a')).toBe('[class="tab-detail on" i] a');
    expect(quoteLegadoAttrValues('[property$=Other categories]')).toBe('[property$="Other categories" i]');
    expect(quoteLegadoAttrValues('a[title^=第 1]>b[x*=y z]')).toBe('a[title^="第 1" i]>b[x*="y z" i]');
    for (const sel of [
      'div[style=a]', 'div[style="a b"]', "div[style='a b']", '[k=v i]', '[k=v s]', '[k~=a b]', '[k|=a b]', '[k!=a b]',
      ':not([k=a b])', 'p:contains([k=a b])', '[k=a\\ b]', '[k=a\tb]', 'div', '[k]', '[k=]', 'div[k=a b',
    ]) expect(quoteLegadoAttrValues(sel)).toBe(sel);
  });
});

describe('编译与求值', () => {
  it('正文：on 取到含空格 style 的节点（不分大小写），off 求值失败', () => {
    const on = evaluateField(parseFieldRule('div[style=text-indent: 2em;]@text', opts(true, 'ruleContent.content')), scope(CONTENT_PAGE));
    expect(on).toContain('第一段');
    expect(on).not.toContain('不算');
    const upper = scope('<div style="text-indent:2em">不算</div><div style="TEXT-INDENT: 2EM;">第三段</div>');
    expect(evaluateField(parseFieldRule('div[style=text-indent: 2em;]@text', opts(true, 'ruleContent.content')), upper)).toBe('第三段');
    expect(() => evaluateField(parseFieldRule('div[style=text-indent: 2em;]@text', opts(false, 'ruleContent.content')), scope(CONTENT_PAGE)))
      .toThrow();
  });

  it('@css: 段与 [!…] 排除后缀同样改写', () => {
    const names = (rule: string, on: boolean) => evaluateFieldList(parseFieldRule(rule, opts(on, 'ruleSearch.bookList')), scope(LIST_PAGE))
      .map((item) => evaluateField(parseFieldRule('a@text', opts(on, 'ruleSearch.name')), item));
    expect(names('[class=tab-detail on]', true)).toEqual(['书一', '书三']);
    expect(names('@css:li[class=tab-detail on]', true)).toEqual(['书一', '书三']);
    expect(names('li[class=tab-detail on]!0', true)).toEqual(['书三']);
  });

  it('不含该写法的规则 IR 两态逐字相同', () => {
    for (const rule of ['div[style=a]@text', 'class.tab-detail on@a@href', '[class="x y"]@text', 'text.第 1@text', '$.a[?(@.b == "c d")]']) {
      expect(JSON.stringify(parseFieldRule(rule, opts(true, 'ruleSearch.name'))))
        .toBe(JSON.stringify(parseFieldRule(rule, opts(false, 'ruleSearch.name'))));
    }
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成属性值含空白源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: '[class=tab-detail on]', name: 'a@text', bookUrl: 'a@href' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(LIST_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    declaredHosts: new Set(['cc56.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选，off 不出', async () => {
    vi.stubEnv('ENGINE_SYNTAX_ATTR_QUOTE', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    vi.stubEnv('ENGINE_SYNTAX_ATTR_QUOTE', '0');
    expect((await run()).verdict).not.toBe('ok');
  });
});

describe('语义位判据', () => {
  const mk = (search: Record<string, string>) => ({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: '.books@li', name: 'h4@text', bookUrl: 'a@href', ...search }, ruleContent: { content: 'div[style=a b]@html' } },
  });

  it('准入搜索字段有会被改写的值才计位', () => {
    expect(ruleMayUseAttrQuote('div[style=a b]@html##x')).toBe(true);
    expect(ruleMayUseAttrQuote('h4@text##[k=a b]')).toBe(false);
    expect(ruleMayUseAttrQuote('$.a[?(@.k == a b)]')).toBe(false);
    expect(ruleMayUseAttrQuote('div[style="a b"]')).toBe(false);
    expect(sourceUsesAttrQuoteSyntax(mk({ bookList: '[class=tab-detail on]' }).rules)).toBe(true);
    expect(sourceUsesAttrQuoteSyntax(mk({ author: 'span[title=a b]@text' }).rules)).toBe(true);
    expect(sourceUsesAttrQuoteSyntax(mk({}).rules)).toBe(false);
  });

  it('revision 位差；开关关不计', () => {
    const hit = mk({ bookList: '[class=tab-detail on]' });
    const miss = mk({});
    const v = (s: ReturnType<typeof mk>, attrQuoteEnabled: boolean) => Number(engineSourceRevision(s, { attrQuoteEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(8796093022208);
    expect(v(miss, true)).toBe(v(miss, false));
  });
});
