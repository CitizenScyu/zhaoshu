// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { apiFetch: vi.fn(), generation: 1, isCurrentSession: (id: number): boolean => id === state.generation };
  return state;
});
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, sessionId: mocks.generation,
  isCurrentSession: mocks.isCurrentSession,
}) }));
import FeedbackForm from './FeedbackForm';

beforeEach(() => { vi.resetAllMocks(); mocks.generation = 1; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  let resolve!: (value: unknown) => void;
  const body = new Promise((settle) => { resolve = settle; });
  const json = vi.fn(() => body);
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/feedback') return { ok: true, status: 200, json };
    if (url === '/api/profile/absorb') return Response.json({ ok: true });
    throw new Error('未知合成请求');
  });
  const onSaved = vi.fn();
  const view = render(<FeedbackForm title="合成书" author="合成作者" status="want"
    initialSnapshot={{ version: 3, note: '', status: 'want' }}
    onSaved={onSaved} onCancel={vi.fn()} onBusyChange={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '补充说明（选填）' }), { target: { value: '合成反馈' } });
  return { view, onSaved, resolve, json };
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: '记下反馈' }));
const absorbCalls = () => mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/profile/absorb');

describe('反馈保存的真实会话代际', () => {
  it('读体期间代际变化、组件尚未重挂，不回调旧父组件也不触发新用户画像吸收', async () => {
    const task = setup(); submit();
    await waitFor(() => expect(task.json).toHaveBeenCalledOnce());
    mocks.generation += 1;
    await act(async () => { task.resolve({ ok: true, pending: true, profileStatus: 'pending' }); });
    expect(task.onSaved).not.toHaveBeenCalled();
    expect(absorbCalls()).toHaveLength(0);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('代际失效后的旧按钮不能启动保存', async () => {
    const task = setup();
    mocks.generation += 1; submit();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(task.onSaved).not.toHaveBeenCalled();
  });

  it('父回调同步切换身份后，不继续触发画像吸收', async () => {
    const task = setup();
    task.onSaved.mockImplementation(() => { mocks.generation += 1; });
    submit(); await waitFor(() => expect(task.json).toHaveBeenCalledOnce());
    await act(async () => { task.resolve({ ok: true, pending: true }); });
    expect(task.onSaved).toHaveBeenCalledOnce();
    expect(absorbCalls()).toHaveLength(0);
  });

  it.each([true, false])('正常同代际保存准确透传状态，pending=%s时只触发必要的吸收', async (pending) => {
    const task = setup(); submit();
    await waitFor(() => expect(task.json).toHaveBeenCalledOnce());
    const profileStatus = pending ? 'pending' : 'unchanged';
    await act(async () => { task.resolve({ ok: true, pending, profileStatus }); });
    expect(task.onSaved).toHaveBeenCalledOnce();
    expect(task.onSaved).toHaveBeenCalledWith('合成反馈', profileStatus);
    expect(absorbCalls()).toHaveLength(pending ? 1 : 0);
  });

  it('同代际卸载后的迟到成功也不回调或吸收', async () => {
    const task = setup(); submit();
    await waitFor(() => expect(task.json).toHaveBeenCalledOnce());
    const signal = mocks.apiFetch.mock.calls[0][1].signal;
    task.view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { task.resolve({ ok: true, pending: true }); });
    expect(task.onSaved).not.toHaveBeenCalled();
    expect(absorbCalls()).toHaveLength(0);
  });

  it('409保留草稿，对比线上版本后可以再次保存', async () => {
    const task = setup();
    mocks.apiFetch.mockResolvedValueOnce(Response.json({
      current: { version: 4, note: '合成线上反馈', status: 'want' },
    }, { status: 409 }));
    submit(); await screen.findByText('线上最新反馈');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('合成反馈');
    expect(task.onSaved).not.toHaveBeenCalled();
    expect(absorbCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '已对比，保留草稿继续编辑' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    submit(); await waitFor(() => expect(task.json).toHaveBeenCalledOnce());
    await act(async () => { task.resolve({ ok: true, pending: false, profileStatus: 'unchanged' }); });
    expect(task.onSaved).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.apiFetch.mock.calls[1][1].body).expectedFeedbackId).toBe(4);
  });
});
