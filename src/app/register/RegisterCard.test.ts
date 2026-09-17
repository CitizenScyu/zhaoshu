import { beforeEach, describe, expect, it, vi } from 'vitest';

// RegisterCard 的三态由 effect 里的 /api/auth/registration 决定，renderToStaticMarkup
// 只能看见 mode=null 的首帧关闭外观（那正是 AuthForm.test.ts 已覆盖的分支）。这里按
// AuthForm.register-entry.test.ts 的先例直接在 node 环境驱动组件：useState 用
// 「跨渲染持久化」槽位、useEffect 记录后由测试显式触发，三态收敛与提交契约才测得到。
// 输入一律走真实 onChange（等价于用户键入），改槽位绕不过组件闭包。
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
}));
const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  owner: {} as Record<string, unknown>,
  fetch: vi.fn(),
}));

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

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import RegisterCard from './RegisterCard';

function ownerState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountsEnabled: true,
    user: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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

function inputNames(tree: unknown, onlyEnabled = false): string[] {
  const names: string[] = [];
  walk(tree, (element) => {
    if (element.type === 'input' && typeof element.props?.name === 'string') {
      if (!onlyEnabled || element.props.disabled !== true) names.push(element.props.name);
    }
  });
  return names;
}

function findInput(tree: unknown, name: string): Element | null {
  let found: Element | null = null;
  walk(tree, (element) => {
    if (!found && element.type === 'input' && element.props?.name === name) found = element;
  });
  return found;
}

function submitButton(tree: unknown): Element | null {
  let found: Element | null = null;
  walk(tree, (element) => {
    if (!found && element.type === 'button' && element.props?.type === 'submit') found = element;
  });
  return found;
}

function findForm(tree: unknown): Element | null {
  let found: Element | null = null;
  walk(tree, (element) => {
    if (!found && element.type === 'form') found = element;
  });
  return found;
}

function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') { out.push(node); return out; }
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  return texts((node as Element).props?.children, out);
}

/** 渲染一次（不触发 effect）。 */
function render(returnTo: string | null = null): unknown {
  hooks.effects = [];
  hooks.index = 0;
  return RegisterCard({ returnTo }) as unknown;
}

/** 渲染并触发三态 effect（queueMicrotask → fetch → setMode），等微任务排空后重渲染。 */
async function renderAfterMode(returnTo: string | null = null): Promise<unknown> {
  render(returnTo);
  const effect = hooks.effects[0] ?? null;
  effect?.();
  await vi.waitFor(() => { expect(mocks.fetch).toHaveBeenCalled(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return render(returnTo);
}

/** 像用户一样把值键入指定输入框（走真实 onChange）。 */
function type(tree: unknown, name: string, value: string): void {
  const input = findInput(tree, name);
  expect(input, `input[name=${name}] must exist`).not.toBeNull();
  (input!.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

/** 提交当前树上的表单。组件的 onSubmit 是 `(event) => void submit(event)` 同步壳，
 * 真实提交在 promise 链里——排空微任务（fetch→json→refresh→replace）再返回。 */
async function submit(tree: unknown): Promise<void> {
  const target = findForm(tree);
  expect(target).not.toBeNull();
  (target!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 读出错误行文案（role="alert" 的段落）。 */
function alertText(tree: unknown): string {
  let found = '';
  walk(tree, (element) => {
    if (element.type === 'p' && element.props?.role === 'alert') {
      found = texts(element).join('');
    }
  });
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.states = [];
  hooks.effects = [];
  mocks.owner = ownerState();
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('注册卡的三态收敛', () => {
  it('open 注册启用密码框与提交入口', async () => {
    mocks.fetch.mockResolvedValue({ json: async () => ({ registrationMode: 'open' }) });
    const tree = await renderAfterMode('/read/3');

    expect(inputNames(tree)).toContain('new-password');
    expect(inputNames(tree, true)).toContain('new-password');
    expect(inputNames(tree, true)).toContain('confirm-password');
    expect(submitButton(tree)!.props?.disabled).not.toBe(true);
  });

  it('invite 注册出示邀请码输入框', async () => {
    mocks.fetch.mockResolvedValue({ json: async () => ({ registrationMode: 'invite' }) });
    const tree = await renderAfterMode();

    expect(inputNames(tree)).toContain('invite-code');
    expect(inputNames(tree, true)).toContain('invite-code');
  });

  it('服务端明确关闭时保持关闭外观，密码框不可输入', async () => {
    mocks.fetch.mockResolvedValue({ json: async () => ({ registrationMode: 'closed' }) });
    const tree = await renderAfterMode();

    expect(inputNames(tree, true)).not.toContain('new-password');
    expect(inputNames(tree, true)).not.toContain('confirm-password');
    expect(inputNames(tree)).not.toContain('invite-code');
    expect(submitButton(tree)!.props?.disabled).toBe(true);
    expect(texts(tree).join('')).toContain('注册当前未开放');
  });

  it('三态查询失败按关闭处理，绝不放开提交', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    const tree = await renderAfterMode();

    expect(submitButton(tree)!.props?.disabled).toBe(true);
    expect(inputNames(tree, true)).not.toContain('new-password');
  });

  it('不认识的三态值（如未知字符串）按关闭处理', async () => {
    mocks.fetch.mockResolvedValue({ json: async () => ({ registrationMode: 'weird' }) });
    const tree = await renderAfterMode();

    expect(submitButton(tree)!.props?.disabled).toBe(true);
  });
});

describe('注册提交契约', () => {
  it('open 模式提交带 CSRF 头与最小字段，成功后 refresh 并跳回深链', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'open' }) });
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const tree = await renderAfterMode('/read/3');

    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'a-password-of-15');
    type(tree, 'confirm-password', 'a-password-of-15');
    const ready = render('/read/3');
    await submit(ready);

    expect(mocks.fetch).toHaveBeenLastCalledWith('/api/auth/register', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json', 'x-nf-csrf': '1' }),
    }));
    const call = mocks.fetch.mock.calls.at(-1) as unknown[];
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ username: 'reader', password: 'a-password-of-15' });
    expect(mocks.owner.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/read/3');
  });

  it('invite 模式附上裁剪后的邀请码；open 模式请求体绝不含 inviteCode 键', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'invite' }) });
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const tree = await renderAfterMode();

    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'a-password-of-15');
    type(tree, 'confirm-password', 'a-password-of-15');
    type(tree, 'invite-code', ' INVITE-9 ');
    await submit(render());

    const call = mocks.fetch.mock.calls.at(-1) as unknown[];
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      username: 'reader', password: 'a-password-of-15', inviteCode: 'INVITE-9',
    });
  });

  it('提交被拒（REGISTRATION_CLOSED）回落关闭态、清空密码且不跳转', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'open' }) });
    mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'REGISTRATION_CLOSED', error: '注册已关闭' }) });
    const tree = await renderAfterMode('/read/3');

    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'a-password-of-15');
    type(tree, 'confirm-password', 'a-password-of-15');
    await submit(render('/read/3'));

    expect(mocks.owner.refresh).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();

    // 密码立即清空；mode 回到 closed：重渲染后提交入口禁用、错误行显示服务端原文。
    const after = render();
    expect(submitButton(after)!.props?.disabled).toBe(true);
    expect(inputNames(after, true)).not.toContain('new-password');
    expect(alertText(after)).toContain('注册已关闭');
    // 密码不在任何渲染里复现。
    expect(texts(after).join('')).not.toContain('a-password-of-15');
  });

  it('普通失败（用户名占用）保留错误原文与用户名草稿，密码仍清空', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'open' }) });
    mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'USERNAME_TAKEN', error: '用户名已被使用' }) });
    const tree = await renderAfterMode();

    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'a-password-of-15');
    type(tree, 'confirm-password', 'a-password-of-15');
    await submit(render());

    const after = render();
    expect(alertText(after)).toContain('用户名已被使用');
    expect(submitButton(after)!.props?.disabled).not.toBe(true); // 仍开放，可换名重试
    const username = findInput(after, 'username')!;
    expect(username.props?.value).toBe('reader');
  });

  it('两次密码不一致在本地拦下，不发出提交请求', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'open' }) });
    const tree = await renderAfterMode();
    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'a-password-of-15');
    type(tree, 'confirm-password', 'a-password-of-14');
    const callsBefore = mocks.fetch.mock.calls.length;

    await submit(render());

    expect(mocks.fetch.mock.calls.length).toBe(callsBefore);
    expect(alertText(render())).toContain('两次输入的密码不一致');
  });

  it('短密码在本地拦下（15 码位阈值），不发出请求', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'open' }) });
    const tree = await renderAfterMode();
    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'short');
    type(tree, 'confirm-password', 'short');
    const callsBefore = mocks.fetch.mock.calls.length;

    await submit(render());

    expect(mocks.fetch.mock.calls.length).toBe(callsBefore);
    expect(alertText(render())).toContain('密码至少需要 15 个字符');
  });

  it('网络异常提示可重试、清空密码且不跳转', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'open' }) });
    mocks.fetch.mockRejectedValueOnce(new Error('network down'));
    const tree = await renderAfterMode('/read/3');
    type(tree, 'username', 'reader');
    type(tree, 'new-password', 'a-password-of-15');
    type(tree, 'confirm-password', 'a-password-of-15');

    await submit(render('/read/3'));

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(alertText(render())).toContain('网络异常');
    expect(texts(render()).join('')).not.toContain('a-password-of-15');
  });

  it('关闭态下 submit 直接返回，不发出提交请求', async () => {
    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ registrationMode: 'closed' }) });
    const tree = await renderAfterMode();
    type(tree, 'username', 'reader');
    const callsBefore = mocks.fetch.mock.calls.length;

    await submit(render());

    expect(mocks.fetch.mock.calls.length).toBe(callsBefore);
    expect(mocks.owner.refresh).not.toHaveBeenCalled();
  });
});

describe('部署总闸', () => {
  it('账号模式总闸没开时不查三态，直接关闭', async () => {
    mocks.owner = ownerState({ accountsEnabled: false });
    render();
    (hooks.effects[0] ?? (() => {}))();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.fetch).not.toHaveBeenCalled();
    const tree = render();
    expect(submitButton(tree)!.props?.disabled).toBe(true);
    expect(inputNames(tree, true)).not.toContain('new-password');
  });
});
