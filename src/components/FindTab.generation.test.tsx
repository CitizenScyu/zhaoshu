// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const state = { apiFetch: vi.fn(), generation: 1, isCurrentSession: (id: number): boolean => id === state.generation };
  return state;
});
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, sessionId: mocks.generation, isCurrentSession: mocks.isCurrentSession,
  user: { id: 7 }, ready: true, can: () => true,
}) }));
import FindTab from './FindTab';

const frame = (data: Record<string, unknown>) => new TextEncoder().encode('data: ' + JSON.stringify(data) + '\n\n');
const result = (step: string) => ({ type: 'result', ...(step === 'recall'
  ? { candidates: [{ title: '合成书', author: '合成作者' }] }
  : step === 'verify' ? { verified: [], ticket: 'synthetic-ticket' } : { items: [], persisted: true }) });
function response(data: Record<string, unknown>) {
  return new Response(frame(data), { headers: { 'Content-Type': 'text/event-stream' } });
}
const steps = () => mocks.apiFetch.mock.calls.map((call) => JSON.parse(call[1].body).step);
beforeEach(() => { vi.resetAllMocks(); mocks.generation = 1; });
afterEach(cleanup);

function setup(heldStep?: string, failVerify = false) {
  let release: (() => void) | undefined;
  let failed = false;
  mocks.apiFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const step = JSON.parse(String(init.body)).step;
    if (step === heldStep) return new Response(new ReadableStream({
      start(controller) { release = () => controller.enqueue(frame(result(step))); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (failVerify && step === 'verify' && !failed) {
      failed = true;
      return response({ type: 'error', code: 'SYNTHETIC_FAILURE', message: '合成验证失败' });
    }
    return response(result(step));
  });
  render(<FindTab />);
  fireEvent.change(screen.getByRole('textbox', { name: '找书需求' }), { target: { value: '合成查询' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '仅本次有效' }));
  return { release: () => { if (!release) throw new Error('目标步骤尚未开始'); release(); } };
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: '找 书' }));

describe('找书多步骤请求的真实会话代际', () => {
  it.each(['recall', 'verify'])('%s结果迟到时已切代际，不续发后续POST', async (heldStep) => {
    const task = setup(heldStep); submit();
    const expected = heldStep === 'recall' ? ['recall'] : ['recall', 'verify'];
    await waitFor(() => expect(steps()).toEqual(expected));
    mocks.generation += 1;
    await act(async () => { task.release(); });
    expect(steps()).toEqual(expected);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('旧按钮在新代际不能启动请求', async () => {
    setup(); mocks.generation += 1; submit();
    await act(async () => {});
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('run已开始但doFetch微任务尚未运行时切代际，真正发送点再次拒绝', async () => {
    setup(); submit();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    mocks.generation += 1;
    await act(async () => {});
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('同会话切找书模式保留进行中的三步结果', async () => {
    const task = setup('recall'); submit();
    await waitFor(() => expect(steps()).toEqual(['recall']));
    fireEvent.click(screen.getByRole('tab', { name: '精确找书' }));
    await act(async () => { task.release(); });
    await waitFor(() => expect(steps()).toEqual(['recall', 'verify', 'rerank']));
    fireEvent.click(screen.getByRole('tab', { name: '口味推荐' }));
    expect((screen.getByRole('textbox', { name: '找书需求' }) as HTMLTextAreaElement).value).toBe('合成查询');
    expect((screen.getByRole('button', { name: '找 书' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([false, true])('验证失败后重试不重复召回，代际失效=%s时不再提交', async (expire) => {
    setup(undefined, true); submit();
    const retry = await screen.findByRole('button', { name: /重试/ });
    expect(steps()).toEqual(['recall', 'verify']);
    if (expire) mocks.generation += 1;
    fireEvent.click(retry);
    await act(async () => {});
    expect(steps()).toEqual(expire ? ['recall', 'verify'] : ['recall', 'verify', 'verify', 'rerank']);
  });
});
