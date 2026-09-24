// engine-search-pool 单测 + mock 延迟模型（espfix41）。全离线：不连库、不对任何书源站发请求。
// 延迟模型用 fake timers 精确推进，数值口径见 espfix-41-report §1/§4。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  excludeSkippedSources, searchSources, SEARCH_HOST_CONCURRENCY, SEARCH_SOURCE_SLICE_MS, sourceHostOf,
} from './engine-search-pool.mjs';

afterEach(() => { vi.useRealTimers(); });

type Src = { name: string; host: string; ms: number; fail?: boolean };

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// 记录每站同时在飞数与全局在飞数的峰值。
function tracker() {
  const perHost = new Map<string, number>();
  const peak = { host: 0, total: 0 };
  let total = 0;
  return {
    peak,
    async run(src: Src) {
      perHost.set(src.host, (perHost.get(src.host) ?? 0) + 1);
      total += 1;
      peak.host = Math.max(peak.host, perHost.get(src.host)!);
      peak.total = Math.max(peak.total, total);
      try {
        await sleep(src.ms);
        if (src.fail) throw new Error(`${src.name} down`);
        return [src.name];
      } finally {
        perHost.set(src.host, perHost.get(src.host)! - 1);
        total -= 1;
      }
    },
  };
}

async function drive<T>(promise: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let value!: T;
  let done = false;
  void promise.then((v) => { value = v; done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(10);
  return { value, ms: Date.now() - start };
}

describe('searchSources 调度', () => {
  it('输出按池序，与完成先后无关', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const sources: Src[] = [
      { name: 'slow', host: 'a.example', ms: 900 },
      { name: 'fast', host: 'b.example', ms: 10 },
      { name: 'mid', host: 'c.example', ms: 300 },
    ];
    const { value } = await drive(searchSources({
      sources, signal: new AbortController().signal, hostKey: (s: Src) => s.host, searchOne: (s: Src) => t.run(s),
    }));
    expect(value).toEqual(['slow', 'fast', 'mid']);
  });

  it('同站严格串行（不增加单站并发），跨站并发不超过上限', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const sources: Src[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ name: `a${i}`, host: 'same.example', ms: 100 })),
      ...Array.from({ length: 8 }, (_, i) => ({ name: `x${i}`, host: `h${i}.example`, ms: 100 })),
    ];
    const { value } = await drive(searchSources({
      sources, signal: new AbortController().signal, hostKey: (s: Src) => s.host, searchOne: (s: Src) => t.run(s), concurrency: 4,
    }));
    expect(value).toHaveLength(11);
    expect(t.peak.host).toBe(1);
    expect(t.peak.total).toBe(4);
  });

  it('单源失败只影响自己：onError 记下，其余照常交付', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const errors: string[] = [];
    const sources: Src[] = [
      { name: 'bad', host: 'a.example', ms: 50, fail: true },
      { name: 'good', host: 'b.example', ms: 50 },
    ];
    const { value } = await drive(searchSources({
      sources, signal: new AbortController().signal, hostKey: (s: Src) => s.host, searchOne: (s: Src) => t.run(s),
      onError: (s: Src) => errors.push(s.name),
    }));
    expect(value).toEqual(['good']);
    expect(errors).toEqual(['bad']);
  });

  it('整体中止后不再起新源，已收集的照常交付，且中止引起的失败不记 onError', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const started: string[] = [];
    const errors: string[] = [];
    const sources: Src[] = [
      { name: 'first', host: 'same.example', ms: 100 },
      { name: 'second', host: 'same.example', ms: 100 },
      { name: 'third', host: 'same.example', ms: 100 },
    ];
    setTimeout(() => controller.abort(), 150);
    const { value } = await drive(searchSources({
      sources, signal: controller.signal, hostKey: (s: Src) => s.host,
      searchOne: async (s: Src) => {
        started.push(s.name);
        await sleep(s.ms);
        if (controller.signal.aborted) throw new Error('aborted');
        return [s.name];
      },
      onError: (s: Src) => errors.push(s.name),
    }));
    expect(value).toEqual(['first']);
    expect(started).toEqual(['first', 'second']);
    expect(errors).toEqual([]);
  });

  it('空池直接返回空数组', async () => {
    const out = await searchSources({
      sources: [], signal: new AbortController().signal, hostKey: () => '', searchOne: async () => ['x'],
    });
    expect(out).toEqual([]);
  });

  it('分组键为空串的源各自独立成组（不被错并到同一组串行）', async () => {
    vi.useFakeTimers();
    const t = tracker();
    const sources: Src[] = [
      { name: 'u1', host: '', ms: 100 },
      { name: 'u2', host: '', ms: 100 },
    ];
    const { ms } = await drive(searchSources({
      sources, signal: new AbortController().signal, hostKey: (s: Src) => s.host, searchOne: (s: Src) => t.run(s),
    }));
    expect(ms).toBeLessThan(200);
  });
});

// ---- mock 延迟模型：一本书的引擎兜底搜索墙钟（book15 已熔断的 phoenix 现状）----
// 固定开销：node 冷启动+TS 转译 ~2000ms、读源池 3 次 DB 往返 ~1200ms（报告 §1，推测值）；
// Python 端每本 SEARCH_DELAY 1500ms（改后熔断时不再睡）。
// 源：book15（宕机，每次尝试卡满 8000ms，2 次尝试）、3 个引擎源（其一为垃圾源），各 800ms 响应。
// 共享节流槽：每次请求起始间隔 350ms（与 SourceRequestContext 同口径：同步预占时间槽）。
const COLD_START_MS = 2000;
const POOL_DB_MS = 1200;
const PY_SEARCH_DELAY_MS = 1500;
const THROTTLE_MS = 350;
const ATTEMPT_TIMEOUT_MS = 8000;

type ModelSrc = { name: string; host: string; down?: boolean; ms?: number };
const BOOK15: ModelSrc = { name: 'book15', host: 'book15.net', down: true };
const ENGINE: ModelSrc[] = [
  { name: 'yingsx', host: 'www.yingsx.com', ms: 800 },
  { name: 'jhsssd', host: 'm.jhsssd.com', ms: 800 },
  { name: 'junk', host: '4702.zejfxszmh.cc', ms: 800 },
];

// 单源一次搜索：最多 2 次尝试，每次先过共享节流槽；sliceMs 给定时切片到点即放弃。
function modelSearchOne(slot: { next: number }, sliceMs?: number) {
  return async (src: ModelSrc) => {
    const started = Date.now();
    const deadline = sliceMs ? started + sliceMs : Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = Math.max(Date.now(), slot.next);
      slot.next = at + THROTTLE_MS;
      if (at >= deadline) break;
      const cost = (at - Date.now()) + (src.down ? ATTEMPT_TIMEOUT_MS : src.ms!);
      const budget = deadline - Date.now();
      if (cost > budget) { await sleep(budget); break; }
      await sleep(cost);
      if (!src.down) return [src.name];
    }
    throw new Error(`${src.name} failed`);
  };
}

async function modelPerBook(opts: { sources: ModelSrc[]; concurrency: number; sliceMs?: number; pyDelay: boolean }) {
  const slot = { next: 0 };
  const { ms } = await drive(searchSources({
    sources: opts.sources, signal: new AbortController().signal, hostKey: (s: ModelSrc) => s.host,
    searchOne: modelSearchOne(slot, opts.sliceMs), concurrency: opts.concurrency, onError: () => {},
  }));
  return { search: ms, total: COLD_START_MS + POOL_DB_MS + ms + (opts.pyDelay ? PY_SEARCH_DELAY_MS : 0) };
}

describe('mock 延迟模型：每本耗时 改前 vs 改后', () => {
  it('改前（全池串行 + 重复搜宕机 book15 + 熔断后仍睡 1.5s）≈ 24s，与 phoenix 实测吻合', async () => {
    vi.useFakeTimers();
    const before = await modelPerBook({ sources: [BOOK15, ...ENGINE], concurrency: 1, pyDelay: true });
    // book15 两次尝试各卡 8s + 3 源各 0.8s（节流是「起始间隔 ≥350ms」，前一请求已超过 350ms 时不额外等）
    expect(before.search).toBe(2 * ATTEMPT_TIMEOUT_MS + 3 * 800);
    expect(before.total).toBeGreaterThanOrEqual(23_000);
    expect(before.total).toBeLessThanOrEqual(26_000);
    console.log(`[model] 改前每本 ${before.total}ms（搜索段 ${before.search}ms）`);
  });

  it('改后（--no-builtin + 按站有界并发 + 切片 + 熔断时不睡 + 垃圾源跳过）每本 ≤ 5s', async () => {
    vi.useFakeTimers();
    // 垃圾源在本轮被判「查询不敏感」后经 --skip-host 剔除（前 3 本仍会搜它，见 douban_list 判据）。
    const afterSteady = await modelPerBook({
      sources: ENGINE.filter((s) => s.name !== 'junk'), concurrency: SEARCH_HOST_CONCURRENCY,
      sliceMs: SEARCH_SOURCE_SLICE_MS, pyDelay: false,
    });
    const afterWarm = await modelPerBook({
      sources: ENGINE, concurrency: SEARCH_HOST_CONCURRENCY, sliceMs: SEARCH_SOURCE_SLICE_MS, pyDelay: false,
    });
    expect(afterSteady.total).toBeLessThanOrEqual(5_000);
    expect(afterWarm.total).toBeLessThanOrEqual(5_000);
    console.log(`[model] 改后每本 ${afterSteady.total}ms（垃圾源已剔除）/ ${afterWarm.total}ms（剔除前）`);
  });

  it('反例：只去掉重复 book15、仍串行时，一个卡死的引擎源还是会吃满 2×8s；切片把它压到 9s', async () => {
    vi.useFakeTimers();
    const hung: ModelSrc = { name: 'hung', host: 'hung.example', down: true };
    const serial = await modelPerBook({ sources: [hung, ...ENGINE], concurrency: 1, pyDelay: false });
    const sliced = await modelPerBook({
      sources: [hung, ...ENGINE], concurrency: SEARCH_HOST_CONCURRENCY, sliceMs: SEARCH_SOURCE_SLICE_MS, pyDelay: false,
    });
    expect(serial.search).toBeGreaterThanOrEqual(16_350);
    expect(sliced.search).toBeLessThanOrEqual(SEARCH_SOURCE_SLICE_MS);
    console.log(`[model] 有卡死源：串行搜索段 ${serial.search}ms → 并发+切片 ${sliced.search}ms`);
  });
});

describe('--skip-host 过滤口径（esprev41 ③）', () => {
  // 身份 host（url）与请求 host（searchUrl）不同的源：跳过键只认身份 host。
  const mirror = { name: 'mirror', url: 'https://www.mirror.example', searchUrl: 'https://search.shared.example/s?q={{key}}' };
  const other = { name: 'other', url: 'https://other.example', searchUrl: 'https://search.shared.example/t?q={{key}}' };
  const plain = { name: 'plain', url: 'https://plain.example', searchUrl: '/search?q={{key}}' };

  it('按身份 host 跳过，候选 source 字段同口径', () => {
    expect(sourceHostOf(mirror)).toBe('www.mirror.example');
    expect(excludeSkippedSources([mirror, other, plain], ['www.mirror.example']).map((s) => s.name))
      .toEqual(['other', 'plain']);
  });

  it('不按请求 host 跳过：共用搜索服务器的其余源不被连坐', () => {
    expect(excludeSkippedSources([mirror, other, plain], ['search.shared.example']).map((s) => s.name))
      .toEqual(['mirror', 'other', 'plain']);
  });

  it('无跳过名单时原样返回；url 解析不了的源不会被任何 host 命中', () => {
    const list = [mirror, plain];
    expect(excludeSkippedSources(list, [])).toBe(list);
    expect(excludeSkippedSources([{ name: 'bad', url: 'not a url' }], ['www.mirror.example']).map((s) => s.name))
      .toEqual(['bad']);
  });
});
