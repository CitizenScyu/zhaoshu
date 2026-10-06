// 仅测反馈错误与permit接线边界；真实HTTP/物理门集成断言保留在engine-request-gate.test.ts。
// 完整替换engine的外部模块，避免本组用例加载真实配置、数据库或网络实现。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceTransport, LimiterFeedbackError, type RateLimiterLike } from './engine';

const source = vi.hoisted(() => ({ fetchSourceText: vi.fn() }));
vi.mock('../src/lib/rule-engine/api', () => ({}));
vi.mock('../src/lib/rule-engine/compile', () => ({}));
vi.mock('../src/lib/shuyuan', () => ({}));
vi.mock('../src/lib/supported-sources', () => ({}));
vi.mock('../src/lib/source-policy', () => ({}));
vi.mock('../src/lib/source-parser', () => ({}));
vi.mock('../src/lib/source-reader', () => ({}));
vi.mock('../src/lib/source-fetch', () => ({ fetchSourceText: source.fetchSourceText }));

const URL = 'https://source.test/chapter';
const PAGE = { url: 'https://result.test/final', text: '合成正文' };
const request = vi.fn();
const realFetch = vi.fn();
type GateOptions = {
  signal: AbortSignal;
  beforeRequest?: (signal: AbortSignal, url?: string) => Promise<void>;
  beforeFetch?: (signal: AbortSignal, url: string) => void | Promise<void>;
};

beforeEach(() => {
  request.mockReset().mockResolvedValue(PAGE);
  realFetch.mockReset().mockImplementation(() => { throw new Error('unexpected real fetch'); });
  vi.stubGlobal('fetch', realFetch);
  source.fetchSourceText.mockReset().mockImplementation(async (url: string, options: GateOptions) => {
    // 模拟source-fetch既有门标记协议，不把这个桩当真实物理请求实现。
    try {
      await options.beforeRequest?.(options.signal, url);
      await options.beforeFetch?.(options.signal, url);
    } catch (error) {
      (error as { fromBeforeRequest?: boolean }).fromBeforeRequest = true;
      throw error;
    }
    return request();
  });
});
afterEach(() => vi.unstubAllGlobals());

function limiter() {
  return {
    acquire: vi.fn<RateLimiterLike['acquire']>(async () => {}),
    recordSuccess: vi.fn<NonNullable<RateLimiterLike['recordSuccess']>>(),
    recordFailure: vi.fn<NonNullable<RateLimiterLike['recordFailure']>>(),
  };
}
const options = () => ({ signal: new AbortController().signal });
const httpError = () => Object.assign(new Error('synthetic HTTP error'), {
  status: 429, retryAfterMs: 5000, responseHost: 'response.test',
});
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function expectFeedback(error: unknown, phase: 'success' | 'failure', feedbackError: unknown, requestError?: unknown) {
  expect(error).toBeInstanceOf(LimiterFeedbackError);
  const wrapped = error as LimiterFeedbackError;
  expect(wrapped).toMatchObject({
    code: 'LIMITER_FEEDBACK_UNAVAILABLE', origin: 'limiter-feedback', phase,
    host: phase === 'success' ? 'result.test' : 'response.test', persistenceOutcome: 'unknown',
  });
  expect(wrapped.message).toBe('Limiter feedback persistence unavailable');
  expect(wrapped.feedbackError).toBe(feedbackError);
  expect(wrapped.cause).toBe(feedbackError);
  expect(wrapped.requestError).toBe(requestError);
  expect(wrapped).not.toHaveProperty('status');
  expect(wrapped).not.toHaveProperty('responseHost');
  expect(wrapped).not.toHaveProperty('retryAfterMs');
  expect(wrapped).not.toBe(requestError);
  return wrapped;
}

describe('createSourceTransport异步反馈隔离', () => {
  it.each(['throw', 'reject'] as const)('成功反馈%s带503不回灌失败反馈', async mode => {
    const value = limiter();
    const failure = Object.assign(new Error('synthetic write failure'), { status: 503 });
    value.recordSuccess.mockImplementation(() => {
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    });
    const result = await createSourceTransport(value)(URL, options()).catch((error: unknown) => error);
    expectFeedback(result, 'success', failure);
    expect(value.recordSuccess).toHaveBeenCalledOnce();
    expect(value.recordSuccess).toHaveBeenCalledWith('result.test');
    expect(value.recordFailure).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)('HTTP429与失败反馈%s分别保留原错误引用', async mode => {
    const value = limiter();
    const original = httpError();
    const failure = new Error('synthetic failure feedback');
    request.mockRejectedValue(original);
    value.recordFailure.mockImplementation(() => {
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    });
    const result = await createSourceTransport(value)(URL, options()).catch((error: unknown) => error);
    expectFeedback(result, 'failure', failure, original);
    expect(value.recordFailure).toHaveBeenCalledOnce();
    expect(value.recordFailure).toHaveBeenCalledWith('response.test', { retryAfterMs: 5000 });
    expect(value.recordSuccess).not.toHaveBeenCalled();
    expect(original).toMatchObject({ status: 429, retryAfterMs: 5000, responseHost: 'response.test' });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['sync', 'async'] as const)('%s失败反馈成功时HTTP错误身份不变', async mode => {
    const value = limiter();
    const original = httpError();
    request.mockRejectedValue(original);
    value.recordFailure.mockImplementation(() => mode === 'sync' ? undefined : Promise.resolve());
    const result = await createSourceTransport(value)(URL, options()).catch((error: unknown) => error);
    expect(result).toBe(original);
    expect(value.recordFailure).toHaveBeenCalledOnce();
    expect(value.recordFailure).toHaveBeenCalledWith('response.test', { retryAfterMs: 5000 });
    expect(value.recordSuccess).not.toHaveBeenCalled();
  });

  it('engine收到E时已因不同A取消：仍反馈E并保留E身份（决策层桩）', async () => {
    const value = limiter();
    const original = httpError();
    const abortReason = Object.assign(new Error('synthetic different abort'), {
      status: 429, retryAfterMs: 9000, responseHost: 'cancel.test',
    });
    const controller = new AbortController();
    // 此桩明确把E交给engine；不借真实source-fetch的响应/取消竞态证明时序。
    request.mockImplementationOnce(async () => { controller.abort(abortReason); throw original; });
    const result = await createSourceTransport(value)(URL, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(abortReason);
    expect(original).not.toBe(abortReason);
    expect(result).toBe(original);
    expect(value.recordFailure).toHaveBeenCalledOnce();
    expect(value.recordFailure).toHaveBeenCalledWith('response.test', { retryAfterMs: 5000 });
    expect(value.recordSuccess).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['callerGate', 'acquire'] as const)('首尝试%s拒绝带429仍零反馈并保留身份', async gate => {
    const value = limiter();
    const stop = Object.assign(new Error('synthetic gate refusal'), { status: 429, retryAfterMs: 5000 });
    const callerGate = vi.fn(async () => { if (gate === 'callerGate') throw stop; });
    if (gate === 'acquire') value.acquire.mockRejectedValue(stop);
    const result = await createSourceTransport(value)(URL, { ...options(), beforeFetch: callerGate })
      .catch((error: unknown) => error);
    expect(result).toBe(stop);
    expect(result).toHaveProperty('fromBeforeRequest', true);
    expect(value.acquire).toHaveBeenCalledTimes(gate === 'acquire' ? 1 : 0);
    expect(value.recordSuccess).not.toHaveBeenCalled();
    expect(value.recordFailure).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('成功反馈在途abort后%s遵守结果优先级', async outcome => {
    const value = limiter();
    const entered = deferred();
    const write = deferred();
    const controller = new AbortController();
    const abortReason = new Error('synthetic abort');
    const failure = new Error('synthetic late write failure');
    value.recordSuccess.mockImplementation(() => { entered.resolve(); return write.promise; });
    let settled = false;
    const pending = createSourceTransport(value)(URL, { signal: controller.signal }).then(
      page => { settled = true; return page; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await entered.promise;
      controller.abort(abortReason);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === 'resolve') write.resolve(); else write.reject(failure);
      const result = await pending;
      if (outcome === 'resolve') expect(result).toBe(abortReason);
      else expect(expectFeedback(result, 'success', failure).abortReason).toBe(abortReason);
      expect(value.recordSuccess).toHaveBeenCalledOnce();
      expect(value.recordSuccess).toHaveBeenCalledWith('result.test');
      expect(value.recordFailure).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      write.resolve();
      await pending;
    }
  });

  it.each(['resolve', 'reject'] as const)('HTTP429反馈在途abort后%s保留E/F/A优先级', async outcome => {
    const value = limiter();
    const original = httpError();
    const entered = deferred();
    const write = deferred();
    const controller = new AbortController();
    const abortReason = new Error('synthetic abort after HTTP');
    const failure = new Error('synthetic failure feedback write');
    request.mockRejectedValue(original);
    value.recordFailure.mockImplementation(() => { entered.resolve(); return write.promise; });
    let settled = false;
    const pending = createSourceTransport(value)(URL, { signal: controller.signal }).then(
      page => { settled = true; return page; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await entered.promise;
      controller.abort(abortReason);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === 'resolve') write.resolve(); else write.reject(failure);
      const result = await pending;
      if (outcome === 'resolve') expect(result).toBe(original);
      else expect(expectFeedback(result, 'failure', failure, original).abortReason).toBe(abortReason);
      expect(value.recordFailure).toHaveBeenCalledOnce();
      expect(value.recordFailure).toHaveBeenCalledWith('response.test', { retryAfterMs: 5000 });
      expect(value.recordSuccess).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      write.resolve();
      await pending;
    }
  });
});

describe('createSourceTransport opaque permit接线（决策层合成桩）', () => {
  const permit = Object.freeze({ tag: 'synthetic opaque permit' });
  const retryUrl = 'https://retry.test/chapter';

  // 只模拟一次指定传输错误后的物理门重入，不验证真实source-fetch重试实现。
  function simulateRetry(retryError: Error) {
    source.fetchSourceText.mockImplementation(async (url: string, gateOptions: GateOptions) => {
      const gate = async (current: string) => {
        try { await gateOptions.beforeFetch?.(gateOptions.signal, current); }
        catch (error) {
          (error as { fromBeforeRequest?: boolean }).fromBeforeRequest = true;
          throw error;
        }
      };
      await gate(url);
      try { return await request(); }
      catch (error) { if (error !== retryError) throw error; }
      await gate(retryUrl);
      return request();
    });
  }

  it.each([permit, null])('成功反馈保留opaque值%j，page.url换host不改绑定', async opaque => {
    const value = limiter();
    value.acquire.mockResolvedValue(opaque);
    await expect(createSourceTransport(value)(URL, options())).resolves.toBe(PAGE);
    expect(value.acquire.mock.calls[0]?.[0]).toBe('source.test');
    expect(value.recordSuccess).toHaveBeenCalledOnce();
    expect(value.recordSuccess).toHaveBeenCalledWith('result.test', { permit: opaque });
    expect(value.recordSuccess.mock.calls[0]?.[1]?.permit).toBe(opaque);
    expect(value.recordFailure).not.toHaveBeenCalled();
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each([
    { opaque: permit, retryAfterMs: 5000 },
    { opaque: permit, retryAfterMs: undefined },
    { opaque: undefined, retryAfterMs: undefined },
  ])('失败反馈保留permit=$opaque和retryAfterMs=$retryAfterMs及旧void形状', async ({ opaque, retryAfterMs }) => {
    const value = limiter();
    value.acquire.mockResolvedValue(opaque);
    const original = Object.assign(new Error('synthetic HTTP error'), { status: 429, responseHost: 'response.test' },
      retryAfterMs === undefined ? {} : { retryAfterMs });
    request.mockRejectedValue(original);
    await expect(createSourceTransport(value)(URL, options())).rejects.toBe(original);
    const failureOptions = retryAfterMs === undefined ? undefined : { retryAfterMs };
    expect(value.recordFailure).toHaveBeenCalledOnce();
    expect(value.recordFailure).toHaveBeenCalledWith('response.test', opaque === undefined
      ? failureOptions : { ...failureOptions, permit: opaque });
    expect(value.recordFailure.mock.calls[0]?.[1]?.permit).toBe(opaque);
    expect(value.recordSuccess).not.toHaveBeenCalled();
  });

  it.each([Object.freeze({ tag: 'second permit' }), undefined])('重试独立acquire，第二许可%j不沿用第一许可', async secondPermit => {
    const value = limiter();
    const retryError = new Error('synthetic retryable transport error');
    simulateRetry(retryError);
    request.mockRejectedValueOnce(retryError);
    value.acquire.mockResolvedValueOnce(permit).mockResolvedValueOnce(secondPermit);
    const opts = options();
    await expect(createSourceTransport(value)(URL, opts)).resolves.toBe(PAGE);
    expect(value.acquire.mock.calls).toEqual([
      ['source.test', { signal: opts.signal }], ['retry.test', { signal: opts.signal }],
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    if (secondPermit === undefined) expect(value.recordSuccess.mock.calls).toEqual([['result.test']]);
    else {
      expect(value.recordSuccess).toHaveBeenCalledOnce();
      expect(value.recordSuccess).toHaveBeenCalledWith('result.test', { permit: secondPermit });
      expect(value.recordSuccess.mock.calls[0]?.[1]?.permit).toBe(secondPermit);
    }
    expect(value.recordFailure).not.toHaveBeenCalled();
  });

  it('重试acquire拒绝带429时不沿用旧permit反馈', async () => {
    const value = limiter();
    const retryError = new Error('synthetic retryable transport error');
    const stop = Object.assign(new Error('synthetic acquire refusal'), { status: 429 });
    simulateRetry(retryError);
    request.mockRejectedValueOnce(retryError);
    value.acquire.mockResolvedValueOnce(permit).mockRejectedValueOnce(stop);
    await expect(createSourceTransport(value)(URL, options())).rejects.toBe(stop);
    expect(value.acquire).toHaveBeenCalledTimes(2);
    expect(stop).toHaveProperty('fromBeforeRequest', true);
    expect(request).toHaveBeenCalledOnce();
    expect(value.recordSuccess).not.toHaveBeenCalled();
    expect(value.recordFailure).not.toHaveBeenCalled();
  });

  it('已获permit后返回同一取消reason，仍零源站反馈', async () => {
    const value = limiter();
    value.acquire.mockResolvedValue(permit);
    const controller = new AbortController();
    const stop = Object.assign(new Error('synthetic caller abort'), { status: 429 });
    request.mockImplementationOnce(async () => { controller.abort(stop); throw stop; });
    await expect(createSourceTransport(value)(URL, { signal: controller.signal })).rejects.toBe(stop);
    expect(value.acquire).toHaveBeenCalledOnce();
    expect(stop).not.toHaveProperty('fromBeforeRequest');
    expect(value.recordSuccess).not.toHaveBeenCalled();
    expect(value.recordFailure).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('携permit的%s反馈拒绝仍只包装原F', async phase => {
    const value = limiter();
    value.acquire.mockResolvedValue(permit);
    const feedbackError = Object.assign(new Error('synthetic feedback failure'), { status: 503 });
    const original = phase === 'failure' ? httpError() : undefined;
    if (original) request.mockRejectedValue(original);
    const feedback = phase === 'success' ? value.recordSuccess : value.recordFailure;
    feedback.mockRejectedValue(feedbackError);
    const result = await createSourceTransport(value)(URL, options()).catch((error: unknown) => error);
    expectFeedback(result, phase, feedbackError, original);
    expect(feedback).toHaveBeenCalledOnce();
    expect(feedback.mock.calls[0]?.[1]?.permit).toBe(permit);
    expect(phase === 'success' ? value.recordFailure : value.recordSuccess).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('同一transport并发交错完成时各自保留许可原引用', async () => {
    const value = limiter();
    const secondPermit = Object.freeze({ tag: 'concurrent permit' });
    value.acquire.mockResolvedValueOnce(permit).mockResolvedValueOnce(secondPermit);
    const entered = deferred();
    const release = deferred();
    source.fetchSourceText.mockImplementation(async (url: string, gateOptions: GateOptions) => {
      await gateOptions.beforeFetch?.(gateOptions.signal, url);
      if (url === URL) { entered.resolve(); await release.promise; }
      return { url, text: '合成正文' };
    });
    const transport = createSourceTransport(value);
    const first = transport(URL, options());
    try {
      await entered.promise;
      await transport(retryUrl, options());
      release.resolve();
      await first;
      expect(value.acquire).toHaveBeenCalledTimes(2);
      expect(value.recordSuccess.mock.calls.map(([host]) => host)).toEqual(['retry.test', 'source.test']);
      expect(value.recordSuccess.mock.calls[0]?.[1]?.permit).toBe(secondPermit);
      expect(value.recordSuccess.mock.calls[1]?.[1]?.permit).toBe(permit);
      expect(value.recordFailure).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await first;
    }
  });
});
