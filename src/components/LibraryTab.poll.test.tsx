// @vitest-environment jsdom
// 下载进度轮询（41-pollddl）：30 秒间隔 + 页面不可见暂停 + 回前台立即拉一次 + 终态停轮询。
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LibraryTab, { createLibraryView, type LibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});
// 阅读入口与轮询无关，桩掉以隔离下载分支（它只读 owner，不打网络）。
vi.mock('./ReadBookLink', () => ({ default: () => null }));

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BOOK = {
  id: 7, title: '测试书', author: '作者', category: '玄幻', finishStatus: '',
  charsLabeled: 10_000, labels: {}, labeledAt: '2026-09-01T00:00:00.000Z', genre: '玄幻',
};

let pollStatus: string;
function makeApiFetch() {
  return vi.fn<ApiFetch>(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/library')) {
      return json({ books: [BOOK], total: 1, maxPage: 1, facets: { categories: [], finishStates: [] } });
    }
    if (url.includes('/api/download?bookId=')) {
      return json({ id: 100, bookId: 7, title: '测试书', status: 'running', chaptersTotal: 10, chaptersDone: 1, charsTotal: 0, error: null, updatedAt: '' });
    }
    if (url.includes('/api/download?id=')) {
      return json({ id: 100, bookId: 7, title: '测试书', status: pollStatus, chaptersTotal: 10, chaptersDone: 5, charsTotal: 0, error: null, updatedAt: '' });
    }
    return json({}, 404);
  });
}

function Harness() {
  const [view, setView] = useState<LibraryView>(() => createLibraryView());
  return <LibraryTab view={view} setView={setView} />;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

const idCalls = (apiFetch: ReturnType<typeof makeApiFetch>) =>
  apiFetch.mock.calls.filter((call) => String(call[0]).includes('/api/download?id=')).length;

async function openDetailInProgress(apiFetch: ReturnType<typeof makeApiFetch>) {
  mocks.owner = {
    ready: true, status: 'ready', user: { id: 5 },
    apiFetch, can: () => true,
  };
  render(<Harness />);
  const card = await screen.findByRole('button', { name: '查看测试书详情' });
  fireEvent.click(card);
  // 详情页按 bookId 拉到 running 任务后，轮询 effect 挂载并立即拉一次。
  await waitFor(() => expect(idCalls(apiFetch)).toBe(1));
}

beforeEach(() => {
  pollStatus = 'running';
  setHidden(false);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('LibraryTab 下载进度轮询', () => {
  it('间隔为 30 秒：10 秒不触发、30 秒触发一次', async () => {
    const apiFetch = makeApiFetch();
    await openDetailInProgress(apiFetch);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(idCalls(apiFetch)).toBe(1); // 10s 内没有新的轮询（证明不是 10s）

    await vi.advanceTimersByTimeAsync(20_000); // 累计 30s
    expect(idCalls(apiFetch)).toBe(2);
  });

  it('页面不可见时暂停轮询，回到前台立即拉一次并恢复计时', async () => {
    const apiFetch = makeApiFetch();
    await openDetailInProgress(apiFetch);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(90_000); // 后台期间不轮询
    expect(idCalls(apiFetch)).toBe(1);

    setHidden(false); // 回前台立即拉一次
    await waitFor(() => expect(idCalls(apiFetch)).toBe(2));

    await vi.advanceTimersByTimeAsync(30_000); // 计时恢复
    expect(idCalls(apiFetch)).toBe(3);
  });

  it('任务到终态后停止轮询', async () => {
    const apiFetch = makeApiFetch();
    await openDetailInProgress(apiFetch);

    pollStatus = 'done';
    await vi.advanceTimersByTimeAsync(30_000); // 这一拍拉到 done
    await screen.findByText(/完成/); // 确认已进入终态
    const atTerminal = idCalls(apiFetch);

    await vi.advanceTimersByTimeAsync(120_000); // 终态后不再轮询
    expect(idCalls(apiFetch)).toBe(atTerminal);
  });
});
