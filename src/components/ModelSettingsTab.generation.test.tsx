// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelSettingsTab from './ModelSettingsTab';
import { REASONING_CONFIRMATION_CODE } from '@/lib/app-settings-shared';

const owner = vi.hoisted(() => ({ current: 1, apiFetch: vi.fn(), isCurrentSession: vi.fn() }));
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));
const settings = { model: 'synthetic-model', defaultModel: 'synthetic-default', source: 'database', defaultSource: 'database',
  reasoning: 'unknown', updatedAt: '2026-09-29T00:00:00Z', defaultUpdatedAt: '2026-09-29T00:00:00Z' };
const targets = [
  { field: 'model', label: '新模型名', save: '保存', clear: '恢复默认' },
  { field: 'defaultModel', label: '新默认值', save: '保存默认值', clear: '清除默认值' },
];
const confirmation = { code: REASONING_CONFIRMATION_CODE, error: '合成推理模型需要确认' };
const json = (value: unknown, status = 200) => Response.json(value, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function draft(label: string) {
  const input = await screen.findByLabelText(label);
  fireEvent.change(input, { target: { value: 'synthetic-next' } });
  return input as HTMLInputElement;
}
beforeEach(() => {
  owner.current = 1;
  owner.apiFetch.mockReset();
  owner.isCurrentSession.mockImplementation((expected: number) => expected === owner.current);
});
afterEach(cleanup);

describe.each(targets)('$field 代际边界', ({ field, label, save, clear }) => {
  it.each(['save', 'clear'])('旧 %s 按钮不发 PATCH', async action => {
    owner.apiFetch.mockImplementation(async () => json(settings));
    render(<ModelSettingsTab />);
    await draft(label);
    const button = screen.getByRole('button', { name: action === 'save' ? save : clear });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    owner.current = 2;
    fireEvent.click(button);
    await act(async () => {});
    expect(owner.apiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it('旧 409 确认按钮不在新代际提交 acknowledgeReasoning', async () => {
    owner.apiFetch.mockImplementation(async (_input, init?: RequestInit) => init?.method === 'PATCH' ? json(confirmation, 409) : json(settings));
    render(<ModelSettingsTab />);
    await draft(label);
    fireEvent.click(screen.getByRole('button', { name: save }));
    const confirm = await screen.findByRole('button', { name: '确认使用 synthetic-next' });
    owner.current = 2;
    fireEvent.click(confirm);
    await act(async () => {});
    const patches = owner.apiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0][1].body))).toEqual({ [field]: 'synthetic-next' });
  });

  it.each([
    [200, 'session'], [200, 'unmount'], [200, 'normal'],
    [409, 'session'], [409, 'unmount'], [409, 'normal'],
  ])('PATCH 正文迟到 status=%s mode=%s', async (status, mode) => {
    const body = deferred<unknown>();
    let bodyStarted = false;
    let patchSignal: AbortSignal | undefined;
    const submitted: Record<string, unknown>[] = [];
    owner.apiFetch.mockImplementation(async (_input, init?: RequestInit) => {
      if (init?.method !== 'PATCH') return json(settings);
      const value = JSON.parse(String(init.body));
      submitted.push(value);
      if (submitted.length > 1) return json({ ...settings, [field]: 'synthetic-next' });
      patchSignal = init.signal as AbortSignal;
      const response = json({}, Number(status));
      response.json = () => { bodyStarted = true; return body.promise; };
      return response;
    });
    const ui = render(<ModelSettingsTab />);
    const input = await draft(label);
    fireEvent.click(screen.getByRole('button', { name: save }));
    await waitFor(() => expect(bodyStarted).toBe(true));
    if (mode === 'session') owner.current = 2;
    if (mode === 'unmount') { ui.unmount(); expect(patchSignal?.aborted).toBe(true); }
    await act(async () => { body.resolve(status === 409 ? confirmation : { ...settings, [field]: 'synthetic-next' }); });
    expect(submitted).toHaveLength(1);
    if (mode === 'normal') {
      if (status === 409) {
        fireEvent.click(screen.getByRole('button', { name: '确认使用 synthetic-next' }));
        await waitFor(() => expect(submitted).toHaveLength(2));
        expect(submitted[1]).toEqual({ [field]: 'synthetic-next', acknowledgeReasoning: true });
      }
      await waitFor(() => expect(input.value).toBe(''));
      expect(screen.queryByRole('alert')).toBeNull();
    } else if (mode === 'session') {
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(input.value).toBe('synthetic-next');
      expect(screen.queryByRole('status')).toBeNull();
    }
  });
});

it('首次加载微任务前换代，不请求旧模型设置', async () => {
  owner.apiFetch.mockImplementation(async () => json(settings));
  render(<ModelSettingsTab />);
  owner.current = 2;
  await act(async () => {});
  expect(owner.apiFetch).not.toHaveBeenCalled();
});

it('保存失败保留草稿并允许重试', async () => {
  let patches = 0;
  owner.apiFetch.mockImplementation(async (_input, init?: RequestInit) => init?.method !== 'PATCH' ? json(settings)
    : ++patches === 1 ? json({ error: '合成保存失败' }, 503) : json({ ...settings, model: 'synthetic-next' }));
  render(<ModelSettingsTab />);
  const input = await draft('新模型名');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText(/合成保存失败/);
  expect(input.value).toBe('synthetic-next');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(input.value).toBe(''));
  expect(patches).toBe(2);
});
