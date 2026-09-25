import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceRequestContext, sourceStationKey, sourceThrottleKey } from './source-reader';
import { refreshSupportedHosts } from './source-policy';

// source-reader 的请求节流（SOURCE_DELAY_MS = 350）必须在并发 page() 下仍然成立：
// 否则 verify 阶段的有限并发会把「间隔 350ms」退化成「一批一起打」。
// 串行语义由 source-reader.test.ts 的既有用例覆盖，这里只钉并发路径。
describe('source request pacing under concurrent page() calls', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); refreshSupportedHosts([]); });

  it('gives each concurrent request its own slot instead of bursting them together', async () => {
    // 真实计时器：三次 page() 在同一 tick 发起，正是并发补验的调用形状。
    const starts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(Date.now());
      return new Response('<html></html>', { status: 200 });
    }));
    const context = new SourceRequestContext(new AbortController().signal, 10);
    await Promise.all([
      context.page('https://book15.net/a'),
      context.page('https://book15.net/b'),
      context.page('https://book15.net/c'),
    ]);
    expect(starts).toHaveLength(3);
    // 槽位间隔约 350ms；给调度留余量，只要求明显大于突发（<50ms）且不小于 300ms。
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(300);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(300);
  });
});

// 41-fanout P1-C：节流槽按 host 分桶。同站仍 350ms 一个槽，异站互不等待；总请求数预算（L2）不变。
describe('per-host pacing buckets (41-fanout P1-C)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); refreshSupportedHosts([]); });

  const recordStarts = () => {
    const starts = new Map<string, number>();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      starts.set(String(input), Date.now());
      return new Response('<html></html>', { status: 200 });
    }));
    return starts;
  };

  it('different hosts do not wait for each other (<50ms), same host still >= 350ms apart', async () => {
    refreshSupportedHosts(['alpha.test', 'beta.test', 'gamma.test']);
    const starts = recordStarts();
    const context = new SourceRequestContext(new AbortController().signal, 10);
    const t0 = Date.now();
    await Promise.all([
      context.page('https://alpha.test/1'),
      context.page('https://beta.test/1'),
      context.page('https://gamma.test/1'),
      context.page('https://alpha.test/2'),
    ]);
    // 三个异站请求都在起点附近发出，互不排队。
    for (const url of ['https://alpha.test/1', 'https://beta.test/1', 'https://gamma.test/1']) {
      expect(starts.get(url)! - t0).toBeLessThan(50);
    }
    // 同站第二个请求仍占下一个 350ms 槽（定时器粒度留 10ms 余量）。
    expect(starts.get('https://alpha.test/2')! - starts.get('https://alpha.test/1')!).toBeGreaterThanOrEqual(340);
  });

  it('parent and child contexts share the per-host buckets', async () => {
    refreshSupportedHosts(['alpha.test', 'beta.test']);
    const starts = recordStarts();
    const root = new SourceRequestContext(new AbortController().signal, 10);
    const child = root.child('https://beta.test/');
    const t0 = Date.now();
    await Promise.all([
      root.page('https://alpha.test/1'),
      child.page('https://beta.test/1'),
      child.page('https://alpha.test/2'),
    ]);
    expect(starts.get('https://beta.test/1')! - t0).toBeLessThan(50);
    expect(starts.get('https://alpha.test/2')! - starts.get('https://alpha.test/1')!).toBeGreaterThanOrEqual(340);
  });

  it('total request budget still applies across hosts', async () => {
    refreshSupportedHosts(['alpha.test', 'beta.test', 'gamma.test']);
    recordStarts();
    const context = new SourceRequestContext(new AbortController().signal, 2);
    const results = await Promise.allSettled([
      context.page('https://alpha.test/1'),
      context.page('https://beta.test/1'),
      context.page('https://gamma.test/1'),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'SOURCE_BUDGET_EXCEEDED', status: 503 },
    });
    expect(context.requests).toBe(2);
  });

  it('apex and www of the same station share one bucket', () => {
    expect(sourceThrottleKey('https://book15.net/a')).toBe(sourceThrottleKey('https://www.book15.net/b'));
    expect(sourceThrottleKey('https://alpha.test/a')).not.toBe(sourceThrottleKey('https://beta.test/a'));
    // 站键(扇出候选的 hostKey)与节流按站分桶同一口径。
    expect(sourceStationKey('https://www.book15.net/b')).toBe(sourceThrottleKey('https://book15.net/a'));
    expect(sourceStationKey('https://www.book15.net/b')).toBe('book15.net');
  });

  it('SOURCE_THROTTLE_PER_HOST=0 rolls back to one global slot', async () => {
    vi.stubEnv('SOURCE_THROTTLE_PER_HOST', '0');
    refreshSupportedHosts(['alpha.test', 'beta.test']);
    const starts = recordStarts();
    const context = new SourceRequestContext(new AbortController().signal, 10);
    await Promise.all([context.page('https://alpha.test/1'), context.page('https://beta.test/1')]);
    expect(starts.get('https://beta.test/1')! - starts.get('https://alpha.test/1')!).toBeGreaterThanOrEqual(300);
  });
});
