// 仅测反馈错误边界；真实HTTP/物理门集成断言保留在engine-request-gate.test.ts。
// 完整替换engine的外部模块，避免本组用例加载真实配置、数据库或网络实现。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceTransport, LimiterFeedbackError } from './engine';

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
  return { acquire: vi.fn(async () => {}), recordSuccess: vi.fn(), recordFailure: vi.fn() };
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
