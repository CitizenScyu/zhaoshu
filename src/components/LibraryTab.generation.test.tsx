// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const state = { apiFetch: vi.fn(), generation: 1, isCurrentSession: (id: number): boolean => id === state.generation };
  return state;
});
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({ apiFetch: mocks.apiFetch, can: () => true,
  sessionId: mocks.generation, isCurrentSession: mocks.isCurrentSession }) }));
vi.mock('./ReadBookLink', () => ({ default: () => null }));
import LibraryTab, { createLibraryView } from './LibraryTab';

const book = { id: 11, title: '合成书', author: '合成作者', category: '', finishStatus: '',
  charsLabeled: 1000, labels: {}, labeledAt: '2026-09-29', genre: '', intro: '' };
const task = (status = 'done') => ({ id: 101, bookId: 11, title: book.title, status,
  chaptersTotal: 1, chaptersDone: 1, charsTotal: 100, updatedAt: '', requestedBy: 'user' });
function Harness() {
  const [view, setView] = useState(createLibraryView);
  return <LibraryTab view={view} setView={setView} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const writeCalls = () => mocks.apiFetch.mock.calls.filter((call) => ['POST', 'DELETE'].includes(call[1]?.method));
const progressCalls = () => mocks.apiFetch.mock.calls.filter((call) => call[0] === '/api/download?id=101');
beforeEach(() => {
  vi.resetAllMocks(); mocks.generation = 1;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(status: string | null) {
  const body = deferred<{ taskId: number }>();
  const blob = deferred<Blob>();
  const readBody = vi.fn(() => body.promise);
  const readBlob = vi.fn(() => blob.promise);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const createObjectURL = vi.fn(() => 'blob:synthetic');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/library')) return Response.json({ books: [book], total: 1, facets: { categories: [], finishStates: [] } });
    if (url === '/api/download?bookId=11') return Response.json({ task: status ? task(status) : null });
    if (url === '/api/download?id=101') return Response.json({ task: task(status ?? 'done') });
    if (url === '/api/download' && init?.method === 'POST') return { ok: false, status: 409, json: readBody };
    if (url === '/api/download/101/file') return { ok: true, headers: new Headers(), blob: readBlob };
    if (url === '/api/shelf' || (url === '/api/download' && init?.method === 'DELETE')) return Response.json({ ok: true });
    throw new Error('未知合成请求');
  });
  const view = render(<Harness />);
  await screen.findByRole('button', { name: '查看合成书详情' });
  const open = () => fireEvent.click(screen.getByRole('button', { name: '查看合成书详情' }));
  return { view, open, body, blob, readBody, readBlob, click, createObjectURL, revokeObjectURL };
}

describe('书库动作的页面生命周期与真实会话代际', () => {
  it('旧页面加入书架按钮不能向新代际写入', async () => {
    await setup(null); mocks.generation += 1;
    fireEvent.click(screen.getByRole('button', { name: '将合成书加入书架' }));
    await act(async () => {});
    expect(writeCalls()).toHaveLength(0);
  });

  it.each(['session', 'unmount', 'normal'])('文件blob迟到时%s，只有有效动作触发浏览器下载', async (scenario) => {
    const current = await setup('done'); current.open();
    fireEvent.click(await screen.findByRole('button', { name: '取回文件' }));
    await waitFor(() => expect(current.readBlob).toHaveBeenCalledOnce());
    if (scenario === 'session') mocks.generation += 1;
    if (scenario === 'unmount') {
      current.view.unmount();
      expect(mocks.apiFetch.mock.calls.find((call) => call[0].endsWith('/file'))?.[1]?.signal?.aborted).toBe(true);
    }
    await act(async () => { current.blob.resolve(new Blob(['synthetic'])); });
    expect(current.click).toHaveBeenCalledTimes(scenario === 'normal' ? 1 : 0);
    expect(current.createObjectURL).toHaveBeenCalledTimes(scenario === 'normal' ? 1 : 0);
    expect(current.revokeObjectURL).toHaveBeenCalledTimes(scenario === 'normal' ? 1 : 0);
  });

  it.each(['session', 'unmount', 'normal'])('409迟到时%s，只有有效动作继续查询已有任务', async (scenario) => {
    const current = await setup(null); current.open();
    fireEvent.click(await screen.findByRole('button', { name: '⬇ 下载全书' }));
    await waitFor(() => expect(current.readBody).toHaveBeenCalledOnce());
    if (scenario === 'session') mocks.generation += 1;
    if (scenario === 'unmount') {
      current.view.unmount();
      expect(writeCalls()[0][1]?.signal?.aborted).toBe(true);
    }
    await act(async () => { current.body.resolve({ taskId: 101 }); });
    expect(progressCalls()).toHaveLength(scenario === 'normal' ? 1 : 0);
    if (scenario === 'normal') expect(screen.getByRole('button', { name: '取回文件' })).toBeTruthy();
  });

  it.each(['start', 'cancel'])('新代际下旧%s按钮不发写入', async (operation) => {
    const current = await setup(operation === 'start' ? null : 'pending'); current.open();
    const button = await screen.findByRole('button', { name: operation === 'start' ? '⬇ 下载全书' : '取消' });
    mocks.generation += 1; fireEvent.click(button);
    await act(async () => {});
    expect(writeCalls()).toHaveLength(0);
  });

  it('会话失效后旧页面回前台事件不再发轮询请求', async () => {
    const current = await setup('pending'); current.open();
    await waitFor(() => expect(progressCalls()).toHaveLength(1));
    mocks.generation += 1;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(progressCalls()).toHaveLength(1);
  });
});
