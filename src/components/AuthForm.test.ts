import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), owner: {} as Record<string, unknown> }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/OwnerProvider', () => ({ useOwner: () => mocks.owner }));

import AuthForm from './AuthForm';
import RegisterCard from '@/app/register/RegisterCard';

function setOwner(overrides: Record<string, unknown> = {}) {
  mocks.owner = {
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

beforeEach(() => {
  vi.clearAllMocks();
  setOwner();
});

describe('共享登录表单', () => {
  it('defaults to the username/password entry when accounts mode is on', () => {
    const html = renderToStaticMarkup(createElement(AuthForm));
    expect(html).toContain('name="username"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain('current-password');
    expect(html).toContain('保持登录');
    expect(html).toContain('管理员口令登录');
    expect(html).toContain('注册');
    // 账号模式下不展示旧口令的“仅本次会话保存”。
    expect(html).not.toContain('仅本次会话保存');
  });

  it('keeps the legacy owner passphrase flow when the deployment switch is off', () => {
    setOwner({ accountsEnabled: false });
    const html = renderToStaticMarkup(createElement(AuthForm));
    expect(html).toContain('name="owner-token"');
    expect(html).toContain('仅本次会话保存');
    // 旧模式没有用户名密码入口，也没有注册链接。
    expect(html).not.toContain('name="username"');
    expect(html).not.toContain('注册');
  });

  it('distinguishes an expired cookie from an unavailable service', () => {
    expect(renderToStaticMarkup(createElement(AuthForm, { returnTo: null }))).not.toContain('登录已过期');
    setOwner({ expired: true });
    expect(renderToStaticMarkup(createElement(AuthForm, { returnTo: null }))).toContain('登录已过期');
    setOwner({ status: 'unavailable' });
    expect(renderToStaticMarkup(createElement(AuthForm, { returnTo: null }))).toContain('服务暂不可用');
  });

  it('shows only a status line while the session state is unresolved', () => {
    setOwner({ status: 'loading' });
    const html = renderToStaticMarkup(createElement(AuthForm));
    expect(html).toContain('正在恢复访问状态');
    // 部署开关还不知道时不能先渲染某一个入口。
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });

  it('passes the validated return path through to the registration link', () => {
    setOwner();
    const html = renderToStaticMarkup(createElement(AuthForm, { returnTo: '/read/12?from=shelf' }));
    expect(html).toContain('/register?returnTo=%2Fread%2F12%3Ffrom%3Dshelf');
  });

  it('accepts the reader skin without changing the shared logic', () => {
    const html = renderToStaticMarkup(createElement(AuthForm, {
      compact: true, message: '口令不正确或已失效，请重新输入。',
      classes: { input: 'reader-input', primary: 'reader-primary' },
    }));
    expect(html).toContain('reader-input');
    expect(html).toContain('reader-primary');
    expect(html).toContain('口令不正确或已失效');
    // compact 不重复标题。
    expect(html).not.toContain('<h1');
  });
});

describe('注册入口', () => {
  it('shows an explicit closed state and never enables password fields', () => {
    const html = renderToStaticMarkup(createElement(RegisterCard, { returnTo: '/read/3' }));
    expect(html).toContain('注册当前未开放');
    expect(html).toContain('name="username"');
    // 用户名可留草稿（不禁用），密码框与提交入口保持禁用。
    expect(html).toMatch(/<input[^>]*disabled[^>]*name="new-password"/);
    expect(html).toMatch(/<input[^>]*disabled[^>]*name="confirm-password"/);
    expect(html).not.toMatch(/<input[^>]*disabled[^>]*name="username"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('points at the disabled deployment mode when accounts are off', () => {
    setOwner({ accountsEnabled: false });
    expect(renderToStaticMarkup(createElement(RegisterCard, { returnTo: null }))).toContain('未启用账号模式');
  });
});
