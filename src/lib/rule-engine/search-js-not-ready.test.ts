import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuleEngineError } from './types';

// searchjs1027：沙箱瞬时不可用（未就绪/预算耗尽）必须是 SearchJsNotReadyError，不能落成 SourcePolicyError（会被记成策略拒）。
const state = vi.hoisted(() => ({ message: 'JS 沙箱未就绪' }));
vi.mock('./js-sandbox', () => ({
  preloadJsSandbox: async () => undefined,
  runJs: () => { throw new RuleEngineError('RULE_EVAL_FAILED', state.message); },
}));

const { buildSearchRequest, searchJsConstructible, SearchJsNotReadyError } = await import('./search-js');
const { selectCandidates } = await import('./compile-smoke');
const { searchTemplateRejected } = await import('@/lib/source-usability');
const { SourcePolicyError } = await import('@/lib/source-policy');

const BASE = 'https://a.example.com';
const TEMPLATE = `${BASE}/s?q={{key}}&p={{page-1}}`;

afterEach(() => {
  state.message = 'JS 沙箱未就绪';
  vi.unstubAllEnvs();
});

describe('search-js：沙箱瞬时不可用', () => {
  it.each(['JS 沙箱未就绪', 'JS 执行预算耗尽（进程）', 'JS 执行预算耗尽（该段代码）', 'JS 沙箱异常：trap'])('%s → SearchJsNotReadyError', (message) => {
    state.message = message;
    expect(() => buildSearchRequest(TEMPLATE, '书', BASE, undefined, true)).toThrow(SearchJsNotReadyError);
  });

  it('普通求值失败 → SourcePolicyError', () => {
    state.message = 'JS 执行失败：ReferenceError: x is not defined';
    expect(() => buildSearchRequest(TEMPLATE, '书', BASE, undefined, true)).toThrow(SourcePolicyError);
  });

  it('候选判定不记忆未就绪：恢复后同模板重新求值', () => {
    expect(() => searchJsConstructible(TEMPLATE, BASE)).toThrow(SearchJsNotReadyError);
    state.message = 'JS 执行失败：boom';
    expect(searchJsConstructible(TEMPLATE, BASE)).toBe(false);
  });

  it('selectCandidates 透传（调用方据此跳过、不判 T7）', () => {
    const source = { bookSourceUrl: BASE, searchUrl: `${BASE}/x,{"method":"POST","body":"q={{key}}&p={{page+0}}"}`, ruleSearch: { bookList: '.b' }, ruleContent: { content: '.c' } };
    expect(() => selectCandidates([source], { postSearch: true, searchJs: true })).toThrow(SearchJsNotReadyError);
  });

  it('运行时可用性：未就绪按本次不可用（不抛）', () => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
    expect(searchTemplateRejected({ url: BASE, searchUrl: TEMPLATE, rules: {} }, '书')).toBe(true);
  });
});
