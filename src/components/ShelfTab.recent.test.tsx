// @vitest-environment jsdom
// readerux42-C:书架「最近在读」入口的行为钉(排序/数据缺失不出区/源记忆/去重/上限 5)。
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  isCurrentSession: (id: number) => id === 1,
  ownerUser: { id: 5 } as { id: number } | null,
}));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, user: mocks.ownerUser, sessionId: 1, isCurrentSession: mocks.isCurrentSession,
}) }));
vi.mock('@/components/ReadBookLink', () => ({
  // 暴露 label,便于断言「续读 · 第 N 章」与 taskId 传参。
  default: (props: { taskId?: number | null; label?: string }) => (
    <button type="button" data-task-id={props.taskId ?? ''}>{props.label ?? '阅读'}</button>
  ),
}));
vi.mock('@/components/FeedbackForm', () => ({ default: () => null }));
import ShelfTab from './ShelfTab';
import { rememberSource } from '@/lib/source-memory';
import { userReadingProgressKey } from '@/lib/user-scope';

let nextId = 1;
function shelfItem(over: Record<string, unknown> = {}) {
  return {
    id: nextId++, book_id: nextId * 100, title: `书${nextId}`, author: `者${nextId}`, query: `查询${nextId}`,
    status: 'reading', note: '', created_at: '2026-10-01T00:00:00Z',
    match_score: null, hit_likes: [], risks: null, reason: null, meta: {},
    ...over,
  };
}

function progress(chapterIndex: number, updatedAt: number) {
  return JSON.stringify({ schema: 1, version: 2, chapterIndex, partIndex: 0, ratio: 0.5, updatedAt });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockShelf(items: unknown[]) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/recommendations') return json({ recommendations: items });
    throw new Error(`unexpected URL: ${url}`);
  });
}

const MIN = 60_000;

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  mocks.ownerUser = { id: 5 };
});
afterEach(() => { cleanup(); });

async function renderShelf() {
  render(<ShelfTab />);
  await screen.findByText(/^在读 · \d+$/); // 分组表头出现 ⇒ 列表加载完成
}

function recentRegion() {
  return screen.getByRole('region', { name: '最近在读' });
}
function recentTitles() {
  return Array.from(recentRegion().querySelectorAll('.book-card .font-bold')).map((el) => el.textContent);
}

describe('readerux42-C 书架最近在读', () => {
  it('按最后阅读时间倒序展示,带时间文案与「续读 · 第 N 章」深链', async () => {
    const now = Date.now();
    mockShelf([
      shelfItem({ title: '旧书', author: '旧者', read_task_id: 101 }),
      shelfItem({ title: '新书', author: '新者', read_task_id: 102 }),
    ]);
    window.localStorage.setItem(userReadingProgressKey(5, 101), progress(3, now - 2 * 24 * 60 * MIN));
    window.localStorage.setItem(userReadingProgressKey(5, 102), progress(9, now - 5 * MIN));

    await renderShelf();
    expect(recentTitles()).toEqual(['新书', '旧书']);
    const links = within(recentRegion()).getAllByRole('button');
    expect(links.map((b) => b.textContent)).toEqual(['续读 · 第 10 章', '续读 · 第 4 章']);
    expect(links[0].getAttribute('data-task-id')).toBe('102');
    expect(within(recentRegion()).getByText('5 分钟前')).toBeTruthy();
    expect(within(recentRegion()).getByText('2 天前')).toBeTruthy();
  });

  it('本地无任何阅读数据时该区不出现', async () => {
    mockShelf([shelfItem({ title: '没读过的书' })]);
    await renderShelf();
    expect(screen.queryByRole('region', { name: '最近在读' })).toBeNull();
    expect(screen.getByText('没读过的书')).toBeTruthy();
  });

  it('未登录(user 为空)不合成该区,列表本身照常渲染', async () => {
    mocks.ownerUser = null;
    window.localStorage.setItem(userReadingProgressKey(5, 101), progress(1, Date.now() - MIN));
    mockShelf([shelfItem({ title: '匿名书', read_task_id: 101 })]);
    await renderShelf();
    expect(screen.queryByRole('region', { name: '最近在读' })).toBeNull();
    expect(screen.getByText('匿名书')).toBeTruthy();
  });

  it('无 read_task_id 的源类书按换源源记忆排序,不带章节号', async () => {
    const now = Date.now();
    mockShelf([
      shelfItem({ title: '源书', author: '源者' }),
      shelfItem({ title: '任务书', author: '任务者', read_task_id: 201 }),
    ]);
    rememberSource('源书', '源者', { sourceUrl: 'https://s.example/b', bookUrl: 'https://s.example/b/1' }, now - MIN);
    window.localStorage.setItem(userReadingProgressKey(5, 201), progress(6, now - 3 * 60 * MIN));

    await renderShelf();
    expect(recentTitles()).toEqual(['源书', '任务书']);
    const labels = within(recentRegion()).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['续读', '续读 · 第 7 章']);
  });

  it('同一本书多条目取最新一条;最多展示 5 本', async () => {
    const now = Date.now();
    const items: unknown[] = [
      // 同一 book_id 两条:较新的进度决定排序与章节。
      shelfItem({ title: '同书甲', author: '甲', book_id: 900, read_task_id: 301 }),
      shelfItem({ title: '同书乙', author: '乙', book_id: 900, read_task_id: 302 }),
      ...Array.from({ length: 6 }, (_, i) => shelfItem({ read_task_id: 310 + i })),
    ];
    mockShelf(items);
    window.localStorage.setItem(userReadingProgressKey(5, 301), progress(1, now - 8 * 24 * 60 * MIN));
    window.localStorage.setItem(userReadingProgressKey(5, 302), progress(2, now - 10 * MIN));
    // 6 本独立书,时间递减 ⇒ 第 6 本(最旧)被 5 本上限裁掉。
    items.slice(2).forEach((it, i) => {
      const { read_task_id, title } = it as { read_task_id: number; title: string };
      window.localStorage.setItem(userReadingProgressKey(5, read_task_id), progress(0, now - (30 + i * 10) * MIN));
    });

    await renderShelf();
    const titles = recentTitles();
    expect(titles).toHaveLength(5);
    expect(titles[0]).toBe('同书乙'); // book_id 900 去重后剩最新一条
    expect(titles).not.toContain('同书甲');
    // 最旧的独立书(第 6 本)不在列。
    const allTitles = items.map((it) => (it as { title: string }).title);
    expect(titles).not.toContain(allTitles[allTitles.length - 1]);
  });
});
