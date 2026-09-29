// @vitest-environment jsdom
// 真实组件 + 合成 apiFetch。会话已变但组件尚未重挂时，旧操作不能以新身份续发。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShuyuanTab from './ShuyuanTab';

const owner = vi.hoisted(() => ({ current: 1, apiFetch: vi.fn(), isCurrentSession: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({
  apiFetch: owner.apiFetch, sessionId: 1, isCurrentSession: owner.isCurrentSession,
}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown) { return new Response(JSON.stringify(value)); }
function stats(name = '合成源', disabled = false) {
  return { total: 1, enabled: disabled ? 0 : 1, disabled: disabled ? 1 : 0, reachable: 1,
    active: 1, unprobed: 0, pending: 0, failed: 0, page: 1, pageSize: 20, totalPages: 1,
    filter: 'all', collections: [], sourcesLimit: 20, refreshedAt: null,
    sources: [{ url: 'https://synthetic.example', name, disabled, availability: 'reachable',
      lastError: '', checkedAt: null, probeError: null }] };
}
const actions = [
  { action: 'refresh', button: '刷新合集', disabled: false },
  { action: 'disable', button: '禁用', disabled: false },
  { action: 'enable', button: '重新启用', disabled: true },
];
beforeEach(() => {
  owner.current = 1;
  owner.apiFetch.mockReset();
  owner.isCurrentSession.mockImplementation((expected: number) => expected === owner.current);
});
afterEach(cleanup);

describe.each(actions)('$action 会话边界', ({ action, button, disabled }) => {
  it('旧视图入口不在新身份下发出 POST', async () => {
    owner.apiFetch.mockImplementation(async () => json(stats('合成源', disabled)));
    render(<ShuyuanTab />);
    await screen.findByText('合成源');
    owner.current = 2;
    fireEvent.click(screen.getByRole('button', { name: button }));
    await act(async () => {});
    expect(owner.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it.each(['session', 'unmount', 'normal'])('POST 正文迟到：%s', async (mode) => {
    const body = deferred<unknown>();
    let postSignal: AbortSignal | undefined;
    let bodyStarted = false;
    let listCalls = 0;
    owner.apiFetch.mockImplementation(async (_input, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postSignal = init.signal as AbortSignal;
        expect(JSON.parse(String(init.body)).action).toBe(action);
        const response = json({});
        response.json = () => { bodyStarted = true; return body.promise; };
        return response;
      }
      return json(stats(++listCalls === 1 ? '合成源' : '重载后的合成源', disabled));
    });
    const ui = render(<ShuyuanTab />);
    await screen.findByText('合成源');
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(bodyStarted).toBe(true));
    if (mode === 'session') owner.current = 2;
    if (mode === 'unmount') {
      ui.unmount();
      expect(postSignal?.aborted).toBe(true);
    }
    await act(async () => { body.resolve({ ok: true, disabled: true, enabled: true }); });
    expect(listCalls).toBe(mode === 'normal' ? 2 : 1);
    if (mode === 'normal') {
      expect(screen.getByText('重载后的合成源')).toBeTruthy();
      expect((screen.getByRole('button', { name: button }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('同会话切筛选后，旧操作收尾仍解除按钮忙碌且不重载旧筛选', async () => {
    const body = deferred<unknown>();
    let bodyStarted = false;
    let listCalls = 0;
    owner.apiFetch.mockImplementation(async (_input, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const response = json({});
        response.json = () => { bodyStarted = true; return body.promise; };
        return response;
      }
      listCalls += 1;
      return json(stats('合成源', disabled));
    });
    render(<ShuyuanTab />);
    await screen.findByText('合成源');
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(bodyStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^最近探测可达/ }));
    await waitFor(() => expect(listCalls).toBe(2));
    await act(async () => { body.resolve({ ok: true, disabled: true, enabled: true }); });
    expect(listCalls).toBe(2);
    expect((screen.getByRole('button', { name: button }) as HTMLButtonElement).disabled).toBe(false);
  });
});

it.each([true, false])('会话失效后列表正文迟到，success=%s 不覆盖旧页面或提示', async (success) => {
  const body = deferred<unknown>();
  let listCalls = 0;
  let bodyStarted = false;
  owner.apiFetch.mockImplementation(async () => {
    if (++listCalls === 1) return json(stats());
    const response = new Response('{}', { status: success ? 200 : 500 });
    response.json = () => { bodyStarted = true; return body.promise; };
    return response;
  });
  render(<ShuyuanTab />);
  await screen.findByText('合成源');
  fireEvent.click(screen.getByRole('button', { name: /^最近探测可达/ }));
  await waitFor(() => expect(bodyStarted).toBe(true));
  owner.current = 2;
  await act(async () => { body.resolve(success ? stats('迟到的源') : { error: '迟到的错误' }); });
  expect(screen.queryByText('迟到的源')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('列表微任务尚未执行时会话失效，不发首次 GET', async () => {
  owner.apiFetch.mockImplementation(async () => json(stats()));
  render(<ShuyuanTab />);
  owner.current = 2;
  await act(async () => {});
  expect(owner.apiFetch).not.toHaveBeenCalled();
});
