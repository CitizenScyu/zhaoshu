// @vitest-environment jsdom
// 下载已中断 UI 状态契约（fix692）：running+leaseExpired 显示「下载已中断（worker 无心跳）」
// 而非「下载中 n/m」，且该态下渲染「重试」按钮（LibraryTab.tsx L126-128/L826-833）。
// 该契约此前只有 API 层 F16 钉住 GET 派生 leaseExpired，UI 层零覆盖。mock 模式照 relocate 测试。
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LibraryTab, { createLibraryView, type LibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});
// 在线阅读入口与本契约无关，桩掉以隔离下载分支（它只读 owner，不打网络）。
vi.mock('./ReadBookLink', () => ({ default: () => null }));

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BOOK = {
  id: 7, title: '测试书', author: '作者', category: '玄幻', finishStatus: '',
  charsLabeled: 10_000, labels: {}, labeledAt: '2026-09-01T00:00:00.000Z', genre: '玄幻',
};

// 详情页进书时按 bookId 查「本人」任务（L324 `/api/download?bookId=`），running 任务挂上轮询
// effect 后挂载立即再拉一次（L376 `/api/download?id=`）。两处返回同一份任务 JSON，避免抖态。
function makeApiFetch(taskBody: Record<string, unknown>) {
  return vi.fn<ApiFetch>(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/library')) {
      return json({ books: [BOOK], total: 1, maxPage: 1, facets: { categories: [], finishStates: [] } });
    }
    if (url.includes('/api/download?bookId=') || url.includes('/api/download?id=')) {
      return json(taskBody);
    }
    return json({}, 404);
  });
}

function Harness() {
  const [view, setView] = useState<LibraryView>(() => createLibraryView());
  return <LibraryTab view={view} setView={setView} />;
}

async function openDetail(apiFetch: ReturnType<typeof makeApiFetch>) {
  mocks.owner = {
    ready: true, status: 'ready', user: { id: 5 },
    sessionId: 1, isCurrentSession: (id: number) => id === 1,
    apiFetch, can: () => true,
  };
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: '查看测试书详情' }));
}

afterEach(() => {
  cleanup();
});

describe('LibraryTab 下载已中断（running+leaseExpired）', () => {
  it('心跳过期的 running 显示「下载已中断」并渲染「重试」按钮', async () => {
    const apiFetch = makeApiFetch({
      id: 91, bookId: 7, title: '测试书', status: 'running',
      leaseExpired: true, chaptersDone: 7, chaptersTotal: 10, charsTotal: 0,
      error: null, updatedAt: '',
    });
    await openDetail(apiFetch);

    await screen.findByText('下载已中断（worker 无心跳），已存 7/10 章，可重试');
    expect(screen.queryByText('下载中 7/10 章')).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();

    // running 任务挂上轮询：挂载即拉一次，确认读的确实是同一份任务态。
    await waitFor(() => {
      const polls = apiFetch.mock.calls.filter((call) => String(call[0]).includes('/api/download?id=91'));
      expect(polls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('活跃心跳的 running 显示「下载中」且不渲染「重试」按钮', async () => {
    const apiFetch = makeApiFetch({
      id: 91, bookId: 7, title: '测试书', status: 'running',
      leaseExpired: false, chaptersDone: 7, chaptersTotal: 10, charsTotal: 0,
      error: null, updatedAt: '',
    });
    await openDetail(apiFetch);

    await screen.findByText('下载中 7/10 章');
    expect(screen.queryByText(/下载已中断/)).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });
});
