// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StatsTab from './StatsTab';

const owner = vi.hoisted(() => ({ current: 1, apiFetch: vi.fn(), isCurrentSession: vi.fn() }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function stats(name = '合成分类') {
  return { subject: { userId: 1 }, allowedSections: ['library', 'tokens'],
    sectionStates: { library: 'ok', tokens: 'ok' }, sectionScopes: {},
    library: { total: 12, withQuality: 3, avgQuality: 7.5, charsLabeled: 10000, genres: [{ name, count: 4 }] },
    download: null, find: null, shelf: null, shuyuan: null, tokens: null, availability: {} };
}
const json = (value: unknown) => Response.json(value);
const initial = async (input: string) => json(input === '/api/stats' ? stats() : { total: 0, groups: [] });
const timers = new Set<number>();
async function ready() {
  await screen.findByText('合成分类');
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新统计' }) as HTMLButtonElement).disabled).toBe(false));
}
beforeEach(() => {
  owner.current = 1;
  owner.apiFetch.mockReset();
  owner.isCurrentSession.mockImplementation((expected: number) => expected === owner.current);
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-export');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const schedule = (window as Window).setTimeout.bind(window);
  vi.spyOn(window as Window, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    const id = schedule(handler, delay, ...args);
    timers.add(id);
    return id;
  });
});
afterEach(() => {
  cleanup();
  for (const id of timers) window.clearTimeout(id);
  timers.clear();
  vi.restoreAllMocks();
});

it.each(['导出我的数据', '刷新统计'])('旧按钮 %s 不在新代际发请求', async button => {
  owner.apiFetch.mockImplementation(initial);
  render(<StatsTab />);
  await ready();
  const before = owner.apiFetch.mock.calls.length;
  owner.current = 2;
  fireEvent.click(screen.getByRole('button', { name: button }));
  await act(async () => {});
  expect(owner.apiFetch.mock.calls).toHaveLength(before);
});

describe.each(['session', 'unmount', 'normal'])('导出 blob 迟到：%s', mode => {
  it('仅有效页面触发文件下载，正常下载仍释放对象 URL', async () => {
    const body = deferred<Blob>();
    let bodyStarted = false;
    let signal: AbortSignal | undefined;
    owner.apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input !== '/api/export') return initial(input);
      signal = init?.signal as AbortSignal;
      const response = new Response('{}', { headers: { 'Content-Disposition': 'attachment; filename="synthetic.json"' } });
      response.blob = () => { bodyStarted = true; return body.promise; };
      return response;
    });
    const ui = render(<StatsTab />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    await waitFor(() => expect(bodyStarted).toBe(true));
    if (mode === 'session') owner.current = 2;
    if (mode === 'unmount') { ui.unmount(); expect(signal?.aborted).toBe(true); }
    await act(async () => { body.resolve(new Blob(['{}'])); });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0);
    if (mode === 'normal') {
      expect(document.querySelector('a[download]')).toBeNull();
      await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-export'), { timeout: 1600 });
      expect((screen.getByRole('button', { name: '导出我的数据' }) as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

it.each(['session', 'unmount', 'normal'])('刷新正文迟到：%s 仅有效页面续发队列统计', async mode => {
  const body = deferred<unknown>();
  let bodyStarted = false;
  let statsGets = 0;
  let queueGets = 0;
  owner.apiFetch.mockImplementation(async (input: string) => {
    if (input === '/api/stats' && ++statsGets === 2) {
      const response = json({});
      response.json = () => { bodyStarted = true; return body.promise; };
      return response;
    }
    if (input === '/api/admin/download-stats') queueGets += 1;
    return initial(input);
  });
  const ui = render(<StatsTab />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '刷新统计' }));
  await waitFor(() => expect(bodyStarted).toBe(true));
  if (mode === 'session') owner.current = 2;
  if (mode === 'unmount') ui.unmount();
  await act(async () => { body.resolve(stats('刷新后的合成分类')); });
  expect(queueGets).toBe(mode === 'normal' ? 2 : 1);
  if (mode === 'normal') expect(screen.getByText('刷新后的合成分类')).toBeTruthy();
  if (mode === 'session') expect(screen.queryByText('刷新后的合成分类')).toBeNull();
});

it('导出失败后可重试，不留下忙碌锁', async () => {
  let exports = 0;
  owner.apiFetch.mockImplementation(async (input: string) => {
    if (input === '/api/export') return ++exports === 1
      ? new Response('{"error":"合成导出失败"}', { status: 500 }) : new Response('{}');
    return initial(input);
  });
  render(<StatsTab />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
  await screen.findByText('合成导出失败');
  fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
  expect(exports).toBe(2);
  expect(screen.queryByText('合成导出失败')).toBeNull();
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1), { timeout: 1600 });
});

it('首次加载微任务前会话换代，不发旧统计请求', async () => {
  owner.apiFetch.mockImplementation(initial);
  render(<StatsTab />);
  owner.current = 2;
  await act(async () => {});
  expect(owner.apiFetch).not.toHaveBeenCalled();
});
