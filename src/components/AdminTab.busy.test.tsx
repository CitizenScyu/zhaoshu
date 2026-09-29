// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminTab from './AdminTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), isCurrentSession: () => true }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, sessionId: 1, isCurrentSession: mocks.isCurrentSession,
}) }));

const users = [1, 2, 3].map(id => ({ id, username: `synthetic_${id}`, role: id === 1 ? 'owner' : 'member',
  canFind: true, canRead: false, canDownload: false, disabled: false, createdAt: '2026-09-30', inviteHint: null }));
const registration = { membersEnabled: true, accountsEnabled: true, registrationMode: 'closed', updatedAt: null };
let writes: Array<{ url: string; body: unknown; resolve: (response: Response) => void }>;
beforeEach(() => {
  writes = [];
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return new Promise<Response>(resolve => {
      writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null, resolve });
    });
    if (url.endsWith('/registration')) return Response.json(registration);
    if (url.endsWith('/users')) return Response.json({ users });
    if (url.endsWith('/invites')) return Response.json({ invites: [
      { id: 4, codeHint: 'synthetic', status: 'active', expiresAt: null },
      { id: 5, codeHint: 'synthetic-revoked', status: 'revoked', expiresAt: null },
    ] });
    if (url.endsWith('/label-model')) return Response.json({ model: 'synthetic-label', updatedAt: null });
    if (url.endsWith('/llm')) return Response.json({ model: 'synthetic-main', defaultModel: 'synthetic-main',
      source: 'default', defaultSource: 'default', reasoning: null, updatedAt: null, defaultUpdatedAt: null });
    throw new Error('Unexpected synthetic API');
  });
});
afterEach(cleanup);

it.each(['success', 'failure'])('blocks other writes during a held user PATCH and restores controls after %s', async outcome => {
  const user = userEvent.setup();
  render(<AdminTab />);
  await screen.findByRole('checkbox', { name: 'synthetic_2 canRead' });
  const label = within(screen.getByRole('region', { name: '打标模型' }));
  const main = within(screen.getByRole('region', { name: '主模型' }));
  await user.click(screen.getByRole('radio', { name: '邀请码注册' }));
  await user.type(label.getByLabelText('新模型名'), 'synthetic-next');
  await user.type(main.getByLabelText('新模型名'), 'synthetic-independent');
  await user.click(screen.getByRole('checkbox', { name: 'synthetic_2 canRead' }));
  expect(writes).toHaveLength(1);
  const controls = [screen.getByRole('checkbox', { name: 'synthetic_3 canRead' }),
    screen.getAllByRole('button', { name: '启用中 · 点击禁用' })[2],
    screen.getByRole('button', { name: '保存注册设置' }), screen.getByRole('button', { name: '生成邀请码' }),
    screen.getAllByRole('button', { name: '作废' })[0],
    label.getByRole('button', { name: '保存' }), label.getByRole('button', { name: '清除（回退 .env）' }),
  ] as Array<HTMLInputElement | HTMLButtonElement>;
  for (const control of controls) { expect(control.disabled).toBe(true); await user.click(control); }
  expect(writes).toHaveLength(1);
  // Drafts and the separately managed main model remain editable.
  await user.click(screen.getByRole('radio', { name: '开放注册' }));
  expect((screen.getByRole('radio', { name: '开放注册' }) as HTMLInputElement).checked).toBe(true);
  expect((label.getByLabelText('新模型名') as HTMLInputElement).disabled).toBe(false);
  expect((main.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => writes[0].resolve(outcome === 'success'
    ? Response.json({ user: { ...users[1], canRead: true } })
    : Response.json({ error: 'synthetic failure' }, { status: 503 })));
  for (const control of controls) expect(control.disabled).toBe(false);
  expect((screen.getByRole('checkbox', { name: 'synthetic_1 canRead' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getAllByRole('button', { name: '作废' })[1] as HTMLButtonElement).disabled).toBe(true);
  await user.click(controls[0]);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ url: '/api/admin/users/3', body: { canRead: true } });
  await act(async () => writes[1].resolve(Response.json({ user: { ...users[2], canRead: true } })));
});
