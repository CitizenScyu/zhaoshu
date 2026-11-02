// @vitest-environment jsdom
// failcode1102：failed 任务的「失败详情」把 worker 写入的已知错误码转成中文并括注原码，
// 未知行原样保留。生产实测：成功下完 42 章后发布撞 ARTIFACT_IDENTITY_CONFLICT，详情区只显示英文码。
// mock 模式照 leasexp 测试。
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LibraryTab, { createLibraryView, type LibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});
vi.mock('./ReadBookLink', () => ({ default: () => null }));

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BOOK = {
  id: 7, title: '测试书', author: '作者', category: '玄幻', finishStatus: '',
  charsLabeled: 10_000, labels: {}, labeledAt: '2026-09-01T00:00:00.000Z', genre: '玄幻',
};

function Harness() {
  const [view, setView] = useState<LibraryView>(() => createLibraryView());
  return <LibraryTab view={view} setView={setView} />;
}

async function openFailed(error: string) {
  const apiFetch = vi.fn<ApiFetch>(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/library')) {
      return json({ books: [BOOK], total: 1, maxPage: 1, facets: { categories: [], finishStates: [] } });
    }
    if (url.includes('/api/download?bookId=')) {
      return json({
        id: 91, bookId: 7, title: '测试书', status: 'failed',
        chaptersDone: 42, chaptersTotal: 42, charsTotal: 0, error, updatedAt: '',
      });
    }
    return json({}, 404);
  });
  mocks.owner = {
    ready: true, status: 'ready', user: { id: 5 },
    sessionId: 1, isCurrentSession: (id: number) => id === 1,
    apiFetch, can: () => true,
  };
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: '查看测试书详情' }));
  await screen.findByText('失败详情');
  return screen.getByRole('list', { name: '下载任务说明' });
}

afterEach(() => {
  cleanup();
});

describe('LibraryTab 失败详情错误码中文化', () => {
  it('已知码（含 CODE: detail 形态）转中文并括注原码', async () => {
    const list = await openFailed('ARTIFACT_IDENTITY_CONFLICT\nLABELED_BOOK_MISSING: labeled_books id=7 不存在');
    const items = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      '这本书已有存档登记在别的存储位置，下载结果无法发布，重下也一样，需管理员处理（ARTIFACT_IDENTITY_CONFLICT）',
      '书库记录已不存在，请返回刷新书库（LABELED_BOOK_MISSING）',
    ]);
  });

  it('未知码与中文行原样保留', async () => {
    const list = await openFailed('SOMETHING_NEW\n第 3 章抽验失败');
    const items = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['SOMETHING_NEW', '第 3 章抽验失败']);
  });
});
