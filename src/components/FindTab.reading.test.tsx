// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FindTab from './FindTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), canRead: true }));
vi.mock('@/components/OwnerProvider', () => ({
  useOwner: () => ({ apiFetch: mocks.apiFetch, user: { id: 7 }, ready: true,
    can: (permission: string) => permission === 'read' ? mocks.canRead : true }),
}));

beforeEach(() => { mocks.apiFetch.mockReset(); mocks.canRead = true; });
afterEach(cleanup);

async function search(item: Record<string, unknown>) {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ source: 'library', items: [{
    title: '已有正文', author: '测试作者', source: 'library', ...item,
  }] }), { headers: { 'Content-Type': 'application/json' } }));
  render(<FindTab />);
  fireEvent.click(screen.getByRole('tab', { name: '精确找书' }));
  fireEvent.change(screen.getByRole('textbox', { name: '书名' }), { target: { value: '已有正文' } });
  fireEvent.click(screen.getByRole('button', { name: '精确查找' }));
  await screen.findByRole('heading', { name: '已有正文' });
}

describe('精确找书结果的阅读入口', () => {
  it('已有共享 TXT 定位时直达下载阅读链，不重新走书源', async () => {
    await search({ readAvailability: 'txt', sharedReadTaskId: 88 });
    const link = screen.getByRole('link', { name: '直接阅读《已有正文》' });
    expect(link.getAttribute('href')).toBe('/read/88?from=find');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { readAvailability: 'txt' },
    { readAvailability: 'online' },
    { readAvailability: 'txt', sharedReadTaskId: -1 },
  ])('无有效任务 ID 保留原书源回退：%j', async (item) => {
    await search(item);
    const href = screen.getByRole('link', { name: '直接阅读《已有正文》' }).getAttribute('href');
    expect(href).toContain('/read/source?');
    expect(new URL(href!, 'http://localhost').searchParams.get('author')).toBe('测试作者');
    expect(href).toContain('from=find');
  });

  it('没有 read 权限且服务端未给定位时，保留既有受限阅读说明深链', async () => {
    mocks.canRead = false;
    await search({ readAvailability: 'txt' });
    const link = screen.getByRole('link', { name: '直接阅读《已有正文》（当前账号尚无阅读权限）' });
    expect(link.getAttribute('href')).toContain('/read/source?');
  });

  it('仅有元数据的命中仍不承诺直接阅读', async () => {
    await search({ readAvailability: 'metadata' });
    expect(screen.queryByRole('link', { name: /直接阅读/ })).toBeNull();
  });
});
