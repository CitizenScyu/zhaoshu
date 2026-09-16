'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';

// 注册表单的最小骨架：字段与无障碍属性按 §6.1 到位，但注册接口要到第 35 批才交付，
// 因此这里只做“当前已关闭”的显式提示，不发任何网络请求、不保存任何密码。
export default function RegisterCard({ returnTo }: { returnTo: string | null }) {
  const { accountsEnabled, user } = useOwner();
  const ids = useId();
  const [username, setUsername] = useState('');
  const loginHref = `/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;

  return (
    <div
      className="border border-[var(--line)] bg-[var(--paper-card)]/70 px-6 sm:px-8 py-8 w-full max-w-md"
      style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
    >
      <h1 className="text-lg font-bold tracking-wide">注册</h1>
      <p role="status" className="mt-2 text-sm" style={{ color: 'var(--cinnabar)' }}>
        {accountsEnabled ? '注册当前未开放。开放后可凭邀请码创建账号。' : '本站当前未启用账号模式，注册不可用。'}
      </p>
      <form className="mt-5 flex flex-col gap-2" aria-label="注册（当前未开放）" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor={`${ids}-username`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>用户名</label>
        <input
          id={`${ids}-username`}
          className="paper-input text-sm min-h-11"
          type="text"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-describedby={`${ids}-closed`}
        />
        <p className="text-xs" style={{ color: 'var(--ink-soft)' }}>
          用户名草稿会保留在本页内存中；注册开放后可直接使用。
        </p>
        <label htmlFor={`${ids}-password`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>密码</label>
        <input id={`${ids}-password`} className="paper-input text-sm min-h-11" type="password" name="new-password" autoComplete="new-password" disabled aria-describedby={`${ids}-closed`} />
        <label htmlFor={`${ids}-confirm`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>确认密码</label>
        <input id={`${ids}-confirm`} className="paper-input text-sm min-h-11" type="password" name="confirm-password" autoComplete="new-password" disabled aria-describedby={`${ids}-closed`} />
        <button type="submit" className="ink-button text-xs !px-4 min-h-11 mt-2 w-fit" disabled>注 册</button>
        <p id={`${ids}-closed`} className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          提交入口在注册开放前保持禁用，密码框不可输入，也不会保存任何内容。
        </p>
      </form>
      <p className="mt-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
        {user ? '已登录用户无需再注册。' : <>
          <Link className="underline underline-offset-4" href={loginHref}>去登录</Link>
          {' · '}
          <Link className="underline underline-offset-4" href="/">← 返回书径</Link>
        </>}
      </p>
    </div>
  );
}
