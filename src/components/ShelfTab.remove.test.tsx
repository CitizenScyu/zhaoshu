// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), isCurrentSession: (id: number) => id === 1 }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, sessionId: 1, isCurrentSession: mocks.isCurrentSession,
}) }));
vi.mock('@/components/ReadBookLink', () => ({ default: () => null }));
vi.mock('@/components/FeedbackForm', () => ({ default: () => null }));
import ShelfTab from './ShelfTab';

const item = {
  id: 11, book_id: 22, title: '合成测试书', author: '合成作者', query: '合成查询',
  status: 'want', note: '', feedback_id: 3, created_at: '2026-09-28T00:00:00Z',
  match_score: null, hit_likes: [], risks: null, reason: null, meta: {},
};
const missing = () => Response.json(
  { error: 'recommendation not found', code: 'RECOMMENDATION_NOT_FOUND' }, { status: 404 },
);
const callsTo = (path: string) => mocks.apiFetch.mock.calls.filter(([url]) => url === path);

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { cleanup(); });

async function armRemoval() {
  render(<ShelfTab />);
  fireEvent.click(await screen.findByRole('button', { name: '将合成测试书移出书架' }));
}
function confirmRemoval() {
  fireEvent.click(screen.getByRole('button', { name: '再次点击确认将合成测试书移出书架' }));
}

describe('书架移除的幂等恢复', () => {
  it('已保存原因且删除响应丢失，重试404后刷新完成，不重复提交原因', async () => {
    let onShelf = true;
    let deleted = false;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/recommendations') return Response.json({ recommendations: onShelf ? [item] : [] });
      if (url === '/api/feedback') return Response.json({ ok: true });
      if (url === '/api/shelf?bookId=22') {
        onShelf = false;
        if (!deleted) { deleted = true; throw new TypeError('合成删除响应丢失'); }
        return missing();
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await armRemoval();
    fireEvent.change(screen.getByRole('textbox', { name: '移出前记一句（选填，帮「找书」更准）' }),
      { target: { value: '合成反馈原因' } });
    confirmRemoval();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('合成删除响应丢失'));
    expect(screen.getByText('原因已记下，重试只补「移出」这一步。')).toBeTruthy();
    confirmRemoval();
    await screen.findByText('书架空空，先去「找书」跑一单');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('原因已记下，重试只补「移出」这一步。')).toBeNull();
    expect(callsTo('/api/feedback')).toHaveLength(1);
    expect(JSON.parse(callsTo('/api/feedback')[0][1].body)).toMatchObject({
      note: '合成反馈原因', expectedFeedbackId: 3,
    });
    expect(callsTo('/api/shelf?bookId=22')).toHaveLength(2);
    expect(callsTo('/api/recommendations')).toHaveLength(2);
  });

  it.each(['正常移除', '另一页先移除'])('%s后刷新列表，不提交空反馈', async (scenario) => {
    let onShelf = true;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/recommendations') return Response.json({ recommendations: onShelf ? [item] : [] });
      if (url === '/api/shelf?bookId=22') {
        onShelf = false;
        return scenario === '另一页先移除' ? missing() : Response.json({ ok: true });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await armRemoval();
    confirmRemoval();
    await screen.findByText('书架空空，先去「找书」跑一单');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(callsTo('/api/feedback')).toHaveLength(0);
    expect(callsTo('/api/recommendations')).toHaveLength(2);
  });

  it.each([
    [404, 'OTHER_NOT_FOUND'], [404, undefined], [403, 'RECOMMENDATION_NOT_FOUND'],
  ])('拒绝无关失败 status=%s code=%s，保留书和草稿', async (status, code) => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/recommendations') return Response.json({ recommendations: [item] });
      if (url === '/api/feedback') return Response.json({ ok: true });
      if (url === '/api/shelf?bookId=22') return Response.json({ error: '合成移除错误', code }, { status });
      throw new Error(`unexpected URL: ${url}`);
    });
    await armRemoval();
    fireEvent.change(screen.getByRole('textbox', { name: '移出前记一句（选填，帮「找书」更准）' }),
      { target: { value: '保留合成原因' } });
    confirmRemoval();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('合成移除错误'));
    expect(screen.getByText(item.title)).toBeTruthy();
    expect(screen.getByText('原因已记下，重试只补「移出」这一步。')).toBeTruthy();
    expect(callsTo('/api/recommendations')).toHaveLength(1);
    expect(callsTo('/api/feedback')).toHaveLength(1);
  });
});
