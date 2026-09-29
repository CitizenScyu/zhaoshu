// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ShuyuanTab from './ShuyuanTab';

const owner = vi.hoisted(() => ({ current: 1, apiFetch: vi.fn(), isCurrentSession: vi.fn() }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));
const stats = { total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0,
  collections: [], sources: [], refreshedAt: null, filter: 'all', page: 1, pageSize: 20, totalPages: 1, sourcesLimit: 20 };
beforeEach(() => {
  owner.current = 1; owner.apiFetch.mockReset();
  owner.isCurrentSession.mockImplementation((id: number) => id === owner.current);
});
afterEach(cleanup);
const retry = () => screen.getByRole('button', { name: '重新读取列表' }) as HTMLButtonElement;

it('retries only GET, blocks duplicates while pending, preserves retry after failure and clears it on success', async () => {
  let resolve!: (value: Response) => void;
  owner.apiFetch.mockRejectedValueOnce(new Error('synthetic initial failure'))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
    .mockResolvedValueOnce(Response.json(stats));
  render(<ShuyuanTab />); const user = userEvent.setup();
  await screen.findByRole('alert'); expect(owner.apiFetch).toHaveBeenCalledTimes(1);
  await user.click(retry());
  expect(retry().disabled).toBe(true);
  await user.click(retry()); expect(owner.apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => resolve(new Response('<invalid-json>')));
  expect(retry().disabled).toBe(false); expect(screen.getByRole('alert')).toBeTruthy();
  await user.click(retry());
  expect(screen.getByRole('group', { name: '按状态筛选书源' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: '重新读取列表' })).toBeNull();
  expect(owner.apiFetch.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET']))
    .toEqual(Array.from({ length: 3 }, () => ['/api/shuyuan?filter=all&page=1', 'GET']));
});

it('does not present a read retry for a POST failure after a successful initial read', async () => {
  owner.apiFetch.mockResolvedValueOnce(Response.json(stats))
    .mockResolvedValueOnce(Response.json({ error: 'synthetic POST failure' }, { status: 503 }));
  render(<ShuyuanTab />);
  await screen.findByRole('group', { name: '按状态筛选书源' });
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新合集' }));
  expect(screen.getByRole('alert').textContent).toContain('synthetic POST failure');
  expect(screen.queryByRole('button', { name: '重新读取列表' })).toBeNull();
  expect(owner.apiFetch).toHaveBeenCalledTimes(2);
});

it.each(['session', 'unmount'])('ignores a late retry result after %s', async mode => {
  let resolve!: (value: Response) => void;
  owner.apiFetch.mockRejectedValueOnce(new Error('synthetic failure'))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const ui = render(<ShuyuanTab />);
  await screen.findByRole('alert'); await userEvent.setup().click(retry());
  await waitFor(() => expect(owner.apiFetch).toHaveBeenCalledTimes(2));
  const signal = owner.apiFetch.mock.calls[1][1].signal as AbortSignal;
  if (mode === 'session') owner.current = 2;
  else { ui.unmount(); expect(signal.aborted).toBe(true); }
  await act(async () => resolve(Response.json(stats)));
  expect(screen.queryByRole('group', { name: '按状态筛选书源' })).toBeNull();
  expect(owner.apiFetch).toHaveBeenCalledTimes(2);
});
