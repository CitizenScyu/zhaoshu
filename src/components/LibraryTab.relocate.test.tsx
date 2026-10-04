// @vitest-environment jsdom
// 下载换源重定位（front682，design679 §4.2）：UNSUPPORTED_SOURCE 反应式入口、relocate 九类结果分派、
// AMBIGUOUS 只读候选、409 跳已有任务、dlBusy 门控与切详情重置。mock 模式照 poll/quota 测试。
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LibraryTab, { createLibraryView, type LibraryView } from './LibraryTab';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});
// 阅读入口与重定位无关，桩掉以隔离下载分支（它只读 owner，不打网络）。
vi.mock('./ReadBookLink', () => ({ default: () => null }));

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BOOK = {
  id: 7, title: '测试书', author: '作者', category: '玄幻', finishStatus: '',
  charsLabeled: 10_000, labels: {}, labeledAt: '2026-09-01T00:00:00.000Z', genre: '玄幻',
};

function makeApiFetch(options: {
  postDownload?: () => Response | Promise<Response>;
  relocate?: () => Response | Promise<Response>;
  taskById?: () => Response;
}) {
  return vi.fn<ApiFetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/library')) {
      return json({ books: [BOOK], total: 1, maxPage: 1, facets: { categories: [], finishStates: [] } });
    }
    if (url === '/api/download' && init?.method === 'POST') {
      return options.postDownload ? options.postDownload() : json({}, 404);
    }
    if (url === '/api/download/relocate' && init?.method === 'POST') {
      return options.relocate ? options.relocate() : json({}, 404);
    }
    if (url.includes('/api/download?bookId=')) {
      // 详情页查「本人」任务：空对象解析为 null，停在 task===null 按钮态。
      return json({});
    }
    if (url.includes('/api/download?id=')) {
      return options.taskById ? options.taskById() : json({}, 404);
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
  await screen.findByRole('button', { name: '⬇ 下载全书' });
}

const entryName = '⟳ 换活跃源重下';

async function offerRelocate(apiFetch: ReturnType<typeof makeApiFetch>) {
  fireEvent.click(screen.getByRole('button', { name: '⬇ 下载全书' }));
  const entry = await screen.findByRole('button', { name: entryName });
  return entry;
}

afterEach(() => {
  cleanup();
});

describe('LibraryTab 换活跃源重定位', () => {
  it('400 UNSUPPORTED_SOURCE 置位入口；其他失败码不出现', async () => {
    let code: string | undefined = 'UNSUPPORTED_SOURCE';
    const apiFetch = makeApiFetch({
      postDownload: () => json({ error: 'source retired', code }, 400),
    });
    await openDetail(apiFetch);

    // 退休源：错误照旧显示，旁边多出换源入口与解释行。
    await offerRelocate(apiFetch);
    expect(screen.getByRole('alert').textContent).toContain('source retired');
    expect(screen.getByText('原下载源已下线或不被支持，可按书名+作者在当前活跃书源池重新定位后下载。')).toBeTruthy();

    // 返回并重进：入口已重置；换一种失败码不再出现。
    fireEvent.click(screen.getByRole('button', { name: '← 返回书库' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看测试书详情' }));
    await screen.findByRole('button', { name: '⬇ 下载全书' });
    expect(screen.queryByRole('button', { name: entryName })).toBeNull();

    code = 'MISSING_SOURCE_URL';
    fireEvent.click(screen.getByRole('button', { name: '⬇ 下载全书' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: entryName })).toBeNull();
  });

  it('relocate 201 → 乐观 pending 任务 + matched 命中文案，轮询接管', async () => {
    const apiFetch = makeApiFetch({
      postDownload: () => json({ error: 'source retired', code: 'UNSUPPORTED_SOURCE' }, 400),
      relocate: () => json({
        taskId: 81,
        resolvedSource: {
          bookUrl: 'https://active.example/book/7', sourceUrl: 'https://active.example/',
          revision: 'revision-7', matched: { title: '测试书（修订版）', author: '作者' },
        },
      }, 201),
      taskById: () => json({ id: 81, bookId: 7, title: '测试书', status: 'pending', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, error: null, updatedAt: '' }),
    });
    await openDetail(apiFetch);
    fireEvent.click(await offerRelocate(apiFetch));

    // 视图切到任务分支：入口物理消失，matched 版本当场可见。
    await screen.findByText('排队中，等待下载任务开始');
    expect(screen.queryByRole('button', { name: entryName })).toBeNull();
    expect(screen.getByText(/已在活跃书源匹配到《测试书（修订版）》（作者），加入下载队列。/)).toBeTruthy();

    // 轮询 effect 挂载并立即拉一次该任务。
    await waitFor(() => {
      const polls = apiFetch.mock.calls.filter((call) => String(call[0]).includes('/api/download?id=81'));
      expect(polls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('relocate 422 AMBIGUOUS → 候选只读渲染、无点选交互、入口保留', async () => {
    const apiFetch = makeApiFetch({
      postDownload: () => json({ error: 'source retired', code: 'UNSUPPORTED_SOURCE' }, 400),
      relocate: () => json({
        error: 'ambiguous', code: 'RELOCATION_AMBIGUOUS',
        candidates: [
          { title: '测试书', author: '作者甲', bookUrl: 'https://a.example/book/1' },
          { title: '测试书', author: '作者乙', bookUrl: 'https://b.example/book/2' },
        ],
      }, 422),
    });
    await openDetail(apiFetch);
    fireEvent.click(await offerRelocate(apiFetch));

    await screen.findByText(/命中多个不同条目/);
    const list = screen.getByLabelText('重定位候选（仅供参考）');
    expect(list.textContent).toContain('《测试书》 — 作者甲 · a.example');
    expect(list.textContent).toContain('《测试书》 — 作者乙 · b.example');
    // 只读：候选区内不产生任何可点选元素（无「用这个候选下载」通路）。
    expect(list.querySelectorAll('button, a, [role="button"]').length).toBe(0);
    // 入口保留可重试（书源池会更新）。
    expect(screen.getByRole('button', { name: entryName })).toBeTruthy();
  });

  it('relocate 409 → 逐字复用 startDownload 的「跳到已有任务」处理', async () => {
    const apiFetch = makeApiFetch({
      postDownload: () => json({ error: 'source retired', code: 'UNSUPPORTED_SOURCE' }, 400),
      relocate: () => json({ code: 'TASK_CONFLICT', taskId: 55, status: 'running' }, 409),
      taskById: () => json({ id: 55, bookId: 7, title: '测试书', status: 'done', chaptersTotal: 10, chaptersDone: 10, charsTotal: 123456, error: null, updatedAt: '' }),
    });
    await openDetail(apiFetch);
    fireEvent.click(await offerRelocate(apiFetch));

    // 409 后按 taskId GET 真实状态：done → 展示完成态与取回按钮，而非误当 pending。
    await screen.findByText(/任务已完成，可取回文件。/);
    expect(screen.getByText('完成，共 123456 字')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取回文件' })).toBeTruthy();
  });

  it('dlBusy 期间入口与下载按钮同禁；切详情重置状态且过期响应作废', async () => {
    let resolveRelocate!: (response: Response) => void;
    const inflight = new Promise<Response>((done) => { resolveRelocate = done; });
    const apiFetch = makeApiFetch({
      postDownload: () => json({ error: 'source retired', code: 'UNSUPPORTED_SOURCE' }, 400),
      relocate: () => inflight,
    });
    await openDetail(apiFetch);
    fireEvent.click(await offerRelocate(apiFetch));

    // 在飞：换源按钮进入 loading 文案并禁用，下载全书同步禁用（单一 dlBusy 门控）。
    const busyEntry = await screen.findByRole('button', { name: '正在活跃源中查找…' });
    expect((busyEntry as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '提交中…' }) as HTMLButtonElement).disabled).toBe(true);

    // 返回书库再重进：入口已随 showDetail 重置消失。
    fireEvent.click(screen.getByRole('button', { name: '← 返回书库' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看测试书详情' }));
    await screen.findByRole('button', { name: '⬇ 下载全书' });
    expect(screen.queryByRole('button', { name: entryName })).toBeNull();

    // 过期 201 到达：dlRequestId 已被详情切换递增，不得落任何任务态。
    await act(async () => {
      resolveRelocate(json({ taskId: 99, resolvedSource: { matched: { title: '测试书', author: '作者' } } }, 201));
    });
    expect(screen.queryByText(/排队中/)).toBeNull();
    expect(screen.getByRole('button', { name: '⬇ 下载全书' })).toBeTruthy();
  });
});
