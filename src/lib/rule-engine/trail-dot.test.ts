// traildot1030：legado 旧索引写法 `tag.li.!0:1:-1` 剥后缀剩 `tag.li.`，关键字前缀只取第二段（ENGINE_SYNTAX_TRAIL_DOT）。
// 规则与页面均为合成形态。
import { describe, expect, it, vi } from 'vitest';
import { engineSourceRevision, sourceUsesTrailDotSyntax } from './compile';
import { createScope, evaluateField, evaluateFieldList, normalizeBody } from './evaluate';
import { parseFieldRule, ruleMayUseTrailDot } from './parse';
import { ENGINE_SEMANTICS_TRAIL_DOT_BIT, engineSemanticsVersion, engineSyntaxTrailDotEnabled } from './syntax-flags';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成 traildot 验证不能访问数据库'); } }));

const SITE = 'https://td30.test';
const opts = (trailDotEnabled: boolean, field: string, extra: Record<string, boolean> = {}) =>
  ({ field, orEnabled: true, andEnabled: true, regexEnabled: true, trailDotEnabled, ...extra });
const PAGE = '<html><body><div class="pages"><ul>'
  + '<li><a href="/p/first">首页</a></li><li><a href="/p/prev">上页</a></li>'
  + '<li><a href="/p/2">二</a></li><li><a href="/p/3">三</a></li><li><a href="/p/last">尾页</a></li>'
  + '</ul></div><div id="box"><p>甲段</p><p>乙段</p></div></body></html>';
const scope = () => createScope(normalizeBody(PAGE), `${SITE}/b/1`);
const list = (rule: string, on: boolean, extra?: Record<string, boolean>) =>
  evaluateFieldList(parseFieldRule(rule, opts(on, 'ruleToc.chapterList', extra)), scope());
const one = (rule: string, on: boolean) => evaluateField(parseFieldRule(rule, opts(on, 'ruleContent.content')), scope());

describe('开关', () => {
  it('engineSyntaxTrailDotEnabled 严格口径', () => {
    expect(engineSyntaxTrailDotEnabled({})).toBe(false);
    expect(engineSyntaxTrailDotEnabled({ ENGINE_SYNTAX_TRAIL_DOT: '0' })).toBe(false);
    expect(engineSyntaxTrailDotEnabled({ ENGINE_SYNTAX_TRAIL_DOT: 'yes' })).toBe(false);
    expect(engineSyntaxTrailDotEnabled({ ENGINE_SYNTAX_TRAIL_DOT: ' On ' })).toBe(true);
    expect(engineSyntaxTrailDotEnabled({ ENGINE_SYNTAX_TRAIL_DOT: 'true' })).toBe(true);
  });
});

describe('求值', () => {
  it('tag.li.!0:1:-1 等价 tag.li!0:1:-1：on 取中间两项，off 选择器抛错', () => {
    const rule = 'class.pages@tag.ul@tag.li.!0:1:-1@tag.a';
    expect(list(rule, true)).toHaveLength(2);
    expect(one(`${rule}@text`, true)).toBe('二');
    expect(() => list(rule, false)).toThrow();
  });

  it('class./id. 前缀与括号排除同口径', () => {
    expect(list('class.pages.!0@tag.li', true)).toHaveLength(0);
    expect(list('tag.li.[!0,1]', true)).toHaveLength(3);
    expect(list('tag.li.[!0,1]', true, { bracketIndexEnabled: true })).toHaveLength(3);
    expect(one('id.box.!1@tag.p.!0@text', true)).toBe('乙段');
  });

  it('children.!0 与 children 关键字同开时取子元素再排除', () => {
    expect(list('id.box@children.!0', true, { childrenEnabled: true })).toHaveLength(1);
  });

  it('不在口径内的规则 IR 两态逐字相同', () => {
    for (const rule of ['tag.li!0:1', 'tag.li.0', 'tag.li.1:3', 'class.pages@li', 'div.!0', 'tag.li.', '@css:li.!0', '$.a']) {
      expect(JSON.stringify(parseFieldRule(rule, opts(true, 'ruleSearch.bookList'))))
        .toBe(JSON.stringify(parseFieldRule(rule, opts(false, 'ruleSearch.bookList'))));
    }
  });
});

describe('语义位', () => {
  const mk = (search: Record<string, string>) => ({
    url: SITE, searchUrl: `${SITE}/s?q={{key}}`,
    rules: { ruleSearch: { bookList: '.books@li', name: 'h4@text', bookUrl: 'a@href', ...search }, ruleToc: { nextTocUrl: 'tag.li.!0@a@href' } },
  });

  it('2^47，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_TRAIL_DOT_BIT).toBe(140737488355328);
    // 第 45/46 个参数 = 搜索页码列表 / 索引尾点，前 44 个全关。
    const flags = (pp: boolean, td: boolean) =>
      (engineSemanticsVersion as (...flags: boolean[]) => number)(...Array<boolean>(44).fill(false), pp, td);
    expect(flags(false, true) - flags(false, false)).toBe(140737488355328);
    expect(flags(true, true) - flags(true, false)).toBe(140737488355328);
  });

  it('准入搜索字段有尾点段才计位；开关关不计', () => {
    expect(ruleMayUseTrailDot('class.a@tag.li.!0:1:-1@a')).toBe(true);
    expect(ruleMayUseTrailDot('id.l@children.[0]||x')).toBe(true);
    expect(ruleMayUseTrailDot('tag.li!0')).toBe(false);
    expect(ruleMayUseTrailDot('tag.li.0')).toBe(false);
    expect(ruleMayUseTrailDot('@css:li.!0')).toBe(false);
    expect(ruleMayUseTrailDot('h4@text##tag.li.!0')).toBe(false);
    expect(sourceUsesTrailDotSyntax(mk({ bookList: 'class.l@tag.li.!0' }).rules)).toBe(true);
    expect(sourceUsesTrailDotSyntax(mk({}).rules)).toBe(false);
    const v = (s: ReturnType<typeof mk>, trailDotEnabled: boolean) => Number(engineSourceRevision(s, { trailDotEnabled }).split(':')[0]);
    const hit = mk({ bookList: 'class.l@tag.li.!0' });
    expect(v(hit, true) - v(hit, false)).toBe(140737488355328);
    expect(v(mk({}), true)).toBe(v(mk({}), false));
  });
});
