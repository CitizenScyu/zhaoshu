// @vitest-environment jsdom
// 下载进度轮询遇数据库配额（41-q402fix 审查必修 §5.1）：503 DB_QUOTA_EXCEEDED ⇒ 停 30 秒轮询，
// 按 Retry-After 只再探一次；再探成功恢复 30 秒节奏、仍配额继续等；后台不探、回前台立即探；卸载清定时器。
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LibraryTab, { createLibraryView, type LibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});
vi.mock('./ReadBookLink', () => ({ default: () => null }));

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const BOOK = {
  id: 7, title: '测试书', author: '作者', category: '玄幻', finishStatus: '',
  charsLabeled: 10_000, labels: {}, labeledAt: '2026-09-01T00:00:00.000Z', genre: '玄幻',
};
const RETRY_AFTER_S = 120;

let quota: boolean;
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
      if (quota) {
        return json({ error: '数据库额度已用尽，服务暂不可用，请稍后再试', code: 'DB_QUOTA_EXCEEDED' }, 503, { 'Retry-After': String(RETRY_AFTER_S) });
      }
      return json({ id: 100, bookId: 7, title: '测试书', status: 'running', chaptersTotal: 10, chaptersDone: 5, charsTotal: 0, error: null, updatedAt: '' });
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

/** 打开详情页；挂载时立即拉一次（此时 quota=true ⇒ 首拉即配额）。 */
async function openDetail(apiFetch: ReturnType<typeof makeApiFetch>) {
  mocks.owner = { ready: true, status: 'ready', user: { id: 5 }, apiFetch, can: () => true };
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: '查看测试书详情' }));
  await waitFor(() => expect(idCalls(apiFetch)).toBe(1));
  return view;
}

beforeEach(() => {
  quota = true;
  setHidden(false);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('LibraryTab 下载进度轮询：数据库配额暂停与自恢复', () => {
  it('配额 ⇒ 停 30 秒轮询并提示；到 Retry-After 再探成功 ⇒ 清提示、恢复 30 秒节奏', async () => {
    const apiFetch = makeApiFetch();
    await openDetail(apiFetch);
    await screen.findByText(/数据库额度已用尽/);

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000 - 1000);
    expect(idCalls(apiFetch)).toBe(1); // 暂停期间 30 秒轮询不再打

    quota = false;
    await vi.advanceTimersByTimeAsync(1000); // 到点再探一次
    expect(idCalls(apiFetch)).toBe(2);
    await waitFor(() => expect(screen.queryByText(/数据库额度已用尽/)).toBeNull());

    await vi.advanceTimersByTimeAsync(30_000); // 恢复正常节奏
    expect(idCalls(apiFetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(idCalls(apiFetch)).toBe(4);
  });

  it('再探仍是配额 ⇒ 继续等下一个 Retry-After，期间不按 30 秒打', async () => {
    const apiFetch = makeApiFetch();
    await openDetail(apiFetch);

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000); // 第一次再探：仍配额
    expect(idCalls(apiFetch)).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000 - 1000);
    expect(idCalls(apiFetch)).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // 第二次再探
    expect(idCalls(apiFetch)).toBe(3);
    await screen.findByText(/数据库额度已用尽/);
  });

  it('暂停中切后台不探；回前台立即探，成功即恢复', async () => {
    const apiFetch = makeApiFetch();
    await openDetail(apiFetch);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000 * 3);
    expect(idCalls(apiFetch)).toBe(1); // 后台期间零请求（含再探）

    quota = false;
    setHidden(false);
    await waitFor(() => expect(idCalls(apiFetch)).toBe(2)); // 回前台立即探
    await vi.advanceTimersByTimeAsync(30_000);
    expect(idCalls(apiFetch)).toBe(3); // 已恢复 30 秒节奏
  });

  it('暂停中回前台再探仍配额 ⇒ 不恢复 30 秒轮询，重新排再探', async () => {
    const apiFetch = makeApiFetch();
    await openDetail(apiFetch);
    setHidden(true);
    setHidden(false);
    await waitFor(() => expect(idCalls(apiFetch)).toBe(2));
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000 - 1000);
    expect(idCalls(apiFetch)).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(idCalls(apiFetch)).toBe(3);
  });

  it('卸载清理再探定时器：之后不再有任何请求', async () => {
    const apiFetch = makeApiFetch();
    const view = await openDetail(apiFetch);
    view.unmount();
    quota = false;
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_S * 1000 * 3);
    expect(idCalls(apiFetch)).toBe(1);
  });
});
