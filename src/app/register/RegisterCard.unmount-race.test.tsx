// @vitest-environment jsdom
// 注册提交的离页守卫（register-lifecycle53）：真实组件 + jsdom + Testing Library，
// 三个等待窗口（POST 响应头 / 读正文 / 认证刷新）期间卸载，旧提交不得再触发
// refresh 或 router.replace。请求、账号输入与导航全部合成，不访问上游。
// safeReturnPath 以直通替身固定：与 53 独立脚本同口径，本文件不声称验证
// returnTo 安全策略。卸载中止也不宣称服务端账号创建已回滚。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RegisterCard from './RegisterCard';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', () => ({
  useOwner: () => ({ accountsEnabled: true, user: null, refresh: mocks.refresh }),
}));
vi.mock('@/lib/auth-client', () => ({ safeReturnPath: (value: string | null) => value }));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** 合成 fetch：三态查询恒 open；注册 POST 的行为由用例注入。 */
function stubFetch(registerPost?: () => Promise<Response>) {
  mocks.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/registration' && !init?.method) return Response.json({ registrationMode: 'open' });
    if (url === '/api/auth/register' && init?.method === 'POST') {
      if (!registerPost) throw new Error('本用例未合成注册 POST');
      return registerPost();
    }
    throw new Error(`未预期的请求：${url}`);
  });
}

/** 渲染到开放注册的可提交形态并键入合成凭据，返回卸载句柄与表单。 */
async function openRegisterForm(returnTo: string | null) {
  const view = render(<RegisterCard returnTo={returnTo} />);
  const form = await screen.findByRole('form', { name: '注册' });
  await waitFor(() => {
    const password = form.querySelector('input[name="new-password"]') as HTMLInputElement | null;
    if (!password || password.disabled) throw new Error('表单尚未开放');
  });
  for (const [name, value] of [['username', 'synthetic_reader'], ['new-password', 'synthetic-password-123'], ['confirm-password', 'synthetic-password-123']]) {
    fireEvent.change(form.querySelector(`input[name="${name}"]`)!, { target: { value } });
  }
  return { view, form };
}

function registerPostCalls() {
  return mocks.fetch.mock.calls.filter(([input, init]) => String(input) === '/api/auth/register' && init?.method === 'POST');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('注册提交的离页守卫', () => {
  it('POST 等待期间卸载：迟到成功不再刷新身份、不再跳转，且在途请求被中止', async () => {
    const late = deferred<Response>();
    stubFetch(() => late.promise);
    const { view, form } = await openRegisterForm(null);
    fireEvent.submit(form);
    await waitFor(() => expect(registerPostCalls()).toHaveLength(1));

    view.unmount();
    await act(async () => {
      late.resolve(Response.json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((registerPostCalls()[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('读正文期间卸载：迟到 JSON 不再刷新身份、不再跳转', async () => {
    let bodyStarted = 0;
    const body = deferred<{ ok: boolean }>();
    stubFetch(() => Promise.resolve({ ok: true, json: () => { bodyStarted += 1; return body.promise; } } as unknown as Response));
    const { view, form } = await openRegisterForm(null);
    fireEvent.submit(form);
    await waitFor(() => expect(bodyStarted).toBe(1));

    view.unmount();
    await act(async () => {
      body.resolve({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('认证刷新期间卸载：迟到完成不再触发跳转', async () => {
    stubFetch(() => Promise.resolve(Response.json({ ok: true })));
    const gate = deferred<void>();
    mocks.refresh.mockImplementation(() => gate.promise);
    const { view, form } = await openRegisterForm(null);
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      gate.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('不离页的成功提交仍刷新身份并跳转安全深链（行为保留）', async () => {
    stubFetch(() => Promise.resolve(Response.json({ ok: true })));
    const { form } = await openRegisterForm('/read/3');
    fireEvent.submit(form);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/read/3');
  });

  it('不离页的失败提交保留用户名、清空密码且不跳转（行为保留）', async () => {
    stubFetch(() => Promise.resolve(Response.json({ code: 'USERNAME_TAKEN', error: '用户名已被使用' }, { status: 409 })));
    const { form } = await openRegisterForm(null);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('用户名已被使用'));

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect((form.querySelector('input[name="username"]') as HTMLInputElement).value).toBe('synthetic_reader');
    expect((form.querySelector('input[name="new-password"]') as HTMLInputElement).value).toBe('');
  });
});
