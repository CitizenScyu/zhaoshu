// children1030：legado `children` 段是 temp.children()（ENGINE_SYNTAX_CHILDREN）——逐上下文元素取直接子元素、各自套索引。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesChildrenSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule, ruleMayUseChildren } from './parse';
import { ENGINE_SEMANTICS_CHILDREN_BIT, engineSemanticsVersion, engineSyntaxChildrenEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成 children 验证不能访问数据库'); } }));

const SITE = 'https://ch30.test';
const opts = (childrenEnabled: boolean, field: string) => ({ field, orEnabled: true, andEnabled: true, regexEnabled: true, childrenEnabled });
const TOC_PAGE = '<html><body><table class="b_bor">'
  + '<tr><td>表头</td></tr><tr><td>说明</td></tr><tr><td>广告</td></tr><tr><td>分隔</td></tr>'
  + '<tr><td><a href="/c/1.html">第一章</a></td></tr><tr><td><a href="/c/2.html">第二章</a></td></tr>'
  + '</table><div class="lib"><p><a href="/b/1">书一</a></p><p><a href="/b/2">书二</a></p></div>'
  + '<div class="lib"><p><a href="/b/3">书三</a></p><span><a href="/b/4">书四</a></span></div>'
  + '<div id="content"><p>甲段</p><p>乙段</p></div></body></html>';
const scope = () => createScope(normalizeBody(TOC_PAGE), `${SITE}/b/1`);
const list = (rule: string, on: boolean, field = 'ruleToc.chapterList') => evaluateFieldList(parseFieldRule(rule, opts(on, field)), scope());
const one = (rule: string, on: boolean, field: string) => evaluateField(parseFieldRule(rule, opts(on, field)), scope());

describe('开关', () => {
  it('engineSyntaxChildrenEnabled 严格口径', () => {
    expect(engineSyntaxChildrenEnabled({})).toBe(false);
    expect(engineSyntaxChildrenEnabled({ ENGINE_SYNTAX_CHILDREN: '0' })).toBe(false);
    expect(engineSyntaxChildrenEnabled({ ENGINE_SYNTAX_CHILDREN: 'yes' })).toBe(false);
    expect(engineSyntaxChildrenEnabled({ ENGINE_SYNTAX_CHILDREN: ' On ' })).toBe(true);
    expect(engineSyntaxChildrenEnabled({ ENGINE_SYNTAX_CHILDREN: 'true' })).toBe(true);
  });
});

describe('求值', () => {
  it('table→tbody 子元素再取 tr 排除前四：on 两章，off 空', () => {
    expect(list('class.b_bor@children@tr!0:1:2:3@a', true)).toHaveLength(2);
    expect(list('class.b_bor@children@tr!0:1:2:3@a', false)).toHaveLength(0);
  });

  it('多上下文元素：逐元素取子元素并按序拼接', () => {
    expect(list('class.lib@children', true, 'ruleSearch.bookList')).toHaveLength(4);
    expect(list('class.lib@children', false, 'ruleSearch.bookList')).toHaveLength(0);
  });

  it('索引逐上下文元素各自套用（legado 逐 temp 取）', () => {
    const items = list('class.lib@children.0', true);
    expect(items).toHaveLength(2);
    expect(list('class.lib@children!0', true)).toHaveLength(2);
    const bracket = parseFieldRule('class.lib@children[-1]', { ...opts(true, 'ruleToc.chapterList'), bracketIndexEnabled: true });
    expect(evaluateFieldList(bracket, scope())).toHaveLength(2);
  });

  it('中段 children 后接末端', () => {
    expect(one('id.content@children@text', true, 'ruleContent.content')).toContain('甲段');
    expect(one('id.content@children.1@text', true, 'ruleContent.content')).toBe('乙段');
    expect(one('id.content@children@text', false, 'ruleContent.content')).toBe('');
  });

  it('不含 children 段的规则 IR 两态逐字相同', () => {
    for (const rule of ['class.lib@p', 'tag.children@a', 'children-x@text', '@css:children', '$.children']) {
      expect(JSON.stringify(parseFieldRule(rule, opts(true, 'ruleSearch.bookList'))))
        .toBe(JSON.stringify(parseFieldRule(rule, opts(false, 'ruleSearch.bookList'))));
    }
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const LIST = '<div class="librarylist"><div><a href="/b/1">书一</a></div><div><a href="/b/2">书二</a></div></div>';
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成 children 源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: 'class.librarylist@children', name: 'a@text', bookUrl: 'a@href' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(LIST, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    declaredHosts: new Set(['ch30.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选，off 不出', async () => {
    vi.stubEnv('ENGINE_SYNTAX_CHILDREN', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    vi.stubEnv('ENGINE_SYNTAX_CHILDREN', '0');
    expect((await run()).verdict).not.toBe('ok');
  });
});

describe('语义位', () => {
  const mk = (search: Record<string, string>) => ({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: '.books@li', name: 'h4@text', bookUrl: 'a@href', ...search }, ruleToc: { chapterList: 'id.list@children' } },
  });

  it('2^45，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_CHILDREN_BIT).toBe(35184372088832);
    // 第 43/44 个参数 = attrRegex / children，前 42 个全关。
    const flags = (re: boolean, ch: boolean) =>
      (engineSemanticsVersion as (...flags: boolean[]) => number)(...Array<boolean>(42).fill(false), re, ch);
    expect(flags(false, true) - flags(false, false)).toBe(35184372088832);
    expect(flags(true, true) - flags(true, false)).toBe(35184372088832);
  });

  it('准入搜索字段有 children 段才计位；开关关不计', () => {
    expect(ruleMayUseChildren('class.a@children##x')).toBe(true);
    expect(ruleMayUseChildren('class.a@children!0:1||class.b@li')).toBe(true);
    expect(ruleMayUseChildren('class.a@children[0,1]@text')).toBe(true);
    expect(ruleMayUseChildren('tag.children@a')).toBe(false);
    expect(ruleMayUseChildren('@css:div > children')).toBe(false);
    expect(ruleMayUseChildren('h4@text##children')).toBe(false);
    expect(sourceUsesChildrenSyntax(mk({ bookList: 'class.l@children' }).rules)).toBe(true);
    expect(sourceUsesChildrenSyntax(mk({}).rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, childrenEnabled: boolean) => Number(engineSourceRevision(s, { childrenEnabled }).split(':')[0]);
    const hit = mk({ bookList: 'class.l@children' });
    expect(v(hit, true) - v(hit, false)).toBe(35184372088832);
    expect(v(mk({}), true)).toBe(v(mk({}), false));
  });
});
