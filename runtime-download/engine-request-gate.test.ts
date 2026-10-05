// createSourceTransport 把限速许可组合进物理门后的接线语义。
// 判别力（删掉修复即失败）：
//   - 单页直取：acquire 恰一次、记初始 host（无初始双扣）；
//   - 传输失败换备用 host：初始与备用各 acquire 一次，成功反馈归返回 page.url 的 host；
//   - HTTP 失败：反馈归 responseHost（真正返回响应的站），不把备用 host 记到初始 host；
//   - 异步物理门拒绝（限速排队被拒）：零 fetch、不把门拒绝当源站失败；
//   - 门拒绝即使带数字 status/retryAfterMs（普通 Error）也不是源站行为，不记 recordFailure；
//   - 调用方已有 beforeFetch 物理策略门先走，再取限速许可；
//   - beforeRequest 预算回调保留、换 host 重试不重复扣（skipFirstBeforeRequest 合同不变）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceTransport, type RateLimiterLike } from './engine';

// 与 src/lib/source-fetch.test.ts 同款约定：传输语义用例以 book15 为载体，把 isRetiredBuiltinHost
// 钉成 false（等价「book15 仍活跃」的注册表形态）——fetchSourceText 的退休门在每次物理发射前收口，
// 真实注册表里 book15 lifecycle='retired' 会把这些用例全拦成 SourcePolicyError，测不到限速接线。
const gate = vi.hoisted(() => ({ realRetiredGate: false }));
vi.mock('../src/lib/supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/supported-sources')>();
  return {
    ...actual,
    isRetiredBuiltinHost: (host: string) => (gate.realRetiredGate ? actual.isRetiredBuiltinHost(host) : false),
  };
});

afterEach(() => vi.unstubAllGlobals());

function fakeLimiter(): RateLimiterLike & { acquireCalls: string[]; success: string[]; failures: { key: string; opts?: { retryAfterMs?: number } }[] } {
  const acquireCalls: string[] = [];
  const success: string[] = [];
  const failures: { key: string; opts?: { retryAfterMs?: number } }[] = [];
  return {
    acquireCalls, success, failures,
    async acquire(key) { acquireCalls.push(key); },
    recordSuccess(key) { success.push(key); },
    recordFailure(key, opts) { failures.push({ key, opts }); },
  };
}

const opts = () => ({ signal: new AbortController().signal });
const transportFailure = new TypeError('fetch failed');

describe('createSourceTransport 逐 host 限速（bphysical788）', () => {
  it('单页直取：acquire 恰一次且在 fetch 前，recordSuccess(host) 归初始 host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    const page = await transport('https://book15.net/x', opts());
    expect(page.text).toBe('正文');
    expect(limiter.acquireCalls).toEqual(['book15.net']); // 无初始双扣
    expect(limiter.success).toEqual(['book15.net']);
    expect(limiter.failures).toHaveLength(0);
  });

  it('传输失败换备用 host：初始与备用各 acquire 一次，成功反馈归 page.url 的 host', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    const page = await transport('https://book15.net/x', opts());
    expect(page.url).toBe('https://www.book15.net/x');
    expect(limiter.acquireCalls).toEqual(['book15.net', 'www.book15.net']); // 每次物理发射各一次
    expect(limiter.success).toEqual(['www.book15.net']); // 归实际返回正文的 host，不记初始 host
    expect(limiter.failures).toHaveLength(0); // 传输失败不是源站失败
  });

  it('HTTP 失败：recordFailure 归 responseHost（真正返回响应的站），带 Retry-After 传 retryAfterMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '5' } }));
    vi.stubGlobal('fetch', fetchMock);
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toMatchObject({ status: 429 });
    expect(limiter.failures).toEqual([{ key: 'book15.net', opts: { retryAfterMs: 5000 } }]);
  });

  it('传输失败后备用 host 返回 5xx：反馈归备用 host，不把失败记到初始 host', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toMatchObject({ status: 503 });
    expect(limiter.acquireCalls).toEqual(['book15.net', 'www.book15.net']);
    expect(limiter.failures).toEqual([{ key: 'www.book15.net', opts: undefined }]);
  });

  it('异步限速许可拒绝：零 fetch、不把门拒绝当源站失败（无 recordFailure）', async () => {
    const gateStop = new Error('limiter refused');
    const limiter = fakeLimiter();
    limiter.acquire = async () => { throw gateStop; };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toBe(gateStop);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.failures).toHaveLength(0); // 策略/许可拒绝不是源站行为
    expect(limiter.success).toHaveLength(0);
  });

  it('限速许可拒绝带 status/retryAfterMs：仍是门拒绝，不记 recordFailure', async () => {
    // 门拒绝的反例形态：acquire 抛普通 Error 但带 status=429/retryAfterMs——物理 fetch
    // 之前发生，不是源站行为，不得因数字 status 误入熔断/退避反馈。
    const gateStop = Object.assign(new Error('limiter refused'), { status: 429, retryAfterMs: 5000 });
    const limiter = fakeLimiter();
    limiter.acquire = vi.fn(async () => { throw gateStop; });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', opts())).rejects.toBe(gateStop); // 原错误原样上抛
    expect(limiter.acquire).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.failures).toHaveLength(0);
    expect(limiter.success).toHaveLength(0);
  });

  it('调用方物理策略门拒绝带 status/retryAfterMs：零 acquire、不记 recordFailure', async () => {
    // 与上一例同型，但拒绝点在 callerGate：门顺序保证 acquire 根本不发生。
    const policyStop = Object.assign(new Error('cooldown'), { status: 429, retryAfterMs: 5000 });
    const callerGate = vi.fn(async () => { throw policyStop; });
    const limiter = fakeLimiter();
    const acquireSpy = vi.spyOn(limiter, 'acquire');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', { ...opts(), beforeFetch: callerGate })).rejects.toBe(policyStop);
    expect(callerGate).toHaveBeenCalledOnce();
    expect(acquireSpy).not.toHaveBeenCalled(); // 策略门不过连许可都不取
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.failures).toHaveLength(0);
    expect(limiter.success).toHaveLength(0);
  });

  it('调用方已有物理策略门先走，再取限速许可；两门都过才发射', async () => {
    const order: string[] = [];
    const callerGate = vi.fn(async () => { order.push('caller-gate'); });
    const limiter = fakeLimiter();
    const acquireReal = limiter.acquire;
    limiter.acquire = async (key: string) => { order.push(`acquire:${key}`); await acquireReal(key); };
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createSourceTransport(limiter);
    await transport('https://book15.net/x', { ...opts(), beforeFetch: callerGate });
    expect(order).toEqual(['caller-gate', 'acquire:book15.net']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('调用方物理策略门拒绝：零 fetch、无 acquire、不触发换 host 重试', async () => {
    const policyStop = new Error('cooldown');
    const callerGate = vi.fn(async () => { throw policyStop; });
    const limiter = fakeLimiter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = createSourceTransport(limiter);
    await expect(transport('https://book15.net/x', { ...opts(), beforeFetch: callerGate })).rejects.toBe(policyStop);
    expect(callerGate).toHaveBeenCalledOnce();
    expect(limiter.acquireCalls).toHaveLength(0); // 门顺序：策略门不过连许可都不取
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('beforeRequest 预算回调保留：每次逻辑请求照常扣，换 host 重试不重复扣', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    const limiter = fakeLimiter();
    const transport = createSourceTransport(limiter);
    await transport('https://book15.net/x', { ...opts(), beforeRequest });
    expect(beforeRequest).toHaveBeenCalledOnce(); // 备用 host 首发不重复扣预算
    expect(limiter.acquireCalls).toEqual(['book15.net', 'www.book15.net']); // 许可按物理发射计
  });

  it('无 limiter 时调用方物理门仍组合生效（传输层不因 limiter 缺席失去门）', async () => {
    const callerGate = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createSourceTransport(undefined);
    await transport('https://book15.net/x', { ...opts(), beforeFetch: callerGate });
    expect(callerGate).toHaveBeenCalledWith(expect.any(AbortSignal), 'https://book15.net/x');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
