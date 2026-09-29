// @vitest-environment jsdom
// 书架手动操作(移除/清理)的全链路生命周期(shelf-operation-lifecycle53)：
// 反馈保存→删除→重载 与 清理→重载 全程持有同一取消器，离页即作废。
// 身份切换场景用组件级类比建模:apiFetch 记录每次调用执行时的合成用户,
// 卸载后切到用户B,迟到的链路兑现不得再以B身份发DELETE/GET。
// 全合成网络与账号,不访问真实上游。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({ apiFetch: mocks.apiFetch }) }));
vi.mock('@/components/ReadBookLink', () => ({ default: () => null }));
vi.mock('@/components/FeedbackForm', () => ({ default: () => null }));
import ShelfTab from './ShelfTab';

const item = {
  id: 11, book_id: 22, title: '合成测试书', author: '合成作者', query: '合成查询',
  status: 'want', note: '', feedback_id: 3, created_at: '2026-09-28T00:00:00Z',
  match_score: null, hit_likes: [], risks: null, reason: null, meta: {},
};
const newItem = { ...item, id: 12, status: 'new' as const, feedback_id: 0, note: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface Recorded { url: string; method: string; signal?: AbortSignal; body?: unknown }

/** 合成 apiFetch:记录每次调用(含 signal 与请求体),按需挂起/兑现各端点。 */
function makeApi() {
  const calls: Recorded[] = [];
  const deletes: { user: number; book: number }[] = [];
  let currentUser = 2;
  const state = {
    calls, deletes, currentUser,
    feedbackBody: deferred<unknown>(),
    deleteBody: deferred<unknown>(),
    clearBody: deferred<unknown>(),
  };
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url, method: init?.method ?? 'GET', signal: init?.signal,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === '/api/recommendations') {
      return Response.json({ recommendations: [item, newItem] });
    }
    if (url === '/api/feedback' && init?.method === 'POST') {
      // 响应头已到、JSON 迟到:正是 53 独立脚本建模的兑现窗口。
      return { ok: true, json: () => state.feedbackBody.promise } as unknown as Response;
    }
    if (url === '/api/shelf?bookId=22' && init?.method === 'DELETE') {
      deletes.push({ user: currentUser, book: 22 });
      return { ok: true, json: () => state.deleteBody.promise } as unknown as Response;
    }
    if (url === '/api/shelf/unprocessed' && init?.method === 'DELETE') {
      deletes.push({ user: currentUser, book: 0 });
      return { ok: true, json: () => state.clearBody.promise } as unknown as Response;
    }
    throw new Error(`unexpected ${url} ${init?.method ?? 'GET'}`);
  });
  return state;
}

const drain = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { cleanup(); });

async function armRemoval() {
  render(<ShelfTab />);
  fireEvent.click(await screen.findByRole('button', { name: '将合成测试书移出书架' }));
}

describe('移除链路:反馈保存→删除→重载', () => {
  it('反馈JSON等待期离页并切换用户:迟到兑现不再以新用户发DELETE、不拉新列表,POST signal已中止', async () => {
    const api = makeApi();
    await armRemoval();
    fireEvent.change(screen.getByRole('textbox', { name: '移出前记一句（选填，帮「找书」更准）' }),
      { target: { value: '合成原因' } });
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认将合成测试书移出书架' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1));

    // 离页(生产中身份切换会整页重挂,卸载即此处建模),随后才切到用户B。
    cleanup();
    api.currentUser = 3;
    await act(async () => { api.feedbackBody.resolve({ ok: true }); await new Promise((r) => setTimeout(r, 0)); });

    expect(api.deletes).toEqual([]); // 不得出现 {user:3,book:22}
    const gets = api.calls.filter((c) => c.method === 'GET').length;
    expect(gets).toBe(1); // 只有首屏那一次,卸载后没有新列表请求
    expect(api.calls.find((c) => c.method === 'POST')?.signal?.aborted).toBe(true);
  });

  it('DELETE等待期离页:迟到成功不重载列表,DELETE signal已中止', async () => {
    const api = makeApi();
    await armRemoval();
    fireEvent.change(screen.getByRole('textbox', { name: '移出前记一句（选填，帮「找书」更准）' }),
      { target: { value: '合成原因' } });
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认将合成测试书移出书架' }));
    await act(async () => { api.feedbackBody.resolve({ ok: true }); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(api.deletes).toHaveLength(1));

    cleanup();
    await act(async () => { api.deleteBody.resolve({ ok: true }); await new Promise((r) => setTimeout(r, 0)); });

    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(api.calls.filter((c) => c.method === 'DELETE')[0].signal?.aborted).toBe(true);
  });

  it('不离页的正常移除仍走完整链:原因落库→DELETE→重载(行为保留)', async () => {
    const api = makeApi();
    await armRemoval();
    fireEvent.change(screen.getByRole('textbox', { name: '移出前记一句（选填，帮「找书」更准）' }),
      { target: { value: '合成原因' } });
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认将合成测试书移出书架' }));
    await act(async () => { api.feedbackBody.resolve({ ok: true }); await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { api.deleteBody.resolve({ ok: true }); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(2));

    // 重载后列表只剩未处理那条;未中止的 signal 全程可用。
    expect(api.deletes).toEqual([{ user: 2, book: 22 }]);
    expect(api.calls.filter((c) => c.method === 'DELETE')[0].signal?.aborted).toBe(false);
  });
});

describe('清理未处理:DELETE→重载', () => {
  it('DELETE等待期离页:迟到成功不发新列表请求', async () => {
    const api = makeApi();
    render(<ShelfTab />);
    fireEvent.click(await screen.findByRole('button', { name: '清空全部未处理推荐' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认清空全部未处理推荐' }));
    await waitFor(() => expect(api.deletes).toHaveLength(1));

    cleanup();
    await act(async () => { api.clearBody.resolve({ cleared: 2 }); await new Promise((r) => setTimeout(r, 0)); });

    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(1); // 卸载后无新 GET
    expect(api.calls.filter((c) => c.method === 'DELETE')[0].signal?.aborted).toBe(true);
  });

  it('不离页的清理仍提示条数并重载(行为保留)', async () => {
    const api = makeApi();
    render(<ShelfTab />);
    fireEvent.click(await screen.findByRole('button', { name: '清空全部未处理推荐' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认清空全部未处理推荐' }));
    await act(async () => { api.clearBody.resolve({ cleared: 1 }); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    expect(api.deletes).toEqual([{ user: 2, book: 0 }]);
  });
});
