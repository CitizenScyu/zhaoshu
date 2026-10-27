import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuleEngineError } from './types';

// searchjs1027：沙箱瞬时不可用（未就绪/预算耗尽）必须是 SearchJsNotReadyError，不能落成 SourcePolicyError（会被记成策略拒）。
// value 非 null 时 runJs 按包装口径返回 [value, {}]（计数用于验记忆）。
const state = vi.hoisted(() => ({ message: 'JS 沙箱未就绪', value: null as string | null, calls: 0 }));
vi.mock('./js-sandbox', () => ({
  preloadJsSandbox: async () => undefined,
  runJs: () => {
    state.calls += 1;
    if (state.value !== null) return JSON.stringify([state.value, {}]);
    throw new RuleEngineError('RULE_EVAL_FAILED', state.message);
  },
}));

const { buildSearchRequest, searchJsConstructible, SearchJsNotReadyError } = await import('./search-js');
const { selectCandidates } = await import('./compile-smoke');
const { searchTemplateRejected } = await import('@/lib/source-usability');
const { SourcePolicyError } = await import('@/lib/source-policy');

const BASE = 'https://a.example.com';
const TEMPLATE = `${BASE}/s?q={{key}}&p={{page-1}}`;

afterEach(() => {
  state.message = 'JS 沙箱未就绪';
  state.value = null;
  state.calls = 0;
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

describe('search-js：「能否构造」判定记忆 JS 段求值', () => {
  // host 门用默认白名单（book15.net），不刷全局门状态。
  const GATE = 'https://book15.net';
  const source = (searchUrl: string) => ({ url: GATE, searchUrl, rules: {} });
  const on = () => {
    vi.stubEnv('ENGINE_POST_SEARCH', '1');
    vi.stubEnv('ENGINE_SEARCH_JS', '1');
  };

  it('不传书名：同模板只起一次沙箱，候选口径共用；真书名每次重算', () => {
    on();
    state.value = '0';
    const template = `${GATE}/memo?q={{key}}&p={{page-1}}`;
    for (let i = 0; i < 3; i += 1) expect(searchTemplateRejected(source(template))).toBe(false);
    expect(searchJsConstructible(template, GATE)).toBe(true);
    expect(state.calls).toBe(1);
    searchTemplateRejected(source(template), '书');
    searchTemplateRejected(source(template), '书');
    expect(state.calls).toBe(3);
  });

  it('策略拒也记忆（照抛原因），未就绪不记忆', () => {
    on();
    const rejected = `${GATE}/memo-r?q={{key}}&p={{page-1}}`;
    state.message = 'JS 执行失败：boom';
    expect(searchTemplateRejected(source(rejected))).toBe(true);
    expect(searchTemplateRejected(source(rejected))).toBe(true);
    expect(state.calls).toBe(1);

    const flaky = `${GATE}/memo-n?q={{key}}&p={{page-1}}`;
    state.message = 'JS 执行预算耗尽（进程）';
    expect(searchTemplateRejected(source(flaky))).toBe(true);
    state.value = '0';
    expect(searchTemplateRejected(source(flaky))).toBe(false);
    expect(searchTemplateRejected(source(flaky))).toBe(false);
    expect(state.calls).toBe(3);
  });

  it('记忆的是求值结果：host 门每次对结果重验', () => {
    on();
    state.value = 'https://b.example.com/s?q=x';
    const template = '@js:"https://b.example.com/s?q="+key';
    expect(searchJsConstructible(template, GATE)).toBe(true);
    expect(searchTemplateRejected(source(template))).toBe(true);
    expect(state.calls).toBe(1);
  });
});
