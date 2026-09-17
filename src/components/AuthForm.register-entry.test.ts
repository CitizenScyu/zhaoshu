import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 直接在 node 环境驱动组件（没有 jsdom）：useState 用「跨渲染持久化」的槽位模拟，
// useEffect 只记录回调、由测试显式触发，这样注册三态查询的异步收敛可以被断言。
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
}));
const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown>, fetch: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'test',
    useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
    useState: (initial: unknown) => {
      const slot = hooks.index++;
      if (!(slot in hooks.states)) hooks.states[slot] = initial;
      return [
        hooks.states[slot],
        (next: unknown) => {
          hooks.states[slot] = typeof next === 'function'
            ? (next as (previous: unknown) => unknown)(hooks.states[slot])
            : next;
        },
      ];
    },
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import AuthForm from './AuthForm';

function ownerState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'anonymous',
    accountsEnabled: true,
    expired: false,
    sessionOnly: false,
    setSessionOnly: vi.fn(),
    login: vi.fn(),
    submitToken: vi.fn(),
    ...overrides,
  };
}

type Element = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') { out.push(node); return out; }
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  return texts((node as Element).props?.children, out);
}

function hrefs(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) hrefs(child, out); return out; }
  const element = node as Element;
  if (element.type === 'a' && typeof element.props?.href === 'string') out.push(element.props.href);
  return hrefs(element.props?.children, out);
}

/** 重渲染并取回本次注册的 effect；旧 effect 丢弃，避免重复触发。 */
function render(): { text: string; hrefs: string[]; effect: (() => void | (() => void)) | null } {
  hooks.effects = [];
  hooks.index = 0;
  const tree = AuthForm({ returnTo: null });
  return { text: texts(tree).join(''), hrefs: hrefs(tree), effect: hooks.effects[0] ?? null };
}

/** 触发 effect 并等它跑完（queueMicrotask → fetch → setState）。 */
async function settle(effect: (() => void | (() => void)) | null) {
  effect?.();
  await vi.waitFor(() => { expect(mocks.fetch).toHaveBeenCalled(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.states = [];
  hooks.effects = [];
  mocks.owner = ownerState();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ registrationMode: 'invite' }) });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('注册入口的运行时三态', () => {
  it('邀请码注册时给出带邀请码字样的注册链接', async () => {
    const first = render();
    expect(first.text).toContain('注册新账号');
    await settle(first.effect);

    const second = render();
    expect(second.text).toContain('注册新账号（需邀请码）');
    expect(second.hrefs).toContain('/register');
  });

  it('三态查询失败时入口保持显示，绝不把「未知」当关闭', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    const first = render();
    await settle(first.effect);

    const second = render();
    expect(second.text).toContain('注册新账号');
    expect(second.hrefs).toContain('/register');
  });

  it('服务端明确关闭注册时只给说明、不给链接', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ registrationMode: 'closed' }) });
    const first = render();
    await settle(first.effect);

    const second = render();
    expect(second.text).toContain('本站当前未开放注册。');
    expect(second.text).not.toContain('注册新账号');
    expect(second.hrefs).not.toContain('/register');
  });

  it('账号模式总闸没开时根本不问注册三态', async () => {
    mocks.owner = ownerState({ accountsEnabled: false });
    const first = render();
    first.effect?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(first.text).not.toContain('注册');
  });
});
