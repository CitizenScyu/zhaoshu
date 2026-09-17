import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), owner: {} as Record<string, unknown> }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
// 用宿主元素替换 Link，便于直接断言最终 href。
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import LoginCard from './LoginCard';
import AuthForm from '@/components/AuthForm';

// 未登录分支不再桩掉 AuthForm（audit-reader #3）：LoginCard 只调用 useOwner/useRouter，
// 可直接当函数调取回元素树——AuthForm 是树上的元素引用而非被调用，真实组件的
// hooks 不会执行，我们只检查 LoginCard 递给它的 props。
type Element = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function findElement(node: unknown, type: unknown): Element | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  const element = node as Element;
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner = { status: 'authenticated', user: { username: 'owner' } };
});

describe('独立登录页的深链消费点', () => {
  it('neutralizes a protocol-relative returnTo at the link itself', () => {
    const html = renderToStaticMarkup(createElement(LoginCard, { returnTo: '//evil.com' }));
    expect(html).toContain('href="/"');
    expect(html).not.toContain('//evil.com');
  });

  it('keeps a legitimate in-site return path', () => {
    const html = renderToStaticMarkup(createElement(LoginCard, { returnTo: '/read/3' }));
    expect(html).toContain('href="/read/3"');
  });

  it('falls back to the home page when there is no return path', () => {
    const html = renderToStaticMarkup(createElement(LoginCard, { returnTo: null }));
    expect(html).toContain('href="/"');
  });
});

describe('未登录分支把深链交给共享表单', () => {
  it('passes the raw returnTo into AuthForm and falls back to home on success', () => {
    mocks.owner = { status: 'anonymous', user: null };
    const tree = LoginCard({ returnTo: '/read/3' }) as unknown;
    const form = findElement(tree, AuthForm);
    // 已登录态之外的分支：AuthForm 必须真的被渲染（而不是被静默换掉）。
    expect(form).not.toBeNull();
    expect(form!.props?.returnTo).toBe('/read/3');
    expect(typeof form!.props?.onSuccess).toBe('function');

    // 回退跳转的目标是首页：表单成功但没有深链可用时由 LoginCard 决定去向。
    (form!.props!.onSuccess as () => void)();
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/');
  });

  it('keeps handing the raw returnTo to AuthForm even when it looks tampered', () => {
    mocks.owner = { status: 'anonymous', user: null };
    const tree = LoginCard({ returnTo: '//evil.com' }) as unknown;
    const form = findElement(tree, AuthForm);
    // LoginCard 不替 AuthForm 预先判定：深链的二次校验在表单内部（safeReturnPath），
    // 这里只确认它拿到的是原始值，不会被本组件悄悄改写。
    expect(form!.props?.returnTo).toBe('//evil.com');
    (form!.props!.onSuccess as () => void)();
    expect(mocks.replace).toHaveBeenCalledWith('/');
  });

  it('does not render the shared form once authenticated', () => {
    const tree = LoginCard({ returnTo: '/read/3' }) as unknown;
    expect(findElement(tree, AuthForm)).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
