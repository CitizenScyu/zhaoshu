// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryTab, { createLibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), download: true, read: true }));
vi.mock('@/components/OwnerProvider', () => ({
  useOwner: () => ({
    apiFetch: mocks.apiFetch, ready: true,
    can: (permission: string) => permission === 'download' ? mocks.download : permission === 'read' ? mocks.read : true,
  }),
}));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const book = {
  id: 7, title: '权限测试书', author: '测试作者', category: '科幻', finishStatus: '完结',
  charsLabeled: 1000, labels: {}, labeledAt: '2026-09-28', genre: '', intro: '',
};
const permissionNote = '当前账号尚未获得下载权限，请联系管理员开通后再试。';
const task = (status = 'running') => ({
  id: 100, bookId: 7, title: book.title, status, chaptersTotal: 10, chaptersDone: 1,
  charsTotal: 1000, error: null, updatedAt: '',
});

function libraryResponse() {
  return json({
    books: [{ ...book, sharedReadTaskId: mocks.read ? 90 : null }], total: 1,
    facets: { categories: [], finishStates: [] },
  });
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function Harness() {
  const [view, setView] = useState(() => createLibraryView());
  return <LibraryTab view={view} setView={setView} />;
}

const downloadCalls = () => mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/download'));
const progressCalls = () => mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/download?id='));

async function openDetail() {
  fireEvent.click(await screen.findByRole('button', { name: `查看${book.title}详情` }));
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.download = true;
  mocks.read = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('书库详情的下载权限', () => {
  it.each([false, true])('无下载权限时说明原因且不查询私有任务，保留阅读入口（read=%s）', async (canRead) => {
    mocks.download = false;
    mocks.read = canRead;
    mocks.apiFetch.mockImplementation(async () => libraryResponse());
    render(<Harness />);
    await openDetail();
    expect(await screen.findByText(permissionNote)).toBeTruthy();
    expect(downloadCalls()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /下载全书/ })).toBeNull();
    const link = screen.getByRole('link', { name: canRead ? `阅读《${book.title}》` : `阅读《${book.title}》（当前账号尚无阅读权限）` });
    expect(link.getAttribute('href')).toContain(canRead ? '/read/90?' : '/read/source?');
    expect(link.getAttribute('href')).toContain('from=library');
  });

  it('有权限时仍查询本人任务并可提交下载', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/library')) return libraryResponse();
      if (init?.method === 'POST') return json({ taskId: 100 });
      if (url.includes('?bookId=')) return json({ task: null });
      return json(task());
    });
    render(<Harness />);
    await openDetail();
    await waitFor(() => expect(downloadCalls()).toHaveLength(1));
    expect(downloadCalls()[0][0]).toBe('/api/download?bookId=7');
    fireEvent.click(screen.getByRole('button', { name: /下载全书/ }));
    await waitFor(() => expect(downloadCalls().some(([, init]) => init?.method === 'POST')).toBe(true));
    const post = downloadCalls().find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1].body)).toEqual({ bookId: 7 });
    expect(await screen.findByText('下载中 1/10 章')).toBeTruthy();
    expect(screen.queryByText(permissionNote)).toBeNull();
  });

  it('撤销权限中止尚未完成的详情任务查询，恢复后重新查询而非复用迟到任务', async () => {
    const pending = deferred();
    let lookups = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/library')) return libraryResponse();
      lookups++;
      return lookups === 1 ? pending.promise : json({ task: null });
    });
    const view = render(<Harness />);
    await openDetail();
    await waitFor(() => expect(downloadCalls()).toHaveLength(1));
    const signal = downloadCalls()[0][1].signal as AbortSignal;
    mocks.download = false;
    view.rerender(<Harness />);
    expect(await screen.findByText(permissionNote)).toBeTruthy();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(json(task('done'))));
    expect(screen.queryByRole('button', { name: '取回文件' })).toBeNull();
    expect(downloadCalls()).toHaveLength(1);

    mocks.download = true;
    view.rerender(<Harness />);
    await waitFor(() => expect(downloadCalls()).toHaveLength(2));
    expect(screen.getByRole('button', { name: /下载全书/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取回文件' })).toBeNull();
  });

  it('撤销权限取消进度请求和定时轮询，恢复后不展示此前运行中的任务', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pendingPoll = deferred();
    let lookupCount = 0;
    let pollCount = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/library')) return libraryResponse();
      if (url.includes('?bookId=')) return json(++lookupCount === 1 ? task() : { task: null });
      return ++pollCount === 1 ? json(task()) : pendingPoll.promise;
    });
    const view = render(<Harness />);
    await openDetail();
    await screen.findByText('下载中 1/10 章');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(progressCalls()).toHaveLength(2);
    const signal = progressCalls()[1][1].signal as AbortSignal;
    mocks.download = false;
    view.rerender(<Harness />);
    await screen.findByText(permissionNote);
    expect(signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(progressCalls()).toHaveLength(2);
    await act(async () => pendingPoll.resolve(json(task('done'))));
    expect(screen.queryByRole('button', { name: '取回文件' })).toBeNull();

    mocks.download = true;
    view.rerender(<Harness />);
    await waitFor(() => expect(lookupCount).toBe(2));
    expect(screen.getByRole('button', { name: /下载全书/ })).toBeTruthy();
    expect(screen.queryByText('下载中 1/10 章')).toBeNull();
    expect(progressCalls()).toHaveLength(2);
  });

  it('撤销再恢复权限后，旧提交的迟到响应不会恢复任务或启动轮询', async () => {
    const submission = deferred();
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/library')) return libraryResponse();
      if (init?.method === 'POST') return submission.promise;
      return json({ task: null });
    });
    const view = render(<Harness />);
    await openDetail();
    await waitFor(() => expect(downloadCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /下载全书/ }));
    await waitFor(() => expect(downloadCalls()).toHaveLength(2));
    mocks.download = false;
    view.rerender(<Harness />);
    await screen.findByText(permissionNote);
    mocks.download = true;
    view.rerender(<Harness />);
    await waitFor(() => expect(downloadCalls()).toHaveLength(3));
    await act(async () => submission.resolve(json({ taskId: 100 })));
    expect(progressCalls()).toHaveLength(0);
    expect(screen.queryByText('已加入下载队列。')).toBeNull();
    expect((screen.getByRole('button', { name: /下载全书/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
