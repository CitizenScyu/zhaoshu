import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), owner: {} as Record<string, unknown> }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
// 用宿主元素替换 Link，便于直接断言最终 href。
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));
vi.mock('@/components/AuthForm', () => ({ default: () => createElement('div', { 'data-auth-form': '1' }) }));

import LoginCard from './LoginCard';

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
