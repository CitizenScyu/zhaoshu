import { describe, it, expect } from 'vitest';
import { summarize, compare, sourceStats, singlePointDependency, isCovered, okHosts } from './coverage-bench-stats.mjs';

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
    expect(s.byTier.popular).toMatchObject({ books: 2, covered: 2, coverageRate: 1 });
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
  });
});
