// @vitest-environment jsdom
// zhuigeng42：书架「有更新」徽标的渲染口径。has_update 的真假在真库上验（followup.pglite.test.ts），
// 这里只钉「服务端给了 true 才亮徽标、其余一切不变」——徽标是纯提示，不许顺手改掉卡片的其他行为。

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShelfTab from './ShelfTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({
  useOwner: () => ({ apiFetch: mocks.apiFetch, user: { id: 7 }, sessionId: 's1', isCurrentSession: () => true,
    can: () => true }),
}));

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ recommendations: [
    { id: 1, book_id: 11, query: '连载', match_score: null, hit_likes: [], risks: null, reason: null,
      status: 'reading', note: '', created_at: new Date().toISOString(), title: '有更新的书', author: '作者甲',
      douban_id: null, douban_rating: null, douban_rating_count: null, meta: {}, read_task_id: 5, has_update: true },
    { id: 2, book_id: 12, query: '完结', match_score: null, hit_likes: [], risks: null, reason: null,
      status: 'reading', note: '', created_at: new Date().toISOString(), title: '没更新的书', author: '作者乙',
      douban_id: null, douban_rating: null, douban_rating_count: null, meta: {}, read_task_id: 6, has_update: false },
  ] }), { headers: { 'Content-Type': 'application/json' } }));
});
afterEach(cleanup);

describe('书架「有更新」徽标', () => {
  it('只在 has_update 的那一行亮徽标，两本书都在书架里', async () => {
    render(<ShelfTab />);
    await screen.findByText('有更新的书');
    expect(screen.getByText('没更新的书')).toBeTruthy();
    const badges = screen.getAllByLabelText('有更新');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('有更新');
  });

  it('服务端没给 has_update（旧缓存 / 老行）时按无更新渲染，不炸也不亮', async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ recommendations: [
      { id: 3, book_id: 13, query: '老数据', match_score: null, hit_likes: [], risks: null, reason: null,
        status: 'reading', note: '', created_at: new Date().toISOString(), title: '老数据的书', author: '作者丙',
        douban_id: null, douban_rating: null, douban_rating_count: null, meta: {} },
    ] }), { headers: { 'Content-Type': 'application/json' } }));
    render(<ShelfTab />);
    await screen.findByText('老数据的书');
    expect(screen.queryByLabelText('有更新')).toBeNull();
  });
});
