import { beforeEach, describe, expect, it, vi } from 'vitest';

// 直接在 node 环境驱动组件：只替换需要可控的 hook，保留真实 createElement。
// useState 的初值决定返回值（'' 变成草稿文本、false 保持 false、null 保持 null），
// 这样既能进入提交分支，又不需要 DOM。
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'test',
    // 组件在这里当普通函数调，没有渲染器；注册三态查询的 effect 不该在测试里发请求。
    useEffect: () => {},
    useState: (initial: unknown) => {
      const value = initial === '' ? 'draft' : initial;
      return [value, vi.fn()];
    },
  };
});

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  owner: {} as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import AuthForm from './AuthForm';

function findElement(node: unknown, type: string): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (element.type === type) return element as { props: Record<string, unknown> };
  return findElement(element.props?.children, type);
}

function submit(formProps: Record<string, unknown>): Promise<void> {
  const onSubmit = formProps.onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
  return onSubmit({ preventDefault: () => {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner = {
    status: 'anonymous',
    accountsEnabled: true,
    expired: false,
    sessionOnly: false,
    setSessionOnly: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    submitToken: vi.fn().mockResolvedValue(undefined),
  };
});

describe('登录成功后的跳转互斥（深链 vs 回退）', () => {
  it('jumps only to the deep link and never calls the fallback, via the account login path', async () => {
    const onSuccess = vi.fn();
    const element = AuthForm({ returnTo: '/read/12', onSuccess }) as unknown;
    const form = findElement(element, 'form');
    expect(form).not.toBeNull();

    await submit(form!.props);

    // 深链场景也必须真的做了账号登录——把 member 分支改成走口令兑换仍会 replace，
    // 只有钉住 login/submitToken 的取舍才能抓到「跳转对但凭据用错」的回归。
    expect(mocks.owner.login).toHaveBeenCalledTimes(1);
    expect(mocks.owner.login).toHaveBeenCalledWith('draft', 'draft', false);
    expect(mocks.owner.submitToken).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/read/12');
    // 修复前 finish() 会同时调用 onSuccess，导致独立登录页的 router.replace('/')
    // 覆盖深链；这里必须为 0。
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('uses the owner token path when accounts mode is off, still without the fallback', async () => {
    mocks.owner.accountsEnabled = false;
    const onSuccess = vi.fn();
    const element = AuthForm({ returnTo: '/read/12', onSuccess }) as unknown;
    const form = findElement(element, 'form');

    await submit(form!.props);

    expect(mocks.owner.submitToken).toHaveBeenCalledTimes(1);
    expect(mocks.owner.submitToken).toHaveBeenCalledWith('draft');
    expect(mocks.owner.login).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/read/12');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('falls back to the caller callback when there is no deep link', async () => {
    const onSuccess = vi.fn();
    const element = AuthForm({ returnTo: null, onSuccess }) as unknown;
    const form = findElement(element, 'form');

    await submit(form!.props);

    expect(mocks.owner.login).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('ignores a tampered return path and uses the fallback', async () => {
    const onSuccess = vi.fn();
    const element = AuthForm({ returnTo: '//evil.com', onSuccess }) as unknown;
    const form = findElement(element, 'form');

    await submit(form!.props);

    expect(mocks.replace).not.toHaveBeenCalledWith('//evil.com');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft fields out of the wire when login itself rejects', async () => {
    mocks.owner.login = vi.fn().mockRejectedValue(new Error('凭据无效'));
    const element = AuthForm({ returnTo: '/read/12', onSuccess: vi.fn() }) as unknown;
    const form = findElement(element, 'form');

    await submit(form!.props);

    // 登录失败绝不跳转：replace 未发生说明 finish() 只在 try 成功后运行。
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.owner.submitToken).not.toHaveBeenCalled();
  });
});

