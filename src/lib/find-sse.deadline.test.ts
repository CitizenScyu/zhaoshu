import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { consumeFindSSE, fetchFindResult } from './find-sse';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function streamingResponse(status = 200, initial = '', cancel = vi.fn()) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { if (initial) controller.enqueue(new TextEncoder().encode(initial)); },
    cancel,
  }), { status, headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('找书整步共享请求预算', () => {
  it('等响应头也会超时，并把真正传给 transport 的信号中止', async () => {
    const headers = deferred<Response>();
    const fetch = vi.fn<(signal: AbortSignal) => Promise<Response>>(() => headers.promise);
    const pending = fetchFindResult(new AbortController().signal, fetch, 20, () => {});
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(fetch.mock.calls[0][0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('HTTP 错误正文停住时超时，关闭并释放正文 reader', async () => {
    const cancel = vi.fn();
    const response = streamingResponse(503, '{"error":', cancel);
    const pending = fetchFindResult(new AbortController().signal, async () => response, 20, () => {});
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('响应头前主动取消，不依赖 transport 自己遵守 signal', async () => {
    const controller = new AbortController();
    const headers = deferred<Response>();
    const pending = fetchFindResult(controller.signal, () => headers.promise, 60_000, () => {});
    const failed = expect(pending).rejects.toThrow('找书已取消');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('响应头已到但尚未交给 reader 时取消，正文仍恰好取消一次', async () => {
    // 让原生微任务调度重现 headers adoption 与 await 续体之间的边界。
    vi.useRealTimers();
    const controller = new AbortController();
    const headers = deferred<Response>();
    const response = streamingResponse();
    const cancel = vi.spyOn(response.body!, 'cancel');
    const pending = fetchFindResult(controller.signal, () => headers.promise, 1000, () => {});
    const failed = expect(pending).rejects.toThrow('找书已取消');
    await nextTurn();
    void headers.promise.then(() => queueMicrotask(() => controller.abort()));
    headers.resolve(response);
    await failed;
    await nextTurn();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('调用前已经取消时不启动 transport', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    await expect(fetchFindResult(controller.signal, fetch, 20, () => {})).rejects.toThrow('找书已取消');
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('超时后才到达的 Response 仍取消正文，迟到失败也有拒绝处理', async () => {
    const headers = deferred<Response>();
    const pending = fetchFindResult(new AbortController().signal, () => headers.promise, 20, () => {});
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    const cancel = vi.fn();
    headers.resolve(streamingResponse(200, '', cancel));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);

    const failure = deferred<Response>();
    const second = fetchFindResult(new AbortController().signal, () => failure.promise, 20, () => {});
    const secondFailed = expect(second).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await secondFailed;
    failure.reject(new Error('late transport failure'));
    await vi.advanceTimersByTimeAsync(0); // Vitest 也会捕获未处理拒绝。
    expect(vi.getTimerCount()).toBe(0);
  });

  it('响应头花掉的时间不会在 SSE 开始后重新获得', async () => {
    const cancel = vi.fn();
    const response = streamingResponse(200, '', cancel);
    let outcome = 'pending';
    const pending = fetchFindResult(new AbortController().signal,
      () => new Promise(resolve => setTimeout(() => resolve(response), 30)), 50, () => {});
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    void pending.catch(() => { outcome = 'rejected'; });
    await vi.advanceTimersByTimeAsync(49);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SSE 读流中主动取消会结束，移除外部 abort listener', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const cancel = vi.fn();
    const response = streamingResponse(200, '', cancel);
    const pending = fetchFindResult(controller.signal, async () => response, 1000, () => {});
    const failed = expect(pending).rejects.toThrow('找书已取消');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('result 终帧立即完成并清理；底层 cancel 不结束也不会卡住结果', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = streamingResponse(200,
      'data: {"type":"progress","done":1}\n\ndata: {"type":"result","items":[]}\n\ndata: {"type":"progress","done":99}\n\n', cancel);
    const progress = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const result = await fetchFindResult(controller.signal, async signal => { requestSignal = signal; return response; }, 1000, progress);
    expect(result).toMatchObject({ type: 'result', items: [] });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(requestSignal?.aborted).toBe(false);
  });

  it('HTTP 错误保留后端 code，坏正文使用通用错误，均清理预算', async () => {
    await expect(fetchFindResult(new AbortController().signal, async () => new Response(
      '{"error":"票据失效","code":"VERIFY_TICKET_INVALID"}', { status: 400 }), 20, () => {}))
      .rejects.toMatchObject({ message: '票据失效', code: 'VERIFY_TICKET_INVALID' });
    await expect(fetchFindResult(new AbortController().signal, async () => new Response('null', { status: 503 }), 20, () => {}))
      .rejects.toThrow('找书失败，请重试');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transport 同步抛错仍清理 timer 和外部监听', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(fetchFindResult(controller.signal, () => { throw new Error('synthetic transport failure'); }, 20, () => {}))
      .rejects.toThrow('synthetic transport failure');
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('独立 SSE 消费超时不会被永不完成的 cancel 钩住', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = streamingResponse(200, '', cancel);
    const pending = consumeFindSSE(response, new AbortController().signal, 20, () => {});
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
