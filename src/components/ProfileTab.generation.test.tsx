// @vitest-environment jsdom
import { useReducer } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileDraft, profileDraftReducer } from '@/lib/profile-draft';

const mocks = vi.hoisted(() => {
  const state = { apiFetch: vi.fn(), generation: 1, isCurrentSession: (id: number): boolean => id === state.generation };
  return state;
});
vi.mock('./OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: mocks.apiFetch, sessionId: mocks.generation, isCurrentSession: mocks.isCurrentSession,
}) }));
import ProfileTab from './ProfileTab';

function Harness({ active = true }: { active?: boolean }) {
  const [state, dispatch] = useReducer(profileDraftReducer, undefined, createProfileDraft);
  return <ProfileTab state={state} dispatch={dispatch} active={active} />;
}
const initial = { seeds: [{ title: '合成种子', kind: 'love', reason: '合成偏好' }],
  content: '合成旧画像', updatedAt: '2026-09-29T00:00:00.000Z' };
const generated = { ...initial, content: '合成生成结果', updatedAt: '2026-09-29T00:01:00.000Z' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
beforeEach(() => { vi.resetAllMocks(); mocks.generation = 1; });
afterEach(cleanup);

async function setup(holdCancel = false) {
  const saved = deferred<typeof initial>();
  const cancelled = deferred<void>();
  const saveJson = vi.fn(() => saved.promise);
  const cancel = vi.fn(() => holdCancel ? cancelled.promise : undefined);
  let server = initial;
  mocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return { ok: true, status: 200, json: saveJson };
    if (init?.method === 'POST') {
      server = generated;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'done', ...generated }) + '\n\n')); },
        cancel,
      }));
    }
    return Response.json(server);
  });
  const view = render(<Harness />);
  await screen.findByText(initial.seeds[0].title);
  const button = screen.getByRole('button', { name: '生成画像' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return { saved, cancelled, saveJson, cancel, view, button };
}
const writes = (method: string) => mocks.apiFetch.mock.calls.filter((call) => call[1]?.method === method);

describe('画像生成的会话代际', () => {
  it('保存种子读体后身份已变、尚未重挂，不继续发POST生成', async () => {
    const task = await setup(); fireEvent.click(task.button);
    await waitFor(() => expect(task.saveJson).toHaveBeenCalledOnce());
    mocks.generation += 1;
    await act(async () => { task.saved.resolve(initial); });
    expect(writes('PUT')).toHaveLength(1);
    expect(writes('POST')).toHaveLength(0);
  });

  it('旧页面按钮不能在新代际启动PUT保存', async () => {
    const task = await setup();
    mocks.generation += 1; fireEvent.click(task.button);
    await act(async () => {});
    expect(writes('PUT')).toHaveLength(0);
    expect(writes('POST')).toHaveLength(0);
  });

  it('SSE结束后的reader.cancel等待期间换身份，不再写回成功结果', async () => {
    const task = await setup(true); fireEvent.click(task.button);
    await act(async () => { task.saved.resolve(initial); });
    await waitFor(() => expect(task.cancel).toHaveBeenCalledOnce());
    mocks.generation += 1;
    await act(async () => { task.cancelled.resolve(); });
    expect(screen.queryByText('✓ 画像已生成')).toBeNull();
    expect(screen.queryByText(generated.content)).toBeNull();
    expect(screen.getByText(initial.content)).toBeTruthy();
  });

  it('同一会话切换标签页仍完成生成，回到页面保留结果', async () => {
    const task = await setup(); fireEvent.click(task.button);
    await waitFor(() => expect(task.saveJson).toHaveBeenCalledOnce());
    task.view.rerender(<Harness active={false} />);
    await act(async () => { task.saved.resolve(initial); });
    await screen.findByText('✓ 画像已生成');
    expect(writes('PUT')).toHaveLength(1);
    expect(writes('POST')).toHaveLength(1);
    task.view.rerender(<Harness />);
    await screen.findByText(generated.content);
  });
});
