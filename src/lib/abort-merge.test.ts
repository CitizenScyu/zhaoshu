import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAbortSignals, timeoutSignal } from './abort-merge';

describe('mergeAbortSignals：手工合并多个 AbortSignal', () => {
  it('任一源 signal 中止都能传播到合并后的 signal', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals([a.signal, b.signal]);
    expect(merged.signal.aborted).toBe(false);

    b.abort('from-b');

    expect(merged.signal.aborted).toBe(true);
    expect(merged.signal.reason).toBe('from-b');
    // 另一个源之后再中止，不改变已经传播的原因。
    a.abort('from-a');
    expect(merged.signal.reason).toBe('from-b');
    merged.dispose();
  });

  it('传入时已中止的 signal 立即传播，不等待事件', () => {
    const already = new AbortController();
    already.abort('already-dead');
    const other = new AbortController();

    const merged = mergeAbortSignals([other.signal, already.signal]);

    expect(merged.signal.aborted).toBe(true);
    expect(merged.signal.reason).toBe('already-dead');
    merged.dispose();
  });

  it('dispose 之后源 signal 的监听被移除：再中止不再传播', () => {
    const source = new AbortController();
    const removeSpy = vi.spyOn(source.signal, 'removeEventListener');
    const merged = mergeAbortSignals([source.signal]);

    merged.dispose();

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    source.abort('too-late');
    expect(merged.signal.aborted).toBe(false);
    removeSpy.mockRestore();
  });
  // 中止即终态:合并信号一旦中止,源监听立刻摘掉。owner-session 的中止信号要活到响应体
  // 读完,拿不到「fetch 落定就 dispose」的时机;不自动摘掉的话,会话关闭会把 listener
  // 永远挂在长寿命 controller.signal 上。
  it('源 signal 中止后自动摘掉自身及其余源的监听', () => {
    const a = new AbortController();
    const b = new AbortController();
    const removeA = vi.spyOn(a.signal, 'removeEventListener');
    const removeB = vi.spyOn(b.signal, 'removeEventListener');
    const merged = mergeAbortSignals([a.signal, b.signal]);

    a.abort('dead');

    expect(merged.signal.aborted).toBe(true);
    expect(removeA).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeB).toHaveBeenCalledWith('abort', expect.any(Function));
    removeA.mockRestore();
    removeB.mockRestore();
  });
});

describe('timeoutSignal:手工实现 AbortSignal.timeout,但定时器可清', () => {
  afterEach(() => vi.useRealTimers());

  it('到点按 TimeoutError 中止(与 AbortSignal.timeout 同形)', () => {
    vi.useFakeTimers();
    const { signal } = timeoutSignal(50);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(50);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('dispose 清掉定时器:成功路径不再有过期中止', () => {
    vi.useFakeTimers();
    const { signal, dispose } = timeoutSignal(50);
    dispose();
    vi.advanceTimersByTime(10_000);
    // AbortSignal.timeout 的内建定时器在这里仍会 abort,给已经结束的请求记假的 ERR_ABORTED。
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
