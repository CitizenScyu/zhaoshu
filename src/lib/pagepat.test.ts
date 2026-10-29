import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineSourceRevision } from './rule-engine/compile';
import { ENGINE_SEMANTICS_SEARCH_PAGE_PATTERN_BIT, engineSearchPagePatternEnabled, engineSemanticsVersion } from './rule-engine/syntax-flags';
import { buildSourceSearchRequest, searchTemplateUsesPagePattern, sourceSearchUrl } from './source-parser';

// pagepat1030：旧口径搜索模板的 legado 页码列表 `<a,b,…>` 按 page=1 取首项（ENGINE_SEARCH_PAGE_PATTERN，默认 off）。
// host 门与本改动无关：校验器只解析 URL，不过白名单。

afterEach(() => { vi.unstubAllEnvs(); });
const on = () => vi.stubEnv('ENGINE_SEARCH_PAGE_PATTERN', '1');
const SITE = 'https://pp.example.com';
const parseOnly = (value: unknown, base?: string) => new URL(String(value), base);
const url = (template: string) => sourceSearchUrl(template, '测试', SITE, parseOnly);
const KEY = encodeURIComponent('测试');

describe('pagepat1030 开关与适用判定', () => {
  it('只认 1/true/on', () => {
    expect(engineSearchPagePatternEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ['1', 'true', 'on', ' ON ']) {
      expect(engineSearchPagePatternEnabled({ ENGINE_SEARCH_PAGE_PATTERN: v } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
    expect(engineSearchPagePatternEnabled({ ENGINE_SEARCH_PAGE_PATTERN: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('只认旧口径模板（有 {{key}}、无 JS 与非 key/page 的 {{}}）里的 <…>', () => {
    expect(searchTemplateUsesPagePattern('/book/search/{{key}}<,/{{page}}>')).toBe(true);
    expect(searchTemplateUsesPagePattern('/s?q={{key}}<,&p={{page}}>,{"method":"POST"}')).toBe(true);
    expect(searchTemplateUsesPagePattern('/s?q={{key}}')).toBe(false);
    expect(searchTemplateUsesPagePattern('/s?q=x<,/{{page}}>')).toBe(false);
    expect(searchTemplateUsesPagePattern('/s?q={{key}}<,&o={{(page-1)*10}}>')).toBe(false);
    expect(searchTemplateUsesPagePattern('<js>"/s?q="+key</js>{{key}}<,/2>')).toBe(false);
    expect(searchTemplateUsesPagePattern('@js:"/s?q={{key}}<,/2>"')).toBe(false);
    expect(searchTemplateUsesPagePattern(undefined)).toBe(false);
  });
});

describe('pagepat1030 展开', () => {
  it('关：<…> 原样拼进 URL（旧口径逐字不变）', () => {
    expect(url('/book/search/{{key}}<,/{{page}}>')).toBe(`${SITE}/book/search/${KEY}%3C,/1%3E`);
  });

  it('开：page=1 取首项（空串/逗号前文本），去两端 ≤ 空格', () => {
    on();
    expect(url('/book/search/{{key}}<,/{{page}}>')).toBe(`${SITE}/book/search/${KEY}`);
    expect(url('/s?q={{key}}< &p=1 ,&p={{page}}>')).toBe(`${SITE}/s?q=${KEY}&p=1`);
    expect(url('/s?q={{key}}<&only>')).toBe(`${SITE}/s?q=${KEY}&only`);
  });

  it('开：同文本多处全量替换；只扫一遍（与 legado 同，嵌套不再展开）', () => {
    on();
    expect(url('/s/{{key}}<,/x>/a<,/x>')).toBe(`${SITE}/s/${KEY}/a`);
    expect(url('/s/{{key}}/<<a,b>>')).toBe(`${SITE}/s/${KEY}/%3Ca%3E`);
  });

  it('开：带选项的模板先展开页码再拆选项（body 里的 <…> 同样展开）', () => {
    on();
    const request = buildSourceSearchRequest(
      '/s<,/p{{page}}>,{"method":"POST","body":"k={{key}}<,&p={{page}}>"}', '测试', SITE, parseOnly, false,
    );
    expect(request).toMatchObject({ url: `${SITE}/s`, method: 'POST', body: `k=${KEY}` });
  });

  it('开：<,{{page}}> 不再被误当成 `,{选项}`', () => {
    const template = '/s?q={{key}}<,{{page}}>';
    expect(() => buildSourceSearchRequest(template, '测试', SITE, parseOnly, false)).toThrow();
    on();
    expect(buildSourceSearchRequest(template, '测试', SITE, parseOnly, false).url).toBe(`${SITE}/s?q=${KEY}`);
  });
});

describe('pagepat1030 语义位', () => {
  it('2^46，独立于其余位', () => {
    expect(ENGINE_SEMANTICS_SEARCH_PAGE_PATTERN_BIT).toBe(70368744177664);
    // 第 44/45 个参数 = children / 搜索页码列表，前 43 个全关。
    const flags = (ch: boolean, pp: boolean) =>
      (engineSemanticsVersion as (...flags: boolean[]) => number)(...Array<boolean>(43).fill(false), ch, pp);
    expect(flags(false, true) - flags(false, false)).toBe(70368744177664);
    expect(flags(true, true) - flags(true, false)).toBe(70368744177664);
  });

  it('含页码列表的旧口径模板才计位；开关关不计', () => {
    const mk = (searchUrl: string) => ({
      url: SITE, searchUrl, rules: { ruleSearch: { bookList: '.books@li', name: 'h4@text', bookUrl: 'a@href' } },
    });
    const v = (s: ReturnType<typeof mk>, searchPagePatternEnabled: boolean) =>
      Number(engineSourceRevision(s, { searchPagePatternEnabled }).split(':')[0]);
    const hit = mk(`${SITE}/book/search/{{key}}<,/{{page}}>`);
    expect(v(hit, true) - v(hit, false)).toBe(70368744177664);
    const plain = mk(`${SITE}/s?q={{key}}`);
    expect(v(plain, true)).toBe(v(plain, false));
  });
});
