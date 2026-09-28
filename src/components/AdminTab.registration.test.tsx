// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminTab from './AdminTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({ apiFetch: mocks.apiFetch }) }));

const INITIAL = { membersEnabled: true, accountsEnabled: true, registrationMode: 'closed', updatedAt: null };
type Draft = Pick<typeof INITIAL, 'membersEnabled' | 'registrationMode'>;
let saves: Array<{ draft: Draft; resolve: (response: Response) => void }>;

beforeEach(() => {
  saves = [];
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/registration')) return init?.method === 'PATCH'
      ? new Promise<Response>(resolve => { saves.push({ draft: JSON.parse(String(init.body)) as Draft, resolve }); })
      : Response.json(INITIAL);
    if (input.endsWith('/users')) return Response.json({ users: [] });
    if (input.endsWith('/invites')) return Response.json({ invites: [] });
    if (input.endsWith('/label-model')) return Response.json({ model: null, updatedAt: null });
    if (input.endsWith('/llm')) return Response.json({ model: 'synthetic-model', defaultModel: 'synthetic-model',
      source: 'default', defaultSource: 'default', reasoning: null, updatedAt: null, defaultUpdatedAt: null });
    throw new Error('Unexpected synthetic API');
  });
});
afterEach(cleanup);

const mode = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: '保存注册设置' }) as HTMLButtonElement;

async function beginSave() {
  render(<AdminTab />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('radio', { name: '邀请码注册' }));
  await user.click(saveButton());
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].draft).toEqual({ membersEnabled: true, registrationMode: 'invite' });
  return user;
}

async function succeed(index: number) {
  await act(async () => { saves[index].resolve(Response.json({ ...INITIAL, ...saves[index].draft })); });
}

describe('注册设置草稿与保存快照', () => {
  it.each(['注册模式', '成员总闸'])('保存期间修改%s，保留新草稿且下一次提交新值', async field => {
    const user = await beginSave();
    const members = screen.getByRole('checkbox', { name: /成员总闸/ }) as HTMLInputElement;
    if (field === '注册模式') await user.click(mode('开放注册'));
    else await user.click(members);
    const expected = field === '注册模式'
      ? { registrationMode: 'open', membersEnabled: true }
      : { registrationMode: 'invite', membersEnabled: false };
    await succeed(0);
    expect(mode(field === '注册模式' ? '开放注册' : '邀请码注册').checked).toBe(true);
    expect(members.checked).toBe(expected.membersEnabled);
    expect(saveButton().disabled).toBe(false);
    // 第一笔成功提示仍准确描述已保存值，不把新草稿说成已经生效。
    expect(screen.getByText(/已保存：邀请码注册，成员功能已启用/)).toBeTruthy();
    await user.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].draft).toEqual(expected);
    await succeed(1);
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('没有后续编辑时，成功响应更新基准并消除未保存状态', async () => {
    await beginSave();
    await succeed(0);
    expect(mode('邀请码注册').checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/已保存：邀请码注册/)).toBeTruthy();
  });

  it('保存失败保留后续草稿和旧基准，允许再次提交', async () => {
    const user = await beginSave();
    await user.click(mode('开放注册'));
    await act(async () => { saves[0].resolve(Response.json({ error: '合成保存失败' }, { status: 503 })); });
    expect(screen.getByRole('alert').textContent).toContain('合成保存失败');
    expect(screen.queryByText(/已保存：/)).toBeNull();
    expect(mode('开放注册').checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].draft).toEqual({ registrationMode: 'open', membersEnabled: true });
    await succeed(1);
    expect(saveButton().disabled).toBe(true);
  });
});
