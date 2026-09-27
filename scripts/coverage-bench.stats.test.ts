import { describe, it, expect } from 'vitest';
import { summarize, compare, sourceStats, singlePointDependency, isCovered, okHosts, matchTier } from './coverage-bench-stats.mjs';

// 假结果：4 本书 × 若干源。q.io 命中 A、B；x.net 命中 B（可读）与 D（不可读，不算覆盖）；C 全灭。
const RESULTS = [
  { title: 'A书', author: '甲', tier: 'popular', genre: '玄幻', perSource: [
    { host: 'q.io', name: 'Q', status: 'ok', readable: true, idExact: true, ms: 100 },
    { host: 'w.com', name: 'W', status: 'miss', readable: true, ms: 200 },
  ] },
  { title: 'B书', author: '乙', tier: 'popular', genre: '都市', perSource: [
    { host: 'q.io', name: 'Q', status: 'ok', readable: true, idExact: true, ms: 150 },
    { host: 'x.net', name: 'X', status: 'ok', readable: true, idExact: false, ms: 300 },
  ] },
  { title: 'C书', author: '丙', tier: 'library', genre: '现代文学', perSource: [
    { host: 'q.io', name: 'Q', status: 'miss', readable: true, ms: 120 },
    { host: 'w.com', name: 'W', status: 'unreachable', readable: true, ms: 500 },
  ] },
  { title: 'D书', author: '丁', tier: 'library', genre: '科幻', perSource: [
    { host: 'x.net', name: 'X', status: 'ok', readable: false, idExact: true, ms: 90 },
  ] },
];

describe('coverage-bench stats', () => {
  it('isCovered / okHosts 只认 ok 且 readable', () => {
    expect(isCovered(RESULTS[0])).toBe(true);
    expect(isCovered(RESULTS[2])).toBe(false);
    expect(isCovered(RESULTS[3])).toBe(false); // readable=false 不算覆盖
    expect(okHosts(RESULTS[1])).toEqual(['q.io', 'x.net']);
    expect(okHosts(RESULTS[3])).toEqual([]);
  });

  it('summarize 总览与分层', () => {
    const s = summarize(RESULTS, { label: 't', poolSize: 3, codeVersion: 'abc' });
    expect(s.totals.books).toBe(4);
    expect(s.totals.covered).toBe(2);
    expect(s.totals.coverageRate).toBe(0.5);
    expect(s.totals.okPairs).toBe(3); // A:q, B:q, B:x
    expect(s.totals.idExactPairs).toBe(2); // A:q, B:q（B:x idExact=false）
    expect(s.totals.tiers).toEqual({ exact: 2, identity: 1, fuzzy: 0 });
    expect(s.totals.trusted).toBe(2);
    expect(s.totals.trustedCoverageRate).toBe(0.5);
    expect(s.byTier.popular).toMatchObject({ books: 2, covered: 2, coverageRate: 1, exact: 2, identity: 1, fuzzy: 0, trusted: 2, trustedCoverageRate: 1 });
    expect(s.byTier.library).toMatchObject({ books: 2, covered: 0, coverageRate: 0 });
    expect(s.byGenre['玄幻'].coverageRate).toBe(1);
    expect(s.uncovered.map((b: { title: string }) => b.title).sort()).toEqual(['C书', 'D书']);
    expect(s.statusTotals).toEqual({ ok: 4, miss: 2, unreachable: 1 });
  });

  it('sourceStats 尝试/ok/覆盖书/失败分类', () => {
    const ss = sourceStats(RESULTS);
    const q = ss.find((r) => r.host === 'q.io');
    const x = ss.find((r) => r.host === 'x.net');
    const w = ss.find((r) => r.host === 'w.com');
    expect(q).toMatchObject({ attempts: 3, ok: 2, coverage: 2 });
    expect(x).toMatchObject({ attempts: 2, ok: 1, coverage: 1 }); // D 的 ok 不可读，不计 ok/coverage
    expect(w).toMatchObject({ attempts: 2, ok: 0, coverage: 0 });
    expect(ss[0].host).toBe('q.io'); // 按 ok 降序
    expect(q.avgMs).toBe(Math.round((100 + 150 + 120) / 3));
  });

  it('单点依赖度：okPairs 与书级两种口径', () => {
    const ss = sourceStats(RESULTS);
    const sp = singlePointDependency(RESULTS, ss);
    expect(sp.topHost).toBe('q.io');
    expect(sp.topHostOk).toBe(2);
    expect(sp.okPairs).toBe(3);
    expect(sp.ratio).toBe(Number((2 / 3).toFixed(4)));
    expect(sp.soleProviderBooks).toBe(1); // 只有 A 的唯一可读源是 q.io
    expect(sp.soleProviderRate).toBe(0.5); // 1 / 2 已覆盖
  });

  it('compare 覆盖率差与新覆盖/丢失', () => {
    // 上一次：A 也没命中（q.io miss）→ 覆盖率 25%
    const prevResults = RESULTS.map((b, i) => i === 0
      ? { ...b, perSource: [{ host: 'q.io', status: 'miss', readable: true }, { host: 'w.com', status: 'miss', readable: true }] }
      : b);
    const prev = summarize(prevResults);
    const curr = summarize(RESULTS);
    const c = compare(prev, curr);
    expect(c.coverageRate.prev).toBe(0.25);
    expect(c.coverageRate.curr).toBe(0.5);
    expect(c.coverageRate.delta).toBe(0.25);
    expect(c.newlyCovered.map((x) => x[0])).toContain('A书');
    expect(c.newlyLost).toEqual([]);
    const qDelta = c.bySourceDelta.find((r) => r.host === 'q.io');
    expect(qDelta?.delta).toBe(1); // q.io ok 1 → 2
    expect(c.tiers.exact).toEqual({ prev: 1, curr: 2, delta: 1 }); // A:q 从 miss 变 ok 精确
    expect(c.tiers.identity).toEqual({ prev: 1, curr: 1, delta: 0 });
    expect(c.tiers.fuzzy).toEqual({ prev: 0, curr: 0, delta: 0 });
    expect(c.trustedCoverageRate).toEqual({ prev: 0.25, curr: 0.5, delta: 0.25 });
  });

  it('三档分类：exact / identity / fuzzy', () => {
    const book = { title: 'E书', author: '戊', tier: 'popular', genre: '玄幻', perSource: [
      { host: 'a.io', status: 'ok', readable: true, idExact: true },
      { host: 'b.io', status: 'ok', readable: true, idExact: false },
      { host: 'c.io', status: 'ok', readable: true, fuzzy: true },
      { host: 'd.io', status: 'ok', readable: false, idExact: true }, // 不可读，不计档
      { host: 'e.io', status: 'miss', readable: true },
    ] };
    expect(matchTier(book.perSource[0])).toBe('exact');
    expect(matchTier(book.perSource[1])).toBe('identity');
    expect(matchTier(book.perSource[2])).toBe('fuzzy');
    const s = summarize([book]);
    expect(s.totals.tiers).toEqual({ exact: 1, identity: 1, fuzzy: 1 });
    expect(s.totals.okPairs).toBe(3);
    expect(s.totals.covered).toBe(1);
    expect(s.totals.trusted).toBe(1); // exact 与 identity 都算可信
    expect(s.totals.trustedCoverageRate).toBe(1);
    // 只有模糊降级的书不算可信覆盖
    const fuzzyOnly = { title: 'F书', author: '己', tier: 'library', genre: '科幻', perSource: [
      { host: 'c.io', status: 'ok', readable: true, fuzzy: true },
    ] };
    const s2 = summarize([fuzzyOnly]);
    expect(s2.totals.covered).toBe(1);
    expect(s2.totals.trusted).toBe(0);
    expect(s2.totals.trustedCoverageRate).toBe(0);
  });

  it('可信覆盖率：至少一本 exact 或 identity 命中 / 总书数', () => {
    const mk = (title: string, tier: string, perSource: unknown[]) => ({ title, author: '某', tier, genre: '玄幻', perSource });
    const books = [
      mk('甲', 'popular', [{ host: 'a.io', status: 'ok', readable: true, idExact: true }]),
      mk('乙', 'popular', [{ host: 'b.io', status: 'ok', readable: true, idExact: false }]),
      mk('丙', 'library', [{ host: 'c.io', status: 'ok', readable: true, fuzzy: true }]),
      mk('丁', 'library', [{ host: 'd.io', status: 'miss', readable: true }]),
    ];
    const s = summarize(books);
    expect(s.totals.books).toBe(4);
    expect(s.totals.covered).toBe(3);
    expect(s.totals.trusted).toBe(2);
    expect(s.totals.trustedCoverageRate).toBe(0.5);
    expect(s.byTier.popular.trustedCoverageRate).toBe(1);
    expect(s.byTier.library.trustedCoverageRate).toBe(0);
    expect(s.byTier.library.fuzzy).toBe(1);
  });

  it('旧格式 raw 兼容：缺 idExact/fuzzy/gotTitle 字段按 null 处理', () => {
    const legacy = [
      { title: '旧书', author: '旧', tier: 'popular', genre: '都市', perSource: [
        { host: 'q.io', status: 'ok', readable: true, ms: 100 }, // 无 idExact、无 fuzzy
        { host: 'w.com', status: 'miss', readable: true },
      ] },
    ];
    expect(matchTier(legacy[0].perSource[0])).toBe('identity'); // idExact 缺失 → 非精确
    const s = summarize(legacy);
    expect(s.totals.tiers).toEqual({ exact: 0, identity: 1, fuzzy: 0 });
    expect(s.totals.okPairs).toBe(1);
    expect(s.totals.trusted).toBe(1);
    expect(s.totals.trustedCoverageRate).toBe(1);
    // 旧 summary 没有 tiers/trusted 字段时，compare 按 0 处理不抛
    const curr = summarize(RESULTS);
    const c = compare({ totals: { coverageRate: 0.5 }, byTier: {}, uncovered: [], bySource: [], singlePoint: { ratio: 0 } }, curr);
    expect(c.tiers.exact).toEqual({ prev: 0, curr: 2, delta: 2 });
    expect(c.tiers.fuzzy).toEqual({ prev: 0, curr: 0, delta: 0 });
    expect(c.trustedCoverageRate.prev).toBe(0);
  });
});
