'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import { safeReturnPath } from '@/lib/auth-client';

// 与 src/lib/password.ts 的 MIN_PASSWORD_CODEPOINTS 同一语义。那个模块 import 了
// node:crypto，不能进客户端包，所以这里写一份字面量并由注册接口做最终校验。
const MIN_PASSWORD_CODEPOINTS = 15;

type RegistrationMode = 'closed' | 'open' | 'invite';

// 注册表单：三态以服务端 /api/auth/registration 为准（部署闸门未开或成员总闸关闭时
// 一律表现为 closed）。用户名草稿在失败后保留，密码任何时候都不留在内存里；提交时才发现
// 关闭也如实提示，不假装成功。
export default function RegisterCard({ returnTo }: { returnTo: string | null }) {
  const { accountsEnabled, user, refresh } = useOwner();
  const router = useRouter();
  const ids = useId();
  const [mode, setMode] = useState<RegistrationMode | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const target = safeReturnPath(returnTo) ?? '/';
  const loginHref = `/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (controller.signal.aborted) return;
      if (!accountsEnabled) { setMode('closed'); return; }
      try {
        const res = await fetch('/api/auth/registration', { signal: controller.signal });
        const data = await res.json() as { registrationMode?: RegistrationMode };
        if (!controller.signal.aborted) {
          setMode(data.registrationMode === 'open' || data.registrationMode === 'invite' ? data.registrationMode : 'closed');
        }
      } catch {
        if (!controller.signal.aborted) setMode('closed');
      }
    };
    // 不在 effect 体内同步 setState（会触发级联渲染）；与项目其它 tab 一样丢进微任务。
    queueMicrotask(() => { void load(); });
    return () => controller.abort();
  }, [accountsEnabled]);

  const open = accountsEnabled && (mode === 'open' || mode === 'invite');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!open || submitting) return;
    setError('');
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    if ([...password].length < MIN_PASSWORD_CODEPOINTS) {
      setError(`密码至少需要 ${MIN_PASSWORD_CODEPOINTS} 个字符`); return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nf-csrf': '1' },
        body: JSON.stringify({
          username,
          password,
          ...(mode === 'invite' && inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
      if (!res.ok) {
        if (data.code === 'REGISTRATION_CLOSED') setMode('closed');
        setError(typeof data.error === 'string' && data.error ? data.error : '注册失败，请稍后重试');
        setPassword(''); setConfirm('');
        return;
      }
      setPassword(''); setConfirm('');
      await refresh().catch(() => {});
      router.replace(target);
    } catch {
      setError('网络异常，请稍后重试；没有创建账号时可以重新提交');
      setPassword(''); setConfirm('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="border border-[var(--line)] bg-[var(--paper-card)]/70 px-6 sm:px-8 py-8 w-full max-w-md"
      style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
    >
      <h1 className="text-lg font-bold tracking-wide">注册</h1>
      {!open ? (
        <p role="status" className="mt-2 text-sm" style={{ color: 'var(--cinnabar)' }}>
          {accountsEnabled ? '注册当前未开放。开放后可凭邀请码创建账号。' : '本站当前未启用账号模式，注册不可用。'}
        </p>
      ) : (
        <p role="status" className="mt-2 text-sm" style={{ color: 'var(--ink-soft)' }}>
          {mode === 'invite' ? '本站当前为邀请码注册，请填入管理员发给你的邀请码。' : '本站当前开放注册。'}
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--cinnabar)' }}>✗ {error}</p>}
      <form className="mt-5 flex flex-col gap-2" aria-label={open ? '注册' : '注册（当前未开放）'} onSubmit={(event) => void submit(event)}>
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
          disabled={submitting}
          aria-describedby={`${ids}-rules`}
        />
        <p id={`${ids}-rules`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>
          3-32 位小写字母、数字或下划线，首位必须是字母。密码至少 {MIN_PASSWORD_CODEPOINTS} 个字符。
        </p>
        <label htmlFor={`${ids}-password`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>密码</label>
        <input
          id={`${ids}-password`}
          className="paper-input text-sm min-h-11"
          type="password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={!open || submitting}
        />
        <label htmlFor={`${ids}-confirm`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>确认密码</label>
        <input
          id={`${ids}-confirm`}
          className="paper-input text-sm min-h-11"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          disabled={!open || submitting}
        />
        {mode === 'invite' && (
          <>
            <label htmlFor={`${ids}-invite`} className="text-xs" style={{ color: 'var(--ink-soft)' }}>邀请码</label>
            <input
              id={`${ids}-invite`}
              className="paper-input text-sm min-h-11"
              type="text"
              name="invite-code"
              autoComplete="off"
              spellCheck={false}
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              disabled={!open || submitting}
            />
          </>
        )}
        <button type="submit" className="ink-button text-xs !px-4 min-h-11 mt-2 w-fit" disabled={!open || submitting}>
          {submitting ? '注册中…' : '注 册'}
        </button>
        <p id={`${ids}-closed`} className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          {open ? '注册成功后会自动登录。密码不会被保存到本机。' : '提交入口在注册开放前保持禁用，密码框不可输入，也不会保存任何内容。'}
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
