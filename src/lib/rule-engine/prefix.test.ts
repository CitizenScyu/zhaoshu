// prefix1029：规则前缀按 legado SourceRule 忽略大小写判模式（ENGINE_SYNTAX_RULE_PREFIX）——`@Json:` 走 Jayway、`@CSS:` 同 `@css:`。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesRulePrefixSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { normalizeRulePrefix, parseFieldRule, ruleMayUseRulePrefix } from './parse';
import { ENGINE_SEMANTICS_RULE_PREFIX_BIT, engineSemanticsVersion, engineSyntaxRulePrefixEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成前缀验证不能访问数据库'); } }));

const SITE = 'https://cc53.test';
const on = (rule: string, field = 'ruleSearch.name', extra = {}) => parseFieldRule(rule, { field, rulePrefixEnabled: true, orEnabled: true, ...extra });
const off = (rule: string, field = 'ruleSearch.name', extra = {}) => parseFieldRule(rule, { field, rulePrefixEnabled: false, orEnabled: true, ...extra });
const JSON_PAGE = JSON.stringify({ ok: true, data: { books: [{ title: '甲', id: 'b_1' }, { title: '乙', id: 'b_2' }] } });
const HTML_PAGE = '<div class="b"><a href="/b/1.html">甲</a></div><div class="b"><a href="/b/2.html">乙</a></div>';
const jsonScope = () => createScope(normalizeBody(JSON_PAGE), `${SITE}/s`);
const htmlScope = () => createScope(normalizeBody(HTML_PAGE), `${SITE}/s`);

describe('开关', () => {
  it('engineSyntaxRulePrefixEnabled 严格口径', () => {
    expect(engineSyntaxRulePrefixEnabled({})).toBe(false);
    expect(engineSyntaxRulePrefixEnabled({ ENGINE_SYNTAX_RULE_PREFIX: '0' })).toBe(false);
    expect(engineSyntaxRulePrefixEnabled({ ENGINE_SYNTAX_RULE_PREFIX: 'yes' })).toBe(false);
    expect(engineSyntaxRulePrefixEnabled({ ENGINE_SYNTAX_RULE_PREFIX: ' On ' })).toBe(true);
    expect(engineSyntaxRulePrefixEnabled({ ENGINE_SYNTAX_RULE_PREFIX: 'true' })).toBe(true);
  });

  it('语义位 2^36，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_RULE_PREFIX_BIT).toBe(68719476736);
    const f = false;
    const flags = (last: boolean, prefix: boolean) => engineSemanticsVersion(
      f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, last, prefix);
    expect(flags(false, true) - flags(false, false)).toBe(68719476736);
    expect(flags(true, true) - flags(true, false)).toBe(68719476736);
  });
});

describe('归一', () => {
  it('@Json: 剥掉、各支补 $ 路径，## 尾缀原样；@CSS: 规范成小写', () => {
    expect(normalizeRulePrefix('@JSon:$..books[*]')).toBe('$..books[*]');
    expect(normalizeRulePrefix('@Json:data.books[*]')).toBe('$.data.books[*]');
    expect(normalizeRulePrefix('@json:[0].title')).toBe('$[0].title');
    expect(normalizeRulePrefix('@JSON:title||$.name##甲##丙')).toBe('$.title||$.name##甲##丙');
    expect(normalizeRulePrefix('@Json:a && b')).toBe('$.a&&$.b');
    expect(normalizeRulePrefix('@CSS:div.b a@text')).toBe('@css:div.b a@text');
    expect(normalizeRulePrefix("@Json:$.list[?(@.type == 'x' || @.hot)]")).toBe("$.list[?(@.type == 'x' || @.hot)]");
  });

  it('不收的形态原样返回（同 off）', () => {
    for (const rule of ['@css:div.b', '@Json:', '@Json:{$.a}-{$.b}', '@Json:$.a%%$.b', '@Json:$.a@put:{k:$.b}', '@Json:@.a', '@Json:$.a||', 'class.b@text', '$.title']) {
      expect(normalizeRulePrefix(rule)).toBe(rule);
    }
  });
});

describe('编译与求值', () => {
  it('@Json: on 编成 JSONPath、取到值；off 被当成默认语法选择器、取空', () => {
    for (const rule of ['@JSon:$..books[*]', '@Json:data.books[*]', '@json:$.data.books[*]']) {
      expect(evaluateFieldList(on(rule, 'ruleSearch.bookList'), jsonScope())).toHaveLength(2);
      expect(evaluateFieldList(off(rule, 'ruleSearch.bookList'), jsonScope())).toHaveLength(0);
    }
    const item = evaluateFieldList(on('@JSon:$..books[*]', 'ruleSearch.bookList'), jsonScope())[0];
    expect(evaluateField(on('@Json:title'), item)).toBe('甲');
    expect(evaluateField(on('@Json:$.id##b_##', 'ruleSearch.bookUrl', { regexEnabled: true }), item)).toBe('1');
    expect(evaluateField(off('@Json:title'), item)).toBe('');
  });

  it('@CSS: on 与小写 @css: 同 IR；off 照旧当选择器', () => {
    expect(on('@CSS:div.b a@text')).toEqual(off('@css:div.b a@text'));
    expect(evaluateField(on('@CSS:div.b a@text'), htmlScope())).toBe('甲');
    expect(() => evaluateField(off('@CSS:div.b a@text'), htmlScope())).toThrow(); // off：`CSS:div.b a` 当选择器求值失败
  });

  it('无前缀、小写 @css: 与不收的形态两态 IR 相同', () => {
    for (const rule of ['class.b@a@text', '@css:div.b a@text', '$.data.books[0].title', '@Json:{$.a}', '@@div.b@a@text']) {
      expect(on(rule)).toEqual(off(rule));
    }
  });

  it('JS 链规则段同样归一', async () => {
    await preloadJsSandbox();
    const rule = '@Json:$.data.books[0].title@js:result + "!"';
    expect(evaluateField(on(rule, 'ruleBookInfo.name', { jsEnabled: true }), jsonScope())).toBe('甲!');
    expect(evaluateField(off(rule, 'ruleBookInfo.name', { jsEnabled: true }), jsonScope())).toBe('!');
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成前缀源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: '@JSon:$..books[*]', name: '@Json:title', bookUrl: '@JSON:id' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(JSON_PAGE, { headers: { 'Content-Type': 'application/json' } }),
    declaredHosts: new Set(['cc53.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选，off no_result', async () => {
    vi.stubEnv('ENGINE_SYNTAX_RULE_PREFIX', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    vi.stubEnv('ENGINE_SYNTAX_RULE_PREFIX', '0');
    expect(await run()).toMatchObject({ verdict: 'no_result', candidateCount: 0 });
  });
});

describe('语义位判据', () => {
  it('ruleMayUseRulePrefix：任意大小写 @json:、非小写 @css:', () => {
    expect(ruleMayUseRulePrefix('@JSon:$.a')).toBe(true);
    expect(ruleMayUseRulePrefix('@json:$.a')).toBe(true);
    expect(ruleMayUseRulePrefix('<js>x</js>@CSS:div')).toBe(true);
    expect(ruleMayUseRulePrefix('@css:div')).toBe(false);
    expect(ruleMayUseRulePrefix('$.a')).toBe(false);
  });

  it('只有搜索 bookList/name/author/bookUrl 计位；开关关不计', () => {
    const mk = (search: Record<string, string>, toc: Record<string, string> = {}) => ({
      url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: { ruleSearch: { bookList: '.b', name: 'a@text', bookUrl: 'a@href', ...search }, ruleToc: toc },
    });
    const hit = mk({ bookList: '@JSon:$..books[*]' });
    const tocOnly = mk({}, { chapterList: '@Json:$.list[*]', chapterUrl: 'url' });
    expect(sourceUsesRulePrefixSyntax(hit.rules)).toBe(true);
    expect(sourceUsesRulePrefixSyntax(tocOnly.rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, rulePrefixEnabled: boolean) => Number(engineSourceRevision(s, { rulePrefixEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(68719476736);
    expect(v(tocOnly, true)).toBe(v(tocOnly, false));
  });
});
