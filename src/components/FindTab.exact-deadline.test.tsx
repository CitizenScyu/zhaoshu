// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXACT_SEARCH_TIMEOUT_MS } from '@/lib/exact-search-request';
import FindTab from './FindTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({
  useOwner: () => ({ apiFetch: mocks.apiFetch, user: { id: 7 }, ready: true, can: () => true }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function emptyResponse() {
  return new Response(JSON.stringify({ source: 'none', items: [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function start() {
  const view = render(<FindTab />);
  fireEvent.click(screen.getByRole('tab', { name: '精确找书' }));
  fireEvent.change(screen.getByRole('textbox', { name: '书名' }), { target: { value: '合成书名' } });
  fireEvent.click(screen.getByRole('button', { name: '精确查找' }));
  return view;
}

async function flush() {
  // readerlocal42 快照 effect 落定后会 sessionStorage.setItem;jsdom 的 setItem 内部
  // 排一个 setTimeout(0) 派发 storage 事件,fake timers 不走零毫就挂着。这里推进 0ms
  // 只消化该内部任务,不会提前触发 35s 期限。
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function expire() {
  await act(async () => { await vi.advanceTimersByTimeAsync(EXACT_SEARCH_TIMEOUT_MS); });
}

beforeEach(() => { vi.useFakeTimers(); mocks.apiFetch.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('精确搜索整体期限与恢复', () => {
  it('响应头停滞后超时；切模式仍保留请求，重试成功且迟到响应不能覆盖它', async () => {
    const first = deferred<Response>();
    mocks.apiFetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(emptyResponse());
    start();
    const signal = mocks.apiFetch.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('tab', { name: '口味推荐' }));
    fireEvent.click(screen.getByRole('tab', { name: '精确找书' }));
    expect((screen.getByRole('button', { name: '检索中…' }) as HTMLButtonElement).disabled).toBe(true);
    await expire();
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('精确找书超时，请重试');
    expect((screen.getByRole('button', { name: '精确查找' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '精确查找' }));
    await flush();
    expect(screen.getByText(/豆瓣未收录这本书/)).toBeTruthy();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const json = vi.fn();
    first.resolve({ body: { cancel }, json } as unknown as Response);
    await flush();
    expect(cancel).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/豆瓣未收录这本书/)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('200 正文停滞也在同一期限内恢复，cancel 永不落定不阻塞重试', async () => {
    const body = deferred<unknown>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, status: 200, body: { cancel }, json: () => body.promise })
      .mockResolvedValueOnce(emptyResponse());
    start();
    await flush();
    await expire();
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('精确找书超时，请重试');
    fireEvent.click(screen.getByRole('button', { name: '精确查找' }));
    await flush();
    body.resolve({ source: 'douban', items: [{ title: '迟到旧书' }] });
    await flush();
    expect(screen.queryByText('迟到旧书')).toBeNull();
    expect(screen.getByText(/豆瓣未收录这本书/)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('成功后释放期限，之后不会取消成功请求', async () => {
    mocks.apiFetch.mockResolvedValue(emptyResponse());
    start();
    await flush();
    const signal = mocks.apiFetch.mock.calls[0][1].signal as AbortSignal;
    expect(vi.getTimerCount()).toBe(0);
    await expire();
    expect(signal.aborted).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/豆瓣未收录这本书/)).toBeTruthy();
  });

  it.each(['headers', 'body'])('卸载时静默取消 %s 阶段并释放计时器', async (stage) => {
    const pending = deferred<Response>();
    const cancel = vi.fn(() => Promise.resolve());
    mocks.apiFetch.mockImplementation(() => stage === 'headers' ? pending.promise : Promise.resolve({
      ok: true, status: 200, body: { cancel }, json: () => new Promise(() => {}),
    }));
    const view = start();
    await flush();
    const signal = mocks.apiFetch.mock.calls[0][1].signal as AbortSignal;
    view.unmount();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('响应头等待消耗正文的剩余预算，不另起完整期限', async () => {
    const headers = deferred<Response>();
    mocks.apiFetch.mockReturnValue(headers.promise);
    start();
    await act(async () => { await vi.advanceTimersByTimeAsync(EXACT_SEARCH_TIMEOUT_MS - 1); });
    headers.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('alert').textContent).toContain('精确找书超时，请重试');
    expect(vi.getTimerCount()).toBe(0);
  });
});
