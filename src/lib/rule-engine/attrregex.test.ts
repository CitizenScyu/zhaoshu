// attrregex1030：jsoup `[k~=re]` 是属性值正则 find（ENGINE_SYNTAX_ATTR_REGEX）——改写成属性正则伪类求值。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { rewriteLegadoAttrRegex } from './attr-regex';
import { engineSourceRevision, sourceUsesAttrRegexSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule, ruleMayUseAttrRegex } from './parse';
import { ENGINE_SEMANTICS_ATTR_REGEX_BIT, engineSemanticsVersion, engineSyntaxAttrRegexEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成属性正则验证不能访问数据库'); } }));

const SITE = 'https://ar30.test';
const opts = (attrRegexEnabled: boolean, field: string) => ({ field, orEnabled: true, andEnabled: true, regexEnabled: true, attrRegexEnabled });
const META_PAGE = '<html><head><meta property="og:novel:category" content="玄幻">'
  + '<meta property="og:novel:status" content="连载"><meta property="og:novel:author" content="某甲">'
  + '<meta property="og:novel:latest_chapter_name" content="第九章"><meta property="og:novel:lastest_chapter_name" content="第八章">'
  + '</head><body><div class="info"><a href="/catalog/1.html">目录</a><a href="/book/1.html">书页</a>'
  + '<img src="https://img.ar30.test/a/1.JPG"><img src="/x/2.png"></div></body></html>';
const scope = (html: string) => createScope(normalizeBody(html), `${SITE}/b/1`);
const field = (rule: string, on: boolean, name = 'ruleBookInfo.kind') => evaluateField(parseFieldRule(rule, opts(on, name)), scope(META_PAGE));

describe('开关', () => {
  it('engineSyntaxAttrRegexEnabled 严格口径', () => {
    expect(engineSyntaxAttrRegexEnabled({})).toBe(false);
    expect(engineSyntaxAttrRegexEnabled({ ENGINE_SYNTAX_ATTR_REGEX: '0' })).toBe(false);
    expect(engineSyntaxAttrRegexEnabled({ ENGINE_SYNTAX_ATTR_REGEX: 'yes' })).toBe(false);
    expect(engineSyntaxAttrRegexEnabled({ ENGINE_SYNTAX_ATTR_REGEX: ' On ' })).toBe(true);
    expect(engineSyntaxAttrRegexEnabled({ ENGINE_SYNTAX_ATTR_REGEX: 'true' })).toBe(true);
  });
});

describe('改写口径', () => {
  it('顶层 [k~=re] 改写成伪类，其余逐字不变', () => {
    expect(rewriteLegadoAttrRegex('[property~=category|status]')).toMatch(/^:-nf-attr-re\([0-9a-f]+\)$/);
    expect(rewriteLegadoAttrRegex('div.a > [src~=^https?://[a-z]+] img')).toMatch(/^div\.a > :-nf-attr-re\([0-9a-f]+\) img$/);
    for (const sel of ['div', '[k=v]', '[k*=a~=b]', ':not([k~=a])', 'p:contains([k~=a])', '[k~=a\\w]', '[k~=(?x)a]', '[~=a]', '[k~=a']) {
      expect(rewriteLegadoAttrRegex(sel)).toBe(sel);
    }
    // key 两端空白 trim，`~=` 之后不 trim（正则带前导空格）。
    expect(rewriteLegadoAttrRegex('[k ~= a b]x')).toMatch(/^:-nf-attr-re\([0-9a-f]+\)x$/);
  });
});

describe('求值', () => {
  const list = (rule: string, on: boolean) => evaluateFieldList(parseFieldRule(rule, opts(on, 'ruleToc.chapterList')), scope(META_PAGE));

  it('正则交替：on 按 find 命中（单值取首个非空），off 恒不中', () => {
    expect(field('[property~=category|status]@content', true)).toBe('玄幻');
    expect(list('[property~=category|status]', true)).toHaveLength(2);
    expect(field('[property~=category|status]@content', false)).toBe('');
  });

  it('las?test：on 两种拼写都中', () => {
    expect(field('[property~=las?test_chapter_name]@content', true, 'ruleBookInfo.lastChapter')).toBe('第九章');
    expect(list('meta[property~=las?test_chapter_name]', true)).toHaveLength(2);
  });

  it('正则含 [ ] 与 (?i)：on 按 jsoup 括号界与内联标志求值，off 选择器抛', () => {
    expect(field('img[src~=(?i)\\.jpg$]@src', true, 'ruleBookInfo.coverUrl')).toBe('https://img.ar30.test/a/1.JPG');
    expect(field('[src~=^https?://[a-z0-9.]+/]@src', true, 'ruleBookInfo.coverUrl')).toBe('https://img.ar30.test/a/1.JPG');
    expect(() => field('[src~=^https?://[a-z0-9.]+/]@src', false, 'ruleBookInfo.coverUrl')).toThrow(/选择器无法求值/);
  });

  it('不剥引号：带引号的正则按字面引号匹配', () => {
    expect(field('a[href~="catalog"]@href', true, 'ruleBookInfo.tocUrl')).toBe('');
    expect(field('a[href~=catalog]@href', true, 'ruleBookInfo.tocUrl')).toBe(`${SITE}/catalog/1.html`);
    expect(field('a[href~=catalog]@href', false, 'ruleBookInfo.tocUrl')).toBe('');
  });

  it('列表与 @css:', () => {
    const items = evaluateFieldList(parseFieldRule('@css:meta[property~=novel:(author|status)]', opts(true, 'ruleToc.chapterList')), scope(META_PAGE));
    expect(items).toHaveLength(2);
  });

  it('不含该写法的规则 IR 两态逐字相同', () => {
    for (const rule of ['div[style=a]@text', 'class.info@a@href', '[class="x y"]@text', '$.a~=b']) {
      expect(JSON.stringify(parseFieldRule(rule, opts(true, 'ruleSearch.name'))))
        .toBe(JSON.stringify(parseFieldRule(rule, opts(false, 'ruleSearch.name'))));
    }
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const LIST = '<ul><li data-kind="book-1"><a href="/b/1">书一</a></li><li data-kind="ad"><a href="/ad">广告</a></li>'
    + '<li data-kind="book-2"><a href="/b/2">书二</a></li></ul>';
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成属性正则源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: 'li[data-kind~=^book-\\d+$]', name: 'a@text', bookUrl: 'a@href' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(LIST, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    declaredHosts: new Set(['ar30.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选，off 不出', async () => {
    vi.stubEnv('ENGINE_SYNTAX_ATTR_REGEX', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    vi.stubEnv('ENGINE_SYNTAX_ATTR_REGEX', '0');
    expect((await run()).verdict).not.toBe('ok');
  });
});

describe('语义位', () => {
  const mk = (search: Record<string, string>) => ({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: '.books@li', name: 'h4@text', bookUrl: 'a@href', ...search }, ruleBookInfo: { kind: '[property~=category]@content' } },
  });

  it('2^44，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_ATTR_REGEX_BIT).toBe(17592186044416);
    // 第 42/43 个参数 = attrQuote / attrRegex，前 41 个全关。
    const flags = (quote: boolean, re: boolean) =>
      (engineSemanticsVersion as (...flags: boolean[]) => number)(...Array<boolean>(41).fill(false), quote, re);
    expect(flags(false, true) - flags(false, false)).toBe(17592186044416);
    expect(flags(true, true) - flags(true, false)).toBe(17592186044416);
  });

  it('准入搜索字段有会被改写的 [k~=re] 才计位；开关关不计', () => {
    expect(ruleMayUseAttrRegex('[property~=a|b]@content##x')).toBe(true);
    expect(ruleMayUseAttrRegex('h4@text##[k~=a]')).toBe(false);
    expect(ruleMayUseAttrRegex('$.a[?(@.k ~= a)]')).toBe(false);
    expect(ruleMayUseAttrRegex('[k~=a\\w]')).toBe(false);
    expect(sourceUsesAttrRegexSyntax(mk({ bookList: 'li[data-kind~=^book]' }).rules)).toBe(true);
    expect(sourceUsesAttrRegexSyntax(mk({}).rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, attrRegexEnabled: boolean) => Number(engineSourceRevision(s, { attrRegexEnabled }).split(':')[0]);
    const hit = mk({ bookList: 'li[data-kind~=^book]' });
    expect(v(hit, true) - v(hit, false)).toBe(17592186044416);
    expect(v(mk({}), true)).toBe(v(mk({}), false));
  });
});
