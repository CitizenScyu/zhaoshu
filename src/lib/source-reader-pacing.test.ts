import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceRequestContext } from './source-reader';

// source-reader 的请求节流（SOURCE_DELAY_MS = 350）必须在并发 page() 下仍然成立：
// 否则 verify 阶段的有限并发会把「间隔 350ms」退化成「一批一起打」。
// 串行语义由 source-reader.test.ts 的既有用例覆盖，这里只钉并发路径。
describe('source request pacing under concurrent page() calls', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
