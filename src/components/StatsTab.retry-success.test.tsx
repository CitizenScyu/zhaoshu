// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StatsResponse } from '@/app/api/stats/route';
import StatsTab from './StatsTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), current: (id: number) => id === 1 }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, sessionId: 1, isCurrentSession: mocks.current,
}) }));

function recoveredStats(): StatsResponse {
  // A member without download permission also has no shuyuan or owner token section.
  return {
    subject: { userId: 5 }, allowedSections: ['library', 'find', 'shelf'],
    sectionStates: { library: 'ok', find: 'ok', shelf: 'ok', download: 'forbidden', shuyuan: 'forbidden', tokens: 'forbidden' },
    sectionScopes: { library: 'shared', find: 'personal', shelf: 'personal', download: 'personal', shuyuan: 'shared', tokens: 'shared-owner' },
    library: { total: 12, withQuality: 3, avgQuality: 7.5, charsLabeled: 10000, genres: [{ name: '恢复合成分类', count: 4 }] },
    find: { queries: 8, recommendations: 20 }, shelf: { statuses: [{ name: 'want', count: 3 }] },
    download: null, shuyuan: null, tokens: null,
    availability: { library: true, find: true, shelf: true, download: false, shuyuan: false, tokens: false },
  };
}
beforeEach(() => {
  mocks.apiFetch.mockReset();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('SYNTHETIC unexpected network blocked'))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['503', 'reject'] as const)('renders recovered statistics on the same mount after %s', async failure => {
  let resolve!: (response: Response) => void;
  const recovered = new Promise<Response>(done => { resolve = done; });
  const message = failure === '503' ? 'SYNTHETIC 统计暂不可用' : 'SYNTHETIC 网络拒绝';
  let calls = 0;
  mocks.apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
    if (input !== '/api/stats') throw new Error('SYNTHETIC unexpected API blocked');
    calls += 1;
    if (calls === 1) {
      if (failure === 'reject') throw new TypeError(message);
      return Response.json({ error: message, code: 'STATS_UNAVAILABLE' }, { status: 503 });
    }
    if (calls === 2) return recovered;
    throw new Error('SYNTHETIC unexpected retry blocked');
  });
  const view = render(<StatsTab />);
  const user = userEvent.setup();
  try {
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    const retry = screen.getByRole('button', { name: '刷新统计' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    expect((screen.getByRole('button', { name: '读取中…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('读取中…');
    await act(async () => { resolve(Response.json(recoveredStats())); await recovered; });
    // Error clearing alone is insufficient: require successful data before unmounting.
    expect(await screen.findByText('恢复合成分类')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: '刷新统计' }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetch.mock.calls.every(([url]) => url === '/api/stats')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => { resolve(Response.json(recoveredStats())); await recovered; });
    view.unmount();
  }
});
