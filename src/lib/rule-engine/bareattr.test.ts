// bareattr1029：legado getString 对单段规则取上下文自身属性（ENGINE_SYNTAX_BARE_ATTR）——单段裸名选不到节点时改取同名属性。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesBareAttrSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule, ruleMayUseBareAttr } from './parse';
import { ENGINE_SEMANTICS_BARE_ATTR_BIT, engineSemanticsVersion, engineSyntaxBareAttrEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成裸名属性验证不能访问数据库'); } }));

const SITE = 'https://cc55.test';
const opts = (bareAttrEnabled: boolean, field: string) => ({ field, orEnabled: true, andEnabled: true, regexEnabled: true, bareAttrEnabled });
const HTML_PAGE = '<ul class="books"><li onclick="go(11)" data-id="b1"><h4>书一</h4><span>作者一</span></li>'
  + '<li onclick="go(22)" data-id="b2"><h4>书二</h4><span>作者二</span></li></ul>';
const htmlScope = () => createScope(normalizeBody(HTML_PAGE), `${SITE}/s`);
const values = (rule: string, on: boolean, field = 'ruleSearch.bookUrl') =>
  evaluateFieldList(parseFieldRule('.books@li', opts(on, 'ruleSearch.bookList')), htmlScope())
    .map((item) => evaluateField(parseFieldRule(rule, opts(on, field)), item));

describe('开关', () => {
  it('engineSyntaxBareAttrEnabled 严格口径', () => {
    expect(engineSyntaxBareAttrEnabled({})).toBe(false);
    expect(engineSyntaxBareAttrEnabled({ ENGINE_SYNTAX_BARE_ATTR: '0' })).toBe(false);
    expect(engineSyntaxBareAttrEnabled({ ENGINE_SYNTAX_BARE_ATTR: 'yes' })).toBe(false);
    expect(engineSyntaxBareAttrEnabled({ ENGINE_SYNTAX_BARE_ATTR: ' On ' })).toBe(true);
    expect(engineSyntaxBareAttrEnabled({ ENGINE_SYNTAX_BARE_ATTR: 'true' })).toBe(true);
  });

  it('语义位 2^40，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_BARE_ATTR_BIT).toBe(1099511627776);
    const f = false;
    const flags = (self: boolean, bare: boolean) => engineSemanticsVersion(
      f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, self, bare);
    expect(flags(false, true) - flags(false, false)).toBe(1099511627776);
    expect(flags(true, true) - flags(true, false)).toBe(1099511627776);
  });
});

describe('编译与求值', () => {
  it('单段裸名：on 取条目自身属性（## 照旧），off 为空', () => {
    expect(values('onclick', true)).toEqual(['go(11)', 'go(22)']);
    expect(values('onclick##go##/b/', true)).toEqual(['/b/(11)', '/b/(22)']);
    expect(values('data-id', true)).toEqual(['b1', 'b2']);
    expect(values('nope||onclick', true)).toEqual(['go(11)', 'go(22)']);
    expect(values('onclick', false)).toEqual(['', '']);
    expect(values('data-id', false)).toEqual(['', '']);
  });

  it('选得到节点的单段照旧；标签名、终端关键字、多段与非字符串字段不挂', () => {
    expect(values('h4', true, 'ruleSearch.name')).toEqual(values('h4', false, 'ruleSearch.name'));
    expect(values('h4', true, 'ruleSearch.name')).toEqual(['书一', '书二']);
    for (const rule of ['h4', 'span', 'text', 'href', 'li@onclick', '@css:onclick', '$.onclick']) {
      expect(JSON.stringify(parseFieldRule(rule, opts(true, 'ruleSearch.bookUrl')))).not.toContain('bareAttr');
    }
    for (const field of ['ruleSearch.bookList', 'ruleSearch.kind', 'ruleToc.nextTocUrl']) {
      expect(JSON.stringify(parseFieldRule('onclick', opts(true, field)))).not.toContain('bareAttr');
    }
    expect(JSON.stringify(parseFieldRule('onclick', opts(false, 'ruleSearch.bookUrl')))).not.toContain('bareAttr');
  });

  it('JSON 条目照旧按键取', () => {
    const scope = createScope(normalizeBody('{"list":[{"name":"n1","onclick":"j1"}]}'), `${SITE}/s`);
    const [item] = evaluateFieldList(parseFieldRule('$.list[*]', opts(true, 'ruleSearch.bookList')), scope);
    expect(evaluateField(parseFieldRule('onclick', opts(true, 'ruleSearch.bookUrl')), item)).toBe('j1');
    expect(evaluateField(parseFieldRule('name', opts(true, 'ruleSearch.name')), item)).toBe('n1');
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成裸名属性源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: '.books@li', name: 'h4@text', author: 'span@text', bookUrl: 'onclick##.+\\((\\d+)\\)##/book/$1' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    declaredHosts: new Set(['cc55.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选，off 不出', async () => {
    vi.stubEnv('ENGINE_SYNTAX_BARE_ATTR', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 2 });
    vi.stubEnv('ENGINE_SYNTAX_BARE_ATTR', '0');
    expect((await run()).verdict).not.toBe('ok');
  });
});

describe('语义位判据', () => {
  const mk = (search: Record<string, string>) => ({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: '.books@li', name: 'h4@text', bookUrl: 'a@href', ...search }, ruleToc: { chapterName: 'title' } },
  });

  it('搜索字段某支是单段裸名、列表非 JSONPath 才计位', () => {
    expect(ruleMayUseBareAttr('onclick##x##y')).toBe(true);
    expect(ruleMayUseBareAttr('h4@text||data-id')).toBe(true);
    expect(ruleMayUseBareAttr('h4')).toBe(false);
    expect(ruleMayUseBareAttr('@js:onclick')).toBe(false);
    expect(sourceUsesBareAttrSyntax(mk({ bookUrl: 'onclick##.+(\\d+)##/b/$1' }).rules)).toBe(true);
    expect(sourceUsesBareAttrSyntax(mk({ author: 'title' }).rules)).toBe(false);
    expect(sourceUsesBareAttrSyntax(mk({}).rules)).toBe(false);
    expect(sourceUsesBareAttrSyntax(mk({ bookList: '$.data[*]', name: 'bookName' }).rules)).toBe(false);
    expect(sourceUsesBareAttrSyntax(mk({ bookList: '@json:$.data[*]', name: 'bookName' }).rules)).toBe(false);
  });

  it('revision 位差；开关关不计', () => {
    const hit = mk({ bookUrl: 'onclick' });
    const miss = mk({});
    const v = (s: ReturnType<typeof mk>, bareAttrEnabled: boolean) => Number(engineSourceRevision(s, { bareAttrEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(1099511627776);
    expect(v(miss, true)).toBe(v(miss, false));
  });
});
