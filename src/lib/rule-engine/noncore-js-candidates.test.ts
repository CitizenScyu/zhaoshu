import { describe, expect, it } from 'vitest';
import { admissionNoncoreJsEnabled, admissionSurveyOptions, compileCoreFields, selectCandidates, type RawSource } from './compile-smoke';

// js-1026：装饰字段带 JS 的源在 ADMISSION_NONCORE_JS 开时可入选；阅读路径字段带 JS 两态都拒；源类型只放行文本。
const src = (patch: Partial<RawSource> = {}): RawSource => ({
  bookSourceUrl: 'https://book15.net',
  searchUrl: 'https://book15.net/s?q={{key}}',
  ruleSearch: { bookList: '.book', name: '.name', bookUrl: 'a@href' },
  ruleContent: { content: '.content' },
  ...patch,
});

describe('selectCandidates × noncoreJs（js-1026）', () => {
  it.each([
    ['ruleSearch.coverUrl', { ruleSearch: { bookList: '.book', coverUrl: 'img@src@js:result.replace("http:","https:")' } }],
    ['ruleBookInfo.intro', { ruleBookInfo: { intro: '.intro@text<js>result.trim()</js>' } }],
    ['ruleExplore.bookList', { ruleExplore: { bookList: '@js:JSON.parse(result).list' } }],
    ['ruleContent.replaceRegex', { ruleContent: { content: '.content', replaceRegex: '@js:result.replace(/广告/g,"")' } }],
  ])('装饰字段 %s 带 JS：默认拒（逐字原口径），开关开入选', (_field, patch) => {
    expect(selectCandidates([src(patch as Partial<RawSource>)]).length).toBe(0);
    expect(selectCandidates([src(patch as Partial<RawSource>)], { noncoreJs: true }).length).toBe(1);
  });

  it.each([
    ['ruleContent.content', { ruleContent: { content: '.content@js:result' } }],
    ['ruleSearch.bookList', { ruleSearch: { bookList: '<js>java.ajax(baseUrl)</js>' } }],
    ['ruleToc.chapterList', { ruleToc: { chapterList: '@js:result.list' } }],
    ['ruleBookInfo.init', { ruleBookInfo: { init: '@js:JSON.parse(result)' } }],
    ['ruleContent.webJs', { ruleContent: { content: '.content', webJs: '@js:document.body.innerText' } }],
    ['ruleContent.sourceRegex', { ruleContent: { content: '.content', sourceRegex: '<js>x</js>' } }],
    ['ruleToc.preUpdateJs', { ruleToc: { chapterList: '.list', preUpdateJs: '@js:java.ajax(baseUrl)' } }],
  ])('阅读路径字段 %s 带 JS：开关开也拒', (_field, patch) => {
    expect(selectCandidates([src(patch as Partial<RawSource>)], { noncoreJs: true }).length).toBe(0);
  });

  it('webJs 不含 @js:/<js 字样时不按 JS 判（两态同口径：只认字面标记）', () => {
    // webJs 本身就是脚本体，但原判据只认 @js:/<js；开关开若改判会把现网带 webJs 的在池源判回 T7。这里固定现状。
    const s = src({ ruleContent: { content: '.content', webJs: 'document.body.innerText' } });
    expect(selectCandidates([s]).length).toBe(1);
    expect(selectCandidates([s], { noncoreJs: true }).length).toBe(1);
  });

  it('开关开时入选源的核心字段编译照旧：装饰字段 JS 不进 compileCoreFields', () => {
    const s = src({ ruleSearch: { bookList: '.book', name: '.name', bookUrl: 'a@href', coverUrl: '@js:result' } });
    expect(compileCoreFields(s)).toMatchObject({ ok: true, failures: [] });
  });
});

describe('selectCandidates × bookSourceType（legado 0 文本 / 1 音频 / 2 图片 / 3 文件 / 4 视频）', () => {
  it.each([[undefined], [0], ['0'], [null], ['']])('文本源 %s 入选', (type) => {
    expect(selectCandidates([src({ bookSourceType: type })]).length).toBe(1);
  });

  it.each([[1], [2], [3], [4], ['1'], ['audio']])('非文本源 %s 拒', (type) => {
    expect(selectCandidates([src({ bookSourceType: type })]).length).toBe(0);
    expect(selectCandidates([src({ bookSourceType: type })], { noncoreJs: true, postSearch: true }).length).toBe(0);
  });
});

describe('admissionNoncoreJsEnabled', () => {
  it.each([['1', true], ['true', true], ['0', false], ['', false], [undefined, false], ['yes', false]])('%s → %s', (value, expected) => {
    expect(admissionNoncoreJsEnabled({ ADMISSION_NONCORE_JS: value } as unknown as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe('admissionSurveyOptions（jsbox1027 候选筛与 compileAdmission 同口径）', () => {
  const env = (patch: Record<string, string>) => patch as unknown as NodeJS.ProcessEnv;
  const coreJsSource = src({ ruleContent: { content: '.content@js:result.trim()' } });

  it('ENGINE_SYNTAX_JS 开：核心字段 JS 源 coreJs=true，候选筛放行', () => {
    const options = admissionSurveyOptions(coreJsSource, env({ ENGINE_SYNTAX_JS: '1' }));
    expect(options).toEqual({ postSearch: false, noncoreJs: false, coreJs: true, searchJs: false, listJs: false });
    expect(selectCandidates([coreJsSource], options).length).toBe(1);
  });

  it('ENGINE_SYNTAX_JS 关：coreJs=false，逐字原口径拒', () => {
    const options = admissionSurveyOptions(coreJsSource, env({}));
    expect(options.coreJs).toBe(false);
    expect(selectCandidates([coreJsSource], options).length).toBe(0);
  });

  it('带 jsLib 的源开关开也 coreJs=false', () => {
    const s = { ...coreJsSource, jsLib: 'function f(){}' };
    expect(admissionSurveyOptions(s, env({ ENGINE_SYNTAX_JS: '1' })).coreJs).toBe(false);
    expect(selectCandidates([s], admissionSurveyOptions(s, env({ ENGINE_SYNTAX_JS: '1' }))).length).toBe(0);
  });

  it('postSearch/noncoreJs 透传各自开关', () => {
    expect(admissionSurveyOptions(src(), env({ ENGINE_POST_SEARCH: '1', ADMISSION_NONCORE_JS: 'true' })))
      .toEqual({ postSearch: true, noncoreJs: true, coreJs: false, searchJs: false, listJs: false });
    expect(admissionSurveyOptions(src(), env({ ENGINE_SYNTAX_LIST_JS: 'on' })).listJs).toBe(true);
    expect(admissionSurveyOptions(src(), env({ ENGINE_SEARCH_JS: '1' })).searchJs).toBe(false);
    expect(admissionSurveyOptions(src(), env({ ENGINE_POST_SEARCH: '1', ENGINE_SEARCH_JS: '1' })).searchJs).toBe(true);
  });
});
