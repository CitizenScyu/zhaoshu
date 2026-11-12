// probebudget1112：admissionProbeWorstMs 按开关组合算单探最坏墙钟。
// 旧静态 ADMISSION_PROBE_WORST_MS = 16.35s 只覆盖「主搜索+对照搜索」2 个请求；生产
// ENGINE_SEARCH_NET_JS / ENGINE_FIELD_NET_JS 全开，联网取页让单探最多 18 个各 8s 超时的
// 请求（netjs1029 构造 ≤4 页 + fieldnet1029 bookList ≤4 页，主/对照各一套）。canProbe
// 按旧口径预留会让最后一探击穿整轮预算、abort 后本轮已探结论全部不落库。
import { describe, expect, it } from 'vitest';
import { admissionProbeWorstMs, ADMISSION_PROBE_WORST_MS, ADMISSION_THROTTLE_MS, ADMISSION_TIMEOUT_MS } from './admission';

const on = (env: Record<string, string>) => env as unknown as NodeJS.ProcessEnv;

describe('probebudget1112：单探最坏墙钟按联网开关放大', () => {
  it('全关 = 旧静态常量（主搜索+节流+对照搜索，逐字相等）', () => {
    expect(admissionProbeWorstMs(on({}))).toBe(ADMISSION_PROBE_WORST_MS);
    expect(admissionProbeWorstMs(on({}))).toBe(2 * ADMISSION_TIMEOUT_MS + ADMISSION_THROTTLE_MS);
  });

  it('只开搜索联网 JS（三开关齐）⇒ 主/对照各加 4 页构造，2+8 请求', () => {
    const env = on({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' });
    expect(admissionProbeWorstMs(env)).toBe((2 + 2 * 4) * ADMISSION_TIMEOUT_MS + ADMISSION_THROTTLE_MS);
  });

  it('只开字段联网 JS（三开关齐）⇒ 主/对照各加 4 页 bookList，2+8 请求', () => {
    const env = on({ ENGINE_FIELD_NET_JS: '1', ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1' });
    expect(admissionProbeWorstMs(env)).toBe((2 + 2 * 4) * ADMISSION_TIMEOUT_MS + ADMISSION_THROTTLE_MS);
  });

  it('两套联网全开（生产现状）⇒ 18 请求 × 8s + 节流 ≈ 144.35s', () => {
    const env = on({
      ENGINE_SEARCH_NET_JS: '1', ENGINE_FIELD_NET_JS: '1',
      ENGINE_SYNTAX_JS: '1', ENGINE_SYNTAX_JSOUP: '1',
    });
    expect(admissionProbeWorstMs(env)).toBe(18 * ADMISSION_TIMEOUT_MS + ADMISSION_THROTTLE_MS);
    expect(admissionProbeWorstMs(env)).toBeGreaterThan(ADMISSION_PROBE_WORST_MS * 8);
  });

  it('ENGINE_SEARCH_NET_JS 开但 JS/JSOUP 前置缺一 ⇒ 不放大（与 search-js.ts 生效判定同口径）', () => {
    expect(admissionProbeWorstMs(on({ ENGINE_SEARCH_NET_JS: '1', ENGINE_SYNTAX_JS: '1' }))).toBe(ADMISSION_PROBE_WORST_MS);
    expect(admissionProbeWorstMs(on({ ENGINE_FIELD_NET_JS: '1', ENGINE_SYNTAX_JSOUP: '1' }))).toBe(ADMISSION_PROBE_WORST_MS);
  });
});
