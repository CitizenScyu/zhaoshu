// @vitest-environment jsdom
// 退避中 UI 状态契约（dlsearch-1026 任务 B）：pending + attemptCount>0 + 未来 nextAttemptAt
// 显示「暂无可用源，将于 HH:mm 自动重试（第 n/16 次）」而非误导性的「排队中」；第 16 次上限
// 取 worker 的 SOURCE_RETRY_MAX_ATTEMPTS（download-task-policy.ts），不在 UI 侧另设魔数。
// mock 模式照 LibraryTab.leasexp.test.tsx。仅验证 downloadStatusText 语义相关渲染。
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LibraryTab, { createLibraryView, type LibraryView } from './LibraryTab';
import { SOURCE_RETRY_MAX_ATTEMPTS } from '@/lib/download-task-policy';

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

// 与 leasexp 测试同构：详情页按 bookId 查任务；pending 任务不挂轮询（仅 running 挂），
// 但挂载即拉的首次 ?id= 查询由 bookId 结果带出，两处返回同一份任务 JSON。
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

describe('LibraryTab 退避中的 pending 文案（dlsearch-1026）', () => {
  it('pending + attemptCount>0 + 未来 nextAttemptAt 显示自动重试而非「排队中」', async () => {
    const nextAt = new Date(Date.now() + 15 * 60_000);
    const hhmm = nextAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const apiFetch = makeApiFetch({
      id: 91, bookId: 7, title: '测试书', status: 'pending',
      attemptCount: 3, nextAttemptAt: nextAt.toISOString(),
      chaptersDone: 0, chaptersTotal: 0, charsTotal: 0,
      error: null, updatedAt: '',
    });
    await openDetail(apiFetch);

    await screen.findByText(`暂无可用源，将于 ${hhmm} 自动重试（第 3/${SOURCE_RETRY_MAX_ATTEMPTS} 次）`);
    expect(screen.queryByText(/排队中/)).toBeNull();
  });

  it('首次入队的 pending（attemptCount 缺省 0）仍显示「排队中」', async () => {
    const apiFetch = makeApiFetch({
      id: 91, bookId: 7, title: '测试书', status: 'pending',
      chaptersDone: 0, chaptersTotal: 0, charsTotal: 0,
      error: null, updatedAt: '',
    });
    await openDetail(apiFetch);

    await screen.findByText('排队中，等待下载任务开始');
    expect(screen.queryByText(/暂无可用源/)).toBeNull();
  });

  it('nextAttemptAt 已过期不误报「退避中」（回到排队中文案）', async () => {
    const apiFetch = makeApiFetch({
      id: 91, bookId: 7, title: '测试书', status: 'pending',
      attemptCount: 3, nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
      chaptersDone: 0, chaptersTotal: 0, charsTotal: 0,
      error: null, updatedAt: '',
    });
    await openDetail(apiFetch);

    await screen.findByText('排队中，等待下载任务开始');
    expect(screen.queryByText(/暂无可用源/)).toBeNull();
  });
});
