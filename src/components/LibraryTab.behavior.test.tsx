// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryTab, { createLibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({ apiFetch: mocks.apiFetch }) }));
vi.mock('@/components/ReadBookLink', () => ({ default: () => null }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function libraryPage(title = '上次找到的书', total = 1) {
  return {
    books: total === 0 ? [] : [{
      id: 1, title, author: '测试作者', category: '科幻', finishStatus: '完结',
      charsLabeled: 1000, labels: {}, labeledAt: '2026-09-28', genre: '', intro: '',
    }],
    total, maxPage: 10_000, facets: { categories: [], finishStates: [] },
  };
}

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function Harness({ initialQuery = '' }: { initialQuery?: string }) {
  const [view, setView] = useState(() => createLibraryView(initialQuery));
  return <LibraryTab view={view} setView={setView} />;
}

beforeEach(() => mocks.apiFetch.mockReset());
afterEach(cleanup);

describe('书库加载失败恢复', () => {
  it('首次加载失败后可原条件重试，加载期间不会重复提交', async () => {
    const retry = pendingResponse();
    mocks.apiFetch.mockResolvedValueOnce(json({ error: '暂时无法读取书库' }, 503))
      .mockReturnValueOnce(retry.promise);
    render(<Harness initialQuery="星际" />);
    const user = userEvent.setup();

    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取书库');
    expect(screen.queryByText(/没有符合条件的书|书库还是空的/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '重试加载' }));
    await screen.findByText('读取中…');
    await user.click(screen.getByRole('button', { name: '搜' }));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetch.mock.calls[1][0]).toBe(mocks.apiFetch.mock.calls[0][0]);
    expect((screen.getByRole('textbox', { name: '书库搜索' }) as HTMLInputElement).value).toBe('星际');

    await act(async () => retry.resolve(json(libraryPage('星际测试书'))));
    expect(await screen.findByRole('button', { name: '查看星际测试书详情' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('相同搜索条件失败后再次点搜会重发请求，不必改字或切换标签', async () => {
    mocks.apiFetch.mockResolvedValueOnce(json({ error: '网络中断' }, 502))
      .mockResolvedValueOnce(json(libraryPage('搜索恢复')));
    render(<Harness initialQuery="星际" />);
    const user = userEvent.setup();
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '搜' }));
    expect(await screen.findByRole('button', { name: '查看搜索恢复详情' })).toBeTruthy();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetch.mock.calls[1][0]).toBe(mocks.apiFetch.mock.calls[0][0]);
  });

  it('换页加载和失败保留旧书，但说明结果未更新且不展示错误的新页码', async () => {
    const nextPage = pendingResponse();
    mocks.apiFetch.mockResolvedValueOnce(json(libraryPage('上次找到的书', 61)))
      .mockReturnValueOnce(nextPage.promise);
    render(<Harness />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '查看上次找到的书详情' });
    await user.click(screen.getByRole('button', { name: '下一页' }));

    expect(await screen.findByText('正在更新书库，以下为上次结果…')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看上次找到的书详情' })).toBeTruthy();
    expect(screen.queryByText('共 61 本')).toBeNull();
    expect(screen.queryByText('2 / 3')).toBeNull();
    await act(async () => nextPage.resolve(json({ error: '翻页失败' }, 500)));
    expect((await screen.findByRole('alert')).textContent).toContain('翻页失败');
    expect(screen.getByText('以下为上次加载的结果，尚未按当前条件更新。')).toBeTruthy();
    expect(screen.queryByText('2 / 3')).toBeNull();
    expect(screen.getByRole('button', { name: '重试加载' })).toBeTruthy();
  });

  it('已有空结果后换条件失败，不把上次的空结果解释为当前条件无书', async () => {
    mocks.apiFetch.mockResolvedValueOnce(json(libraryPage('', 0)))
      .mockResolvedValueOnce(json({ error: '查询失败' }, 500));
    render(<Harness initialQuery="旧条件" />);
    const user = userEvent.setup();
    await screen.findByText('没有符合条件的书。');
    const input = screen.getByRole('textbox', { name: '书库搜索' });
    await user.clear(input);
    await user.type(input, '新条件');
    await user.click(screen.getByRole('button', { name: '搜' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/没有符合条件的书|书库还是空的/)).toBeNull();
  });

  it('快速改排序中止旧请求，迟到旧响应不能覆盖新结果或结束其加载', async () => {
    const older = pendingResponse();
    const latest = pendingResponse();
    mocks.apiFetch.mockResolvedValueOnce(json(libraryPage()))
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    const { unmount } = render(<Harness />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '查看上次找到的书详情' });
    await user.selectOptions(screen.getByRole('combobox', { name: '排序方式' }), 'recent');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    const oldSignal = mocks.apiFetch.mock.calls[1][1].signal as AbortSignal;
    await user.selectOptions(screen.getByRole('combobox', { name: '排序方式' }), 'title');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(3));
    expect(oldSignal.aborted).toBe(true);

    await act(async () => older.resolve(json(libraryPage('不该显示的旧响应'))));
    expect(screen.queryByRole('button', { name: '查看不该显示的旧响应详情' })).toBeNull();
    expect(screen.getByText('正在更新书库，以下为上次结果…')).toBeTruthy();
    await act(async () => latest.resolve(json(libraryPage('最新排序结果'))));
    expect(await screen.findByRole('button', { name: '查看最新排序结果详情' })).toBeTruthy();
    expect(screen.queryByText('正在更新书库，以下为上次结果…')).toBeNull();
    unmount();
    expect((mocks.apiFetch.mock.calls[2][1].signal as AbortSignal).aborted).toBe(true);
  });

  it('重试中离开书库会中止请求，迟到响应不再落入已卸载视图', async () => {
    const retry = pendingResponse();
    mocks.apiFetch.mockResolvedValueOnce(json({ error: '查询失败' }, 500))
      .mockReturnValueOnce(retry.promise);
    const { unmount } = render(<Harness />);
    const user = userEvent.setup();
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '重试加载' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    const signal = mocks.apiFetch.mock.calls[1][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => retry.resolve(json(libraryPage('离开后的响应'))));
    expect(screen.queryByRole('button', { name: '查看离开后的响应详情' })).toBeNull();
  });
});
