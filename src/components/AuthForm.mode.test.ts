import { beforeEach, describe, expect, it, vi } from 'vitest';

// 模拟真实 useState 的「跨渲染持久化」：同一个 hook 槽位在多次渲染间保持上次的值。
// 只有一个渲染函数在首帧锁死 mode 时，第二次渲染才会暴露差异。
const hooks = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
const mocks = vi.hoisted(() => ({ replace: vi.fn(), owner: {} as Record<string, unknown> }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'test',
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

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import AuthForm from './AuthForm';

function ownerState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'anonymous',
    accountsEnabled: true,
    expired: false,
    sessionOnly: false,
    setSessionOnly: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    submitToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function render(): unknown {
  hooks.index = 0;
  return AuthForm({ returnTo: null });
}

type Element = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function walk(node: unknown, visit: (element: Element) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const element = node as Element;
  visit(element);
  walk(element.props?.children, visit);
}

function inputNames(tree: unknown): string[] {
  const names: string[] = [];
  walk(tree, (element) => {
    if (element.type === 'input' && typeof element.props?.name === 'string') names.push(element.props.name);
  });
  return names;
}

function toggleButton(tree: unknown): Element | null {
  let found: Element | null = null;
  walk(tree, (element) => {
    if (!found && element.type === 'button' && element.props?.type === 'button') found = element;
  });
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.states = [];
  mocks.owner = ownerState();
});

describe('登录入口按部署开关推导（不锁死首帧）', () => {
  it('re-derives the entry when the deployment switch resolves after the first frame', () => {
    mocks.owner = ownerState({ accountsEnabled: false });
    render(); // 首帧：部署开关还没解析出来
    mocks.owner = ownerState({ accountsEnabled: true });
    const second = render();

    // 修复前 mode 由首帧 useState 初值锁死为 'owner'，这次渲染仍是口令入口。
    expect(inputNames(second)).toContain('username');
    expect(inputNames(second)).not.toContain('owner-token');
  });

  it('shows the legacy owner entry while the switch stays off', () => {
    mocks.owner = ownerState({ accountsEnabled: false });
    const tree = render();
    expect(inputNames(tree)).toContain('owner-token');
    expect(inputNames(tree)).not.toContain('username');
  });

  it('lets an explicit user choice override the derived entry', () => {
    mocks.owner = ownerState({ accountsEnabled: true });
    const first = render();
    const toggle = toggleButton(first);
    expect(toggle).not.toBeNull();
    (toggle!.props?.onClick as () => void)(); // 用户显式切到口令入口

    const second = render();
    expect(inputNames(second)).toContain('owner-token');
    expect(inputNames(second)).not.toContain('username');
  });
});
