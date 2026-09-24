import { describe, expect, it, vi } from 'vitest';
import { mergeAbortSignals } from './abort-merge';

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
});
