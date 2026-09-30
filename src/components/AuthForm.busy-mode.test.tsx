// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthForm from './AuthForm';

const mocks = vi.hoisted(() => ({ login: vi.fn(), owner: vi.fn(), replace: vi.fn(), fetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => ({
  status: 'anonymous', accountsEnabled: true, expired: false, sessionOnly: false,
  login: mocks.login, submitToken: mocks.owner, setSessionOnly: vi.fn(),
}) }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockImplementation((url: unknown) => url === '/api/auth/registration'
    ? Promise.resolve({ json: async () => ({ registrationMode: 'closed' }) })
    : Promise.reject(new Error('SYNTHETIC unexpected fetch blocked')));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['member', 'owner'] as const)('keeps %s failure in its submitting mode, then permits switching', async mode => {
  const pending = deferred();
  const action = mode === 'member' ? mocks.login : mocks.owner;
  action.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  const view = render(<AuthForm defaultMode={mode} />);
  const ownLabel = mode === 'member' ? '用户名' : '访问口令';
  const otherLabel = mode === 'member' ? '访问口令' : '用户名';
  const toggleName = mode === 'member' ? '管理员口令登录' : '返回账号登录';
  const failure = mode === 'member' ? 'SYNTHETIC 账号失败' : 'SYNTHETIC 口令失败';
  try {
    await user.type(screen.getByLabelText(ownLabel), mode === 'member' ? 'synthetic_user' : 'SYNTHETIC_OWNER_ONLY');
    if (mode === 'member') await user.type(screen.getByLabelText('密码'), 'SYNTHETIC_PASSWORD_ONLY');
    await user.click(screen.getByRole('button', { name: mode === 'member' ? '登 录' : '提交口令' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const toggle = screen.getByRole('button', { name: toggleName }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    await user.click(toggle);
    expect(screen.queryByLabelText(otherLabel)).toBeNull();
    expect((screen.getByLabelText(ownLabel) as HTMLInputElement).disabled).toBe(true);
    await act(async () => { pending.reject(new Error(failure)); await pending.promise.catch(() => {}); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(failure));
    expect(screen.queryByLabelText(otherLabel)).toBeNull();
    expect((screen.getByLabelText(ownLabel) as HTMLInputElement).disabled).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(mocks.replace).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(screen.getByLabelText(otherLabel)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
    expect(mode === 'member' ? mocks.owner : mocks.login).not.toHaveBeenCalled();
  } finally {
    await act(async () => { pending.resolve(); await pending.promise.catch(() => {}); });
    view.unmount();
  }
});

it('preserves member success deep-link navigation while the pending mode is locked', async () => {
  const pending = deferred();
  mocks.login.mockReturnValue(pending.promise);
  const onSuccess = vi.fn();
  const user = userEvent.setup();
  const view = render(<AuthForm returnTo="/read/12" onSuccess={onSuccess} />);
  try {
    await user.type(screen.getByLabelText('用户名'), 'synthetic_user');
    await user.type(screen.getByLabelText('密码'), 'SYNTHETIC_PASSWORD_ONLY');
    await user.click(screen.getByRole('button', { name: '登 录' }));
    await waitFor(() => expect(mocks.login).toHaveBeenCalledTimes(1));
    const toggle = screen.getByRole('button', { name: '管理员口令登录' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    await user.click(toggle);
    expect(screen.queryByLabelText('访问口令')).toBeNull();
    await act(async () => { pending.resolve(); await pending.promise; });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/read/12'));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(toggle.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
  } finally {
    await act(async () => { pending.resolve(); await pending.promise.catch(() => {}); });
    view.unmount();
  }
});
