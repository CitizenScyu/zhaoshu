// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminTab from './AdminTab';

const owner = vi.hoisted(() => ({ current: 1, apiFetch: vi.fn(), isCurrentSession: vi.fn() }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));
vi.mock('./ModelSettingsTab', () => ({ default: () => null }));
const oldInvite = { id: 7, codeHint: 'synthetic-old', status: 'active', expiresAt: null };
const newInvite = { id: 8, codeHint: 'synthetic-new', status: 'active', expiresAt: null };
const created = { invites: [{ code: 'synthetic-created-only', codeHint: 'new', expiresAt: null }] };
const warning = '邀请码已生成，请立即复制。列表暂未刷新，无需再次生成。';
let postFailed: boolean;
let posted: boolean;
let refreshList: () => Promise<Response>;
let refreshSignal: AbortSignal | undefined;
beforeEach(() => {
  postFailed = false; posted = false; owner.current = 1; refreshSignal = undefined;
  refreshList = async () => Response.json({ invites: [oldInvite, newInvite] });
  owner.apiFetch.mockReset();
  owner.isCurrentSession.mockImplementation((id: number) => owner.current === id);
  owner.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/invites')) {
      if (init?.method === 'POST') {
        posted = true;
        return postFailed ? Response.json({ error: 'synthetic POST failure' }, { status: 503 })
          : Response.json(created, { status: 201 });
      }
      if (posted) { refreshSignal = init?.signal as AbortSignal; return refreshList(); }
      return Response.json({ invites: [oldInvite] });
    }
    if (url.endsWith('/registration')) return Response.json({ membersEnabled: true, accountsEnabled: true, registrationMode: 'closed', updatedAt: null });
    if (url.endsWith('/users')) return Response.json({ users: [] });
    if (url.endsWith('/label-model')) return Response.json({ model: 'synthetic-model', updatedAt: null });
    throw new Error('Unexpected synthetic API');
  });
});
afterEach(cleanup);
async function start() {
  const ui = render(<AdminTab />);
  await screen.findByText('synthetic-model');
  await userEvent.setup().click(screen.getByRole('button', { name: '生成邀请码' }));
  return ui;
}
const requests = () => owner.apiFetch.mock.calls.filter(([url]) => url.endsWith('/invites'));

it.each(['network', 'json', 'http'])('keeps generated codes and the old list after refresh %s failure', async failure => {
  refreshList = async () => {
    if (failure === 'network') throw new Error('synthetic GET failure');
    if (failure === 'json') return new Response('<invalid-json>');
    return new Response('{}', { status: 503 });
  };
  await start();
  expect(screen.getByText('synthetic-created-only')).toBeTruthy();
  expect(screen.getByText(`✓ ${warning}`)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(within(screen.getByRole('table', { name: '邀请码列表' })).getByText('…synthetic-old')).toBeTruthy();
  expect(requests().map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET']);
  expect((screen.getByRole('button', { name: '生成邀请码' }) as HTMLButtonElement).disabled).toBe(false);
});

it('still refreshes the list on success', async () => {
  await start();
  expect(screen.getByText('…synthetic-new')).toBeTruthy();
  expect(screen.getByText('synthetic-created-only')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(`✓ ${warning}`)).toBeNull();
});

it('keeps the original POST failure path and does not request a refresh', async () => {
  postFailed = true;
  await start();
  expect(screen.getByRole('alert').textContent).toContain('synthetic POST failure');
  expect(screen.queryByText('synthetic-created-only')).toBeNull();
  expect(screen.queryByText(`✓ ${warning}`)).toBeNull();
  expect(requests().map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST']);
});

it.each(['session', 'unmount'])('does not report a late refresh rejection after %s', async mode => {
  let reject!: (error: Error) => void;
  refreshList = () => new Promise<Response>((_, fail) => { reject = fail; });
  const ui = await start();
  await waitFor(() => expect(refreshSignal).toBeDefined());
  if (mode === 'session') owner.current = 2;
  else { ui.unmount(); expect(refreshSignal?.aborted).toBe(true); }
  await act(async () => reject(new Error('synthetic late failure')));
  expect(screen.queryByText(`✓ ${warning}`)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(requests()).toHaveLength(3);
});
