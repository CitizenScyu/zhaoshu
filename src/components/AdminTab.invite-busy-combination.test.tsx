// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminTab from './AdminTab';

const owner = vi.hoisted(() => ({ apiFetch: vi.fn(), isCurrentSession: () => true }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const users = [1, 2, 3].map(id => ({ id, username: `synthetic_${id}`, role: id === 1 ? 'owner' : 'member',
  canFind: true, canRead: false, canDownload: false, disabled: false, createdAt: '2026-09-30', inviteHint: null }));
const oldInvites = [
  { id: 7, codeHint: 'synthetic-old', status: 'active', expiresAt: null },
  { id: 8, codeHint: 'synthetic-revoked', status: 'revoked', expiresAt: null },
];
const partialSuccess = '✓ 邀请码已生成，请立即复制。列表暂未刷新，无需再次生成。';
let refresh: ReturnType<typeof deferred>;
let nextWrite: ReturnType<typeof deferred>;
beforeEach(() => {
  refresh = deferred(); nextWrite = deferred();
  let posted = false;
  owner.apiFetch.mockReset();
  owner.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/admin/invites') {
      if (init?.method === 'POST') {
        posted = true;
        return Response.json({ invites: [{ code: 'synthetic-created-only', codeHint: 'new', expiresAt: null }] }, { status: 201 });
      }
      return posted ? refresh.promise : Response.json({ invites: oldInvites });
    }
    if (init?.method && init.method !== 'GET') return nextWrite.promise;
    if (url.endsWith('/users')) return Response.json({ users });
    if (url.endsWith('/registration')) return Response.json({ membersEnabled: true, accountsEnabled: true,
      registrationMode: 'closed', updatedAt: null });
    if (url.endsWith('/label-model')) return Response.json({ model: 'synthetic-label', updatedAt: null });
    if (url.endsWith('/llm')) return Response.json({ model: 'synthetic-main', defaultModel: 'synthetic-main',
      source: 'default', defaultSource: 'default', reasoning: null, updatedAt: null, defaultUpdatedAt: null });
    throw new Error(`Unexpected synthetic API: ${url}`);
  });
});
afterEach(async () => {
  cleanup();
  // Also settle held mocks if an assertion fails; no pending refresh/write escapes a case.
  await act(async () => {
    refresh.resolve(Response.json({ invites: oldInvites }));
    nextWrite.resolve(Response.json({ user: users[1] }));
  });
});
const writes = () => owner.apiFetch.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
const inviteRequests = () => owner.apiFetch.mock.calls.filter(([url]) => url === '/api/admin/invites')
  .map(([, init]) => init?.method ?? 'GET');
function writeControls() {
  const label = within(screen.getByRole('region', { name: '打标模型' }));
  return [
    screen.getByRole('checkbox', { name: 'synthetic_3 canRead' }),
    screen.getAllByRole('button', { name: '启用中 · 点击禁用' })[2],
    screen.getByRole('button', { name: '保存注册设置' }),
    screen.getByRole('button', { name: /^(生成邀请码|生成中…)$/ }),
    screen.getAllByRole('button', { name: '作废' })[0],
    label.getByRole('button', { name: '保存' }),
    label.getByRole('button', { name: '清除（回退 .env）' }),
  ] as Array<HTMLInputElement | HTMLButtonElement>;
}
function expectIntrinsicDisabled() {
  expect((screen.getByRole('checkbox', { name: 'synthetic_1 canRead' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getAllByRole('button', { name: '作废' })[1] as HTMLButtonElement).disabled).toBe(true);
}

it.each(['network', 'http', 'json', 'success'] as const)(
  'holds all seven write controls through invite refresh, then recovers after %s', async outcome => {
    const user = userEvent.setup();
    render(<AdminTab />);
    await screen.findByRole('checkbox', { name: 'synthetic_2 canRead' });
    const label = within(screen.getByRole('region', { name: '打标模型' }));
    const draft = label.getByLabelText('新模型名');
    await user.click(screen.getByRole('radio', { name: '邀请码注册' }));
    await user.type(draft, 'synthetic-next');
    // Dirty drafts make the baseline actionable, rather than coincidentally disabled.
    for (const control of writeControls()) expect(control.disabled).toBe(false);
    expectIntrinsicDisabled();
    await user.click(screen.getByRole('button', { name: '生成邀请码' }));
    await waitFor(() => expect(inviteRequests()).toEqual(['GET', 'POST', 'GET']));
    expect(screen.getByText('synthetic-created-only')).toBeTruthy();
    expect(screen.getByText('✓ 已生成邀请码：原文只显示这一次，请立即复制。')).toBeTruthy();
    for (const control of writeControls()) {
      expect(control.disabled).toBe(true);
      await user.click(control);
    }
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject(['/api/admin/invites', { method: 'POST' }]);
    expectIntrinsicDisabled();

    await act(async () => {
      if (outcome === 'network') refresh.reject(new Error('synthetic refresh unavailable'));
      else if (outcome === 'http') refresh.resolve(Response.json({ error: 'synthetic unavailable' }, { status: 503 }));
      else if (outcome === 'json') refresh.resolve(new Response('<synthetic-invalid-json>'));
      else refresh.resolve(Response.json({ invites: [...oldInvites,
        { id: 9, codeHint: 'synthetic-new', status: 'active', expiresAt: null }] }));
    });
    await waitFor(() => { for (const control of writeControls()) expect(control.disabled).toBe(false); });
    expect(screen.getByText('synthetic-created-only')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const list = within(screen.getByRole('table', { name: '邀请码列表' }));
    expect(list.getByText('…synthetic-old')).toBeTruthy();
    expect(list.getByText('…synthetic-revoked')).toBeTruthy();
    if (outcome === 'success') {
      expect(list.getByText('…synthetic-new')).toBeTruthy();
      expect(screen.queryByText(partialSuccess)).toBeNull();
      expect(screen.getByText('✓ 已生成邀请码：原文只显示这一次，请立即复制。')).toBeTruthy();
    } else {
      expect(list.queryByText('…synthetic-new')).toBeNull();
      expect(screen.getByText(partialSuccess)).toBeTruthy();
    }
    expect(inviteRequests()).toEqual(['GET', 'POST', 'GET']);
    expect(writes()).toHaveLength(1);
    expectIntrinsicDisabled();
    await user.clear(draft);
    expect((label.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(draft, 'synthetic-next');

    // A new user PATCH owns busy now; draining the old refresh continuation cannot clear it.
    await user.click(screen.getByRole('checkbox', { name: 'synthetic_2 canRead' }));
    expect(writes()).toHaveLength(2);
    expect(writes()[1]).toMatchObject(['/api/admin/users/2', { method: 'PATCH', body: JSON.stringify({ canRead: true }) }]);
    await act(async () => { await Promise.resolve(); });
    for (const control of writeControls()) {
      expect(control.disabled).toBe(true);
      await user.click(control);
    }
    expect(writes()).toHaveLength(2);
    expect(inviteRequests()).toEqual(['GET', 'POST', 'GET']);
    await act(async () => nextWrite.resolve(Response.json({ user: { ...users[1], canRead: true } })));
    await waitFor(() => { for (const control of writeControls()) expect(control.disabled).toBe(false); });
    expect((screen.getByRole('checkbox', { name: 'synthetic_2 canRead' }) as HTMLInputElement).checked).toBe(true);
    expectIntrinsicDisabled();
  },
);
