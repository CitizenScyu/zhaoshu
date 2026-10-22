// @vitest-environment jsdom
// 会话换代可以取消 transport，但组件本地 signal 尚未随 React 卸载取消。
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSourceFanout } from './useSourceFanout';
import type { ProbeCache } from './useSourceFanout';

const owner = vi.hoisted(() => ({ current: 1, isCurrentSession: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({
  sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const sources = Array.from({ length: 8 }, (_, i) => ({ url: `https://source${i}.example`, name: `合成源${i}`, tier: 'M1', readable: true }));
const miss = () => Response.json({ status: 'miss', readable: true });
const props = (apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, cache: ProbeCache) => ({
  apiFetch, title: '合成书', author: '合成作者', cache,
});
beforeEach(() => {
  owner.current = 1;
  owner.isCurrentSession.mockImplementation((expected: number) => expected === owner.current);
});
afterEach(cleanup);

it.each(['session-reject', 'session-resolve', 'normal', 'unmount'])('首批探测落定后：%s', async mode => {
  const pending: Array<ReturnType<typeof deferred<Response>> & { signal?: AbortSignal }> = [];
  const cache: ProbeCache = new Map();
  const apiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('?')) return Response.json({ sources });
    const item = { ...deferred<Response>(), signal: init?.signal as AbortSignal };
    pending.push(item);
    return item.promise;
  });
  const ui = renderHook(() => useSourceFanout(props(apiFetch, cache)));
  await waitFor(() => expect(pending).toHaveLength(4));
  if (mode.startsWith('session')) owner.current = 2;
  if (mode === 'unmount') {
    ui.unmount();
    expect(pending.every(item => item.signal?.aborted)).toBe(true);
  }
  await act(async () => {
    for (const item of pending.slice(0, 4)) {
      if (mode === 'session-reject') item.reject(new DOMException('合成旧代际传输中止', 'AbortError'));
      else item.resolve(miss());
    }
  });
  expect(pending).toHaveLength(mode === 'normal' ? 8 : 4);
  if (mode === 'normal') {
    await act(async () => { for (const item of pending.slice(4)) item.resolve(miss()); });
    expect(ui.result.current.phase).toBe('done');
    expect(cache.size).toBe(8);
  } else expect(cache.size).toBe(0);
});

it('候选正文迟到时已经换代，不启动首批探测', async () => {
  const body = deferred<unknown>();
  const cache: ProbeCache = new Map();
  let bodyStarted = false;
  const apiFetch = vi.fn(async () => {
    const response = Response.json({});
    response.json = () => { bodyStarted = true; return body.promise; };
    return response;
  });
  renderHook(() => useSourceFanout(props(apiFetch, cache)));
  await waitFor(() => expect(bodyStarted).toBe(true));
  owner.current = 2;
  await act(async () => { body.resolve({ sources }); });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('旧面板重新检测按钮不在新代际重启扫描', async () => {
  const cache: ProbeCache = new Map();
  const apiFetch = vi.fn(async () => Response.json({ sources: [] }));
  const ui = renderHook(() => useSourceFanout(props(apiFetch, cache)));
  await waitFor(() => expect(ui.result.current.phase).toBe('done'));
  owner.current = 2;
  await act(async () => { ui.result.current.rescan(); });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

// 46-probecool 的客户端后果：服务端把 429 冷却记忆提升成进程级共享之后，冷却期内的 probe 会稳定
// 返回「unreachable + requests:0」——根本没联系该站。这种结果若入缓存，rescan 也不会出网，
// 冷却到期后面板仍显示 unreachable，只有刷新页面才好。
const oneSource = () => Response.json({ sources: sources.slice(0, 1) });
const unreachable = (requests: number, code: string) => Response.json({
  status: 'unreachable', code, readable: true, requests, elapsedMs: requests * 450,
  sourceUrl: sources[0].url, sourceName: sources[0].name,
});

it('被本地冷却拦下的 unreachable(requests:0) 不入缓存：重新检测会再出网', async () => {
  const cache: ProbeCache = new Map();
  let probes = 0;
  const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes('?')) return oneSource();
    probes++;
    return unreachable(0, 'SOURCE_UNAVAILABLE');
  });
  const ui = renderHook(() => useSourceFanout(props(apiFetch, cache)));
  await waitFor(() => expect(ui.result.current.phase).toBe('done'));
  expect(probes).toBe(1);
  expect(cache.size).toBe(0);
  await act(async () => { ui.result.current.rescan(); });
  await waitFor(() => expect(probes).toBe(2));
});

it('真打过上游的 unreachable(requests>0) 照旧入缓存：重新检测不重复出网计数', async () => {
  const cache: ProbeCache = new Map();
  let probes = 0;
  const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes('?')) return oneSource();
    probes++;
    return unreachable(2, 'SOURCE_HTTP_5XX');
  });
  const ui = renderHook(() => useSourceFanout(props(apiFetch, cache)));
  await waitFor(() => expect(ui.result.current.phase).toBe('done'));
  expect(probes).toBe(1);
  expect(cache.size).toBe(1);
  await act(async () => { ui.result.current.rescan(); });
  await waitFor(() => expect(ui.result.current.phase).toBe('done'));
  expect(probes).toBe(1);
});
