// bracket1029：默认语法段末的 legado `[…]` 索引（ENGINE_SYNTAX_BRACKET_INDEX）——ElementsSingle.findIndexSet 口径。
// 规则与页面均为合成形态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission } from './admission';
import { engineSourceRevision, sourceUsesBracketIndexSyntax } from './compile';
import { legadoIndexes } from './dom-ops';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { legadoIndexSet, parseFieldRule, ruleMayUseBracketIndex } from './parse';
import { ENGINE_SEMANTICS_BRACKET_INDEX_BIT, engineSemanticsVersion, engineSyntaxBracketIndexEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成索引验证不能访问数据库'); } }));

const SITE = 'https://cc53.test';
const on = (rule: string, field = 'ruleSearch.bookList') => parseFieldRule(rule, { field, orEnabled: true, bracketIndexEnabled: true });
const off = (rule: string, field = 'ruleSearch.bookList') => parseFieldRule(rule, { field, orEnabled: true, bracketIndexEnabled: false });
const HTML_PAGE = '<ul class="list"><li><a href="/b/0">表头</a></li><li><a href="/b/1">甲</a></li><li><a href="/b/2">乙</a></li>'
  + '<li><a href="/b/3">丙</a></li></ul>';
const htmlScope = () => createScope(normalizeBody(HTML_PAGE), `${SITE}/s`);
const names = (rule: string) => evaluateFieldList(on(rule), htmlScope())
  .map((item) => evaluateField(parseFieldRule('tag.a@text', { field: 'ruleSearch.name' }), item));

describe('开关', () => {
  it('engineSyntaxBracketIndexEnabled 严格口径', () => {
    expect(engineSyntaxBracketIndexEnabled({})).toBe(false);
    expect(engineSyntaxBracketIndexEnabled({ ENGINE_SYNTAX_BRACKET_INDEX: '0' })).toBe(false);
    expect(engineSyntaxBracketIndexEnabled({ ENGINE_SYNTAX_BRACKET_INDEX: 'yes' })).toBe(false);
    expect(engineSyntaxBracketIndexEnabled({ ENGINE_SYNTAX_BRACKET_INDEX: ' On ' })).toBe(true);
    expect(engineSyntaxBracketIndexEnabled({ ENGINE_SYNTAX_BRACKET_INDEX: 'true' })).toBe(true);
  });

  it('语义位 2^38，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_BRACKET_INDEX_BIT).toBe(274877906944);
    const f = false;
    const flags = (hash: boolean, bracket: boolean) => engineSemanticsVersion(
      f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, hash, bracket);
    expect(flags(false, true) - flags(false, false)).toBe(274877906944);
    expect(flags(true, true) - flags(true, false)).toBe(274877906944);
  });
});

describe('legadoIndexSet 解析', () => {
  it('单个、区间、步长、多项、排除，项按书写顺序', () => {
    expect(legadoIndexSet('li[0:4]')).toEqual({ before: 'li', set: { exclude: false, items: [[0, 4, 1]] } });
    expect(legadoIndexSet('tag.tr[1:]')).toEqual({ before: 'tag.tr', set: { exclude: false, items: [[1, null, 1]] } });
    expect(legadoIndexSet('class.x[-1]')).toEqual({ before: 'class.x', set: { exclude: false, items: [-1] } });
    expect(legadoIndexSet('td[0:3,9,10]')).toEqual({ before: 'td', set: { exclude: false, items: [[0, 3, 1], 9, 10] } });
    expect(legadoIndexSet('.a li[1:-1:2]')).toEqual({ before: '.a li', set: { exclude: false, items: [[1, -1, 2]] } });
    expect(legadoIndexSet('li[!0:1]')).toEqual({ before: 'li', set: { exclude: true, items: [[0, 1, 1]] } });
    expect(legadoIndexSet('li[ 0 , 2 ]')).toEqual({ before: 'li', set: { exclude: false, items: [0, 2] } });
    expect(legadoIndexSet('li[:3]')).toEqual({ before: 'li', set: { exclude: false, items: [[null, 3, 1]] } });
  });

  it('CSS 属性选择器、无前置规则、步长省略、非 ] 收尾：不是索引写法', () => {
    for (const rule of ['a[href]', 'a[class="x"]', 'li[data-id=3]', '[0]', 'li[1:2:]', 'li.0', 'li[]', 'li[0]x']) {
      expect(legadoIndexSet(rule)).toBeNull();
    }
  });
});

describe('legadoIndexes 展开', () => {
  it('越界、负数、钳制、反向、步长、去重', () => {
    expect(legadoIndexes([[0, 4, 1]], 5)).toEqual([0, 1, 2, 3, 4]);
    expect(legadoIndexes([[1, null, 1]], 5)).toEqual([1, 2, 3, 4]);
    expect(legadoIndexes([-1], 5)).toEqual([4]);
    expect(legadoIndexes([7, -6], 5)).toEqual([]);
    expect(legadoIndexes([[-1, 0, 1]], 5)).toEqual([4, 3, 2, 1, 0]);
    expect(legadoIndexes([[0, 10, 1]], 5)).toEqual([0, 1, 2, 3, 4]);
    expect(legadoIndexes([[6, 8, 1]], 5)).toEqual([]);
    expect(legadoIndexes([[0, 4, 2]], 5)).toEqual([0, 2, 4]);
    expect(legadoIndexes([[0, 4, 9]], 5)).toEqual([0]);
    expect(legadoIndexes([[0, 4, -3]], 5)).toEqual([0, 2, 4]);
    expect(legadoIndexes([2, [1, 3, 1]], 5)).toEqual([2, 1, 3]);
    expect(legadoIndexes([[3, 3, 1]], 5)).toEqual([3]);
    expect(legadoIndexes([[0, 4, 1]], 0)).toEqual([]);
  });
});

describe('编译与求值', () => {
  it('on 按索引取节点、保序；off 括号留在选择器里求值失败', () => {
    expect(names('class.list@tag.li[1:]')).toEqual(['甲', '乙', '丙']);
    expect(names('.list li[-1:0]')).toEqual(['丙', '乙', '甲', '表头']);
    expect(names('tag.li[0,2]')).toEqual(['表头', '乙']);
    expect(names('tag.li[!0:1]')).toEqual(['乙', '丙']);
    expect(names('tag.li[0:4]')).toEqual(['表头', '甲', '乙', '丙']);
    expect(evaluateField(on('tag.li[-1]@tag.a@text', 'ruleSearch.name'), htmlScope())).toBe('丙');
    expect(() => evaluateFieldList(off('class.list@tag.li[1:]'), htmlScope())).toThrow();
  });

  it('不收的形态两态 IR 相同', () => {
    for (const rule of ['a[href]@text', 'tag.li[!0,1]', 'tag.li.0', 'class.x!0', '@css:li[0]', '$.a[0]', 'li[1:2:]', 'text.甲[0]']) {
      expect(on(rule)).toEqual(off(rule));
    }
  });
});

describe('准入搜索', () => {
  afterEach(() => vi.unstubAllEnvs());
  const raw = {
    bookSourceUrl: SITE, bookSourceName: '合成索引源', searchUrl: `${SITE}/s?q={{key}}`,
    ruleSearch: { bookList: 'class.list@tag.li[1:]', name: 'tag.a@text', bookUrl: 'tag.a@href' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const run = () => searchAdmission(raw, {
    fetchPage: async () => new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    declaredHosts: new Set(['cc53.test']), signal: new AbortController().signal, throttleMs: 0,
  });

  it('on 出候选（跳过表头），off 不出', async () => {
    vi.stubEnv('ENGINE_SYNTAX_BRACKET_INDEX', '1');
    expect(await run()).toMatchObject({ verdict: 'ok', candidateCount: 3 });
    vi.stubEnv('ENGINE_SYNTAX_BRACKET_INDEX', '0');
    expect((await run()).verdict).not.toBe('ok');
  });
});

describe('语义位判据', () => {
  it('ruleMayUseBracketIndex：默认语法段以索引收尾', () => {
    expect(ruleMayUseBracketIndex('class.list@tag.li[1:]')).toBe(true);
    expect(ruleMayUseBracketIndex('tag.li[0]@text||class.x@text')).toBe(true);
    expect(ruleMayUseBracketIndex('a[href]@text')).toBe(false);
    expect(ruleMayUseBracketIndex('$.a[0]')).toBe(false);
    expect(ruleMayUseBracketIndex('@css:li[0]')).toBe(false);
    expect(ruleMayUseBracketIndex('li.0@text')).toBe(false);
  });

  it('只有搜索 bookList/name/author/bookUrl 计位；开关关不计', () => {
    const mk = (search: Record<string, string>, toc: Record<string, string> = {}) => ({
      url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules: { ruleSearch: { bookList: '.b', name: 'a@text', bookUrl: 'a@href', ...search }, ruleToc: toc },
    });
    const hit = mk({ bookList: 'class.list@tag.li[1:]' });
    const tocOnly = mk({}, { chapterList: 'tag.dd[12:]' });
    expect(sourceUsesBracketIndexSyntax(hit.rules)).toBe(true);
    expect(sourceUsesBracketIndexSyntax(tocOnly.rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, bracketIndexEnabled: boolean) => Number(engineSourceRevision(s, { bracketIndexEnabled }).split(':')[0]);
    expect(v(hit, true) - v(hit, false)).toBe(274877906944);
    expect(v(tocOnly, true)).toBe(v(tocOnly, false));
  });
});
