// @vitest-environment jsdom
// 会话代际已变而旧管理页尚未重挂；所有账号、邀请码与模型名均为合成值。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminTab from './AdminTab';

const owner = vi.hoisted(() => ({ current: 1, apiFetch: vi.fn(), isCurrentSession: vi.fn() }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));
vi.mock('./ModelSettingsTab', () => ({ default: () => null }));
const registration = { membersEnabled: true, accountsEnabled: true, registrationMode: 'closed', updatedAt: null };
const member = { id: 2, username: 'synthetic_member', role: 'member', canFind: true, canRead: true,
  canDownload: true, disabled: false, createdAt: '2026-09-29T00:00:00Z', inviteHint: null };
const invite = { id: 7, codeHint: 'synthetic', status: 'active', expiresAt: null, usedByUsername: null };
const created = { invites: [{ code: 'synthetic-invite-only', codeHint: 'only', expiresAt: null }] };
const json = (value: unknown) => Response.json(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function data(input: string, init?: RequestInit) {
  if (input.endsWith('/registration')) return { ...registration, ...(init?.body ? JSON.parse(String(init.body)) : {}) };
  if (input.endsWith('/users')) return { users: [member] };
  if (input.endsWith('/users/2')) return { user: { ...member, ...JSON.parse(String(init?.body)) } };
  if (input.endsWith('/invites')) return init?.method === 'POST' ? created : { invites: [invite] };
  if (input.endsWith('/revoke')) return { ok: true };
  if (input.endsWith('/label-model')) return { model: init?.body ? JSON.parse(String(init.body)).model : 'synthetic-old', updatedAt: null };
  throw new Error('未知合成请求');
}
const actions = [
  { key: 'registration', button: '保存注册设置' },
  { key: 'user', button: '启用中 · 点击禁用' },
  { key: 'create', button: '生成邀请码' },
  { key: 'revoke', button: '作废' },
  { key: 'label', button: '保存' },
  { key: 'clear', button: '清除（回退 .env）' },
];
async function ready(key: string, button: string) {
  await screen.findByText('synthetic-old');
  if (key === 'registration') fireEvent.click(screen.getByRole('radio', { name: '邀请码注册' }));
  if (key === 'label') fireEvent.change(screen.getByLabelText('新模型名'), { target: { value: 'synthetic-new' } });
  return screen.getByRole('button', { name: button });
}
beforeEach(() => {
  owner.current = 1;
  owner.apiFetch.mockReset();
  owner.isCurrentSession.mockImplementation((expected: number) => expected === owner.current);
});
afterEach(cleanup);

describe.each(actions)('$key 管理动作', ({ key, button }) => {
  it('旧入口不在新代际下写入', async () => {
    owner.apiFetch.mockImplementation(async (input, init) => json(data(input, init)));
    render(<AdminTab />);
    const control = await ready(key, button);
    owner.current = 2;
    fireEvent.click(control);
    await act(async () => {});
    expect(owner.apiFetch.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it.each(['session', 'unmount', 'normal'])('动作正文迟到：%s', async mode => {
    const body = deferred<unknown>();
    let bodyStarted = false;
    let writeSignal: AbortSignal | undefined;
    let reply: unknown;
    let inviteGets = 0;
    owner.apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/invites') && !init?.method) inviteGets += 1;
      if (init?.method) {
        writeSignal = init.signal as AbortSignal;
        reply = data(input, init);
        const response = json({});
        response.json = () => { bodyStarted = true; return body.promise; };
        return response;
      }
      return json(data(input, init));
    });
    const ui = render(<AdminTab />);
    fireEvent.click(await ready(key, button));
    await waitFor(() => expect(bodyStarted).toBe(true));
    if (mode === 'session') owner.current = 2;
    if (mode === 'unmount') {
      ui.unmount();
      expect(writeSignal?.aborted).toBe(true);
    }
    await act(async () => { body.resolve(reply); });
    expect(inviteGets).toBe(key === 'create' && mode === 'normal' ? 2 : 1);
    if (mode === 'session') expect(screen.queryByRole('status')).toBeNull();
    if (mode === 'normal') {
      expect(screen.getAllByRole('status').some(node => /已保存|已更新|已生成|已作废|已设为|已清除/.test(node.textContent ?? ''))).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });
});

it.each(['session', 'normal'])('复制入口：%s', async mode => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  owner.apiFetch.mockImplementation(async (input, init) => json(data(input, init)));
  render(<AdminTab />);
  fireEvent.click(await ready('create', '生成邀请码'));
  const copy = await screen.findByRole('button', { name: '复制' });
  if (mode === 'session') owner.current = 2;
  fireEvent.click(copy);
  await act(async () => {});
  expect(writeText).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0);
  if (mode === 'normal') expect(writeText).toHaveBeenCalledWith('synthetic-invite-only');
});

it('初次管理数据加载在会话换代后迟到，不显示旧数据', async () => {
  const body = deferred<unknown>();
  let bodyStarted = false;
  owner.apiFetch.mockImplementation(async (input, init) => {
    if (input.endsWith('/registration')) {
      const response = json({});
      response.json = () => { bodyStarted = true; return body.promise; };
      return response;
    }
    return json(data(input, init));
  });
  render(<AdminTab />);
  await waitFor(() => expect(bodyStarted).toBe(true));
  owner.current = 2;
  await act(async () => { body.resolve(registration); });
  expect(screen.queryByText('synthetic-old')).toBeNull();
  expect(screen.queryByText('synthetic_member')).toBeNull();
});
