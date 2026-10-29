// selfmatch1029：legado Jsoup select / getElementsByClass / ByTag 含上下文自身（ENGINE_SYNTAX_SELF_MATCH）——子孙全不中时取自身匹配者。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesSelfMatchSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule } from './parse';
import { ENGINE_SEMANTICS_SELF_MATCH_BIT, engineSemanticsVersion, engineSyntaxSelfMatchEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成自身匹配验证不能访问数据库'); } }));

const SITE = 'https://cc54.test';
const on = (rule: string, field = 'ruleSearch.name') => parseFieldRule(rule, { field, orEnabled: true, selfMatchEnabled: true });
const off = (rule: string, field = 'ruleSearch.name') => parseFieldRule(rule, { field, orEnabled: true, selfMatchEnabled: false });
const HTML_PAGE = '<ul class="list"><li class="text-more"><a href="/c">分类</a><a href="/b/1">书一</a><a href="/z">作者一</a></li>'
  + '<li class="text-more"><a href="/c">分类</a><a href="/b/2">书二</a><a href="/z">作者二</a></li></ul>'
  + '<div id="cl"><a href="/1.html">第一章</a><a href="/2.html">第二章</a></div>'
  + '<div class="box"><div class="in"><a href="/i">内</a></div><a href="/o">外</a></div>';
const htmlScope = () => createScope(normalizeBody(HTML_PAGE), `${SITE}/s`);
const values = (list: string, field: string, parse: typeof on, name = 'ruleSearch.name', listField = 'ruleSearch.bookList') =>
  evaluateFieldList(parse(list, listField), htmlScope()).map((item) => evaluateField(parse(field, name), item));

describe('开关', () => {
  it('engineSyntaxSelfMatchEnabled 严格口径', () => {
    expect(engineSyntaxSelfMatchEnabled({})).toBe(false);
    expect(engineSyntaxSelfMatchEnabled({ ENGINE_SYNTAX_SELF_MATCH: '0' })).toBe(false);
    expect(engineSyntaxSelfMatchEnabled({ ENGINE_SYNTAX_SELF_MATCH: 'yes' })).toBe(false);
    expect(engineSyntaxSelfMatchEnabled({ ENGINE_SYNTAX_SELF_MATCH: ' On ' })).toBe(true);
    expect(engineSyntaxSelfMatchEnabled({ ENGINE_SYNTAX_SELF_MATCH: 'true' })).toBe(true);
  });

  it('语义位 2^39，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_SELF_MATCH_BIT).toBe(549755813888);
    const f = false;
    const flags = (bracket: boolean, self: boolean) => engineSemanticsVersion(
      f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, bracket, self);
    expect(flags(false, true) - flags(false, false)).toBe(549755813888);
    expect(flags(true, true) - flags(true, false)).toBe(549755813888);
  });
});

describe('编译与求值', () => {
  it('首段与条目同型：on 取到自身下的值，off 为空', () => {
    expect(values('li[class="text-more"]', 'li[class="text-more"]@a.1@text', on)).toEqual(['书一', '书二']);
    expect(values('li[class="text-more"]', 'li[class="text-more"]@a.1@text', off)).toEqual(['', '']);
    expect(values('class.list@tag.li', 'tag.li@tag.a.1@text', on)).toEqual(['书一', '书二']);
    expect(values('class.list@tag.li', 'tag.li@tag.a.1@href', on)).toEqual([`${SITE}/b/1`, `${SITE}/b/2`]);
    expect(values('class.list@tag.li', 'tag.li@tag.a.1@text', off)).toEqual(['', '']);
    expect(values('id.cl@a', 'a@text', on, 'ruleToc.chapterName', 'ruleToc.chapterList')).toEqual(['第一章', '第二章']);
    expect(values('id.cl@a', 'a@text', off, 'ruleToc.chapterName', 'ruleToc.chapterList')).toEqual(['', '']);
    expect(values('class.list@tag.li', '@css:li.text-more@text', on)).toEqual(['分类书一作者一', '分类书二作者二']);
    expect(values('class.list@tag.li', '@css:li.text-more@text', off)).toEqual(['', '']);
  });

  it('子孙有命中照旧；document 作用域与 filter 不认的选择器不抛错', () => {
    expect(values('class.box', 'tag.div@tag.a@text', on)).toEqual(values('class.box', 'tag.div@tag.a@text', off));
    expect(values('class.box', 'tag.div@tag.a@text', on)).toEqual(['内']);
    expect(evaluateField(on('tag.zz@text'), htmlScope())).toBe('');
    expect(values('class.list@tag.li', '@css:> b@text', on)).toEqual(values('class.list@tag.li', '@css:> b@text', off));
  });

  it('off 时 IR 不带 selfFallback；on 时每步都带', () => {
    for (const rule of ['class.list@tag.li', 'tag.li@tag.a.1@text', '@css:li a@href', 'text.甲@text']) {
      expect(JSON.stringify(off(rule))).not.toContain('selfFallback');
      expect(JSON.stringify(on(rule))).toContain('selfFallback');
    }
    expect(JSON.stringify(on('$.a.b'))).not.toContain('selfFallback');
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成自身匹配源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: 'class.list@tag.li', name: 'tag.li@tag.a.1@text', bookUrl: 'tag.li@tag.a.1@href' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    declaredHosts: new Set(['cc54.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选，off 不出', async () => {
    vi.stubEnv('ENGINE_SYNTAX_SELF_MATCH', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    vi.stubEnv('ENGINE_SYNTAX_SELF_MATCH', '0');
    expect((await run()).verdict).not.toBe('ok');
  });
});

describe('语义位判据', () => {
  const mk = (search: Record<string, string>, toc: Record<string, string> = {}) => ({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: 'class.list@tag.li', name: 'tag.a@text', bookUrl: 'tag.a@href', ...search }, ruleToc: toc },
  });

  it('搜索字段首段等于列表末段或是其中一个简单选择器才计位', () => {
    expect(sourceUsesSelfMatchSyntax(mk({ name: 'tag.li@tag.a.1@text' }).rules)).toBe(true);
    expect(sourceUsesSelfMatchSyntax(mk({ bookList: 'li[class="text-more"]', bookUrl: 'li[class="text-more"]@a.1@href' }).rules)).toBe(true);
    expect(sourceUsesSelfMatchSyntax(mk({ bookList: 'class.list@li.item', author: 'li@a.2@text' }).rules)).toBe(true);
    expect(sourceUsesSelfMatchSyntax(mk({ bookList: '@css:.list li', name: '@css:.list li@text' }).rules)).toBe(true);
    expect(sourceUsesSelfMatchSyntax(mk({ name: 'tag.p@text||tag.li@text' }).rules)).toBe(true);
    expect(sourceUsesSelfMatchSyntax(mk({}).rules)).toBe(false);
    expect(sourceUsesSelfMatchSyntax(mk({ name: '@js:result' }).rules)).toBe(false);
    expect(sourceUsesSelfMatchSyntax(mk({ bookList: '$.data[*]', name: '$.name' }).rules)).toBe(false);
    expect(sourceUsesSelfMatchSyntax(mk({}, { chapterList: 'id.cl@a', chapterName: 'a@text' }).rules)).toBe(false);
  });

  it('revision 位差；开关关不计', () => {
    const hit = mk({ name: 'tag.li@tag.a.1@text' });
    const miss = mk({});
    const v = (s: ReturnType<typeof mk>, selfMatchEnabled: boolean) => Number(engineSourceRevision(s, { selfMatchEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(549755813888);
    expect(v(miss, true)).toBe(v(miss, false));
  });
});
