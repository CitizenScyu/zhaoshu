'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOwner } from '@/components/OwnerProvider';
import { safeReturnPath } from '@/lib/auth-client';

export interface AuthFormClasses {
  form?: string;
  field?: string;
  label?: string;
  input?: string;
  primary?: string;
  error?: string;
  note?: string;
}

const PAPER_CLASSES: Required<AuthFormClasses> = {
  form: '',
  field: 'flex w-full min-w-0 items-center gap-2',
  label: '',
  input: 'paper-input text-sm min-h-11 flex-1',
  primary: 'ink-button text-xs !px-4 shrink-0 min-h-11',
  error: 'text-xs',
  note: 'text-xs',
};

interface AuthFormProps {
  /** 只接受经 safeReturnPath 过滤过的站内相对路径。 */
  returnTo?: string | null;
  classes?: AuthFormClasses;
  /** 阅读器内嵌时可省略标题与注册链接。 */
  compact?: boolean;
  /** 覆盖默认标题与说明文案。 */
  title?: string;
  description?: string;
  /** 不做跳转时（内嵌阅读器）的成功回调。 */
  onSuccess?: () => void;
  /** 默认展示哪一种入口；账号模式默认用户名密码。 */
  defaultMode?: 'member' | 'owner';
  /** 外部传入的说明文案（例如后端返回的错误），在没有本地错误时显示。 */
  message?: string;
}

// 登录 / 管理员口令的最小共享表单：主页账号入口、独立 /login、阅读器共用同一套逻辑。
export default function AuthForm({
  returnTo,
  classes,
  compact = false,
  title,
  description,
  onSuccess,
  defaultMode = 'member',
  message,
}: AuthFormProps) {
  const { status, accountsEnabled, expired, login, submitToken, sessionOnly, setSessionOnly } = useOwner();
  const router = useRouter();
  const ids = useId();
  const skin = { ...PAPER_CLASSES, ...classes };
  // 部署开关是异步才知道的（首帧还不知道），所以入口按当前开关推导而不是锁死在初值，
  // 只有用户显式切换过才用本地选择覆盖。
  const [modeOverride, setModeOverride] = useState<'member' | 'owner' | null>(null);
  const mode = modeOverride ?? (accountsEnabled ? defaultMode : 'owner');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const locked = status === 'loading' || status === 'unavailable';
  const memberMode = accountsEnabled && mode === 'member';
  const target = safeReturnPath(returnTo);

  function finish() {
    // 有深链就回到深链；否则交给调用方决定（主页保持原地，独立登录页回首页）。
    if (target) {
      router.replace(target);
      return;
    }
    onSuccess?.();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked) return;
    setBusy(true);
    setError('');
    try {
      if (memberMode) {
        if (!username.trim() || !password) throw new Error('请输入用户名和密码');
        await login(username, password, remember);
      } else {
        if (!draft.trim()) throw new Error('请先输入访问口令');
        await submitToken(draft);
        // 旧模式不把口令留在表单状态里；账号模式下由服务端 Cookie 承载。
        setDraft('');
        setUsername('');
      }
      setPassword('');
      finish();
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') return;
      setError(failure instanceof Error ? failure.message : '验证失败，请稍后重试');
      // 失败时保留用户名草稿，绝不保留密码。
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const notice = status === 'unavailable'
    ? '服务暂不可用，请稍后再试。'
    : expired
      ? '登录已过期，请重新登录。'
      : error || message || '';

  // 部署开关与权限都还没确定时不渲染表单：既不闪错误的入口，也不提前请求私有数据。
  if (status === 'loading') {
    return <p role="status" className={skin.note} style={{ color: 'var(--ink-soft)' }}>正在恢复访问状态…</p>;
  }

  return (
    <div>
      {!compact && (
        <div className="mb-3">
          <h1 className="text-lg font-bold tracking-wide">{title ?? (accountsEnabled ? '账号登录' : '管理员口令')}</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>
            {description ?? (accountsEnabled ? '使用用户名和密码登录书径。' : '输入站点访问口令，继续使用书径。')}
          </p>
        </div>
      )}
      <form onSubmit={submit} aria-label={accountsEnabled ? '账号登录' : '管理员口令登录'} className={skin.form}>
        {memberMode ? (
          <div className="flex flex-col gap-2 w-full">
            <label htmlFor={`${ids}-username`} className={skin.label}>用户名</label>
            <input
              id={`${ids}-username`}
              className={skin.input}
              type="text"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => { setUsername(event.target.value); setError(''); }}
              disabled={busy || locked}
              required
            />
            <label htmlFor={`${ids}-password`} className={skin.label}>密码</label>
            <input
              id={`${ids}-password`}
              className={skin.input}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(''); }}
              disabled={busy || locked}
              required
            />
            <label className="flex items-center gap-2 min-h-11" style={{ color: 'var(--ink-soft)' }}>
              <input
                type="checkbox"
                checked={remember}
                disabled={busy || locked}
                onChange={(event) => setRemember(event.target.checked)}
              />
              保持登录（最多 7 天）
            </label>
            <button type="submit" className={skin.primary} disabled={busy || locked || !username.trim() || !password}>
              {busy ? '登录中…' : '登 录'}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full">
            <label htmlFor={`${ids}-owner`} className={skin.label} style={{ color: 'var(--ink-soft)' }}>访问口令</label>
            <input
              id={`${ids}-owner`}
              className={skin.input}
              type="password"
              name="owner-token"
              autoComplete="current-password"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(''); }}
              disabled={busy || locked}
              aria-describedby={`${ids}-status`}
              required
            />
            <button type="submit" className={skin.primary} disabled={busy || locked || !draft.trim()}>
              {busy ? '验证中…' : '提交口令'}
            </button>
            {!accountsEnabled && (
              <label className="flex items-center gap-2 min-h-11" style={{ color: 'var(--ink-soft)' }}>
                <input
                  type="checkbox"
                  checked={sessionOnly}
                  disabled={busy || locked}
                  onChange={(event) => setSessionOnly(event.target.checked)}
                />
                仅本次会话保存
              </label>
            )}
          </div>
        )}
        <p
          id={`${ids}-status`}
          role={notice ? 'alert' : 'status'}
          className={error ? skin.error : skin.note}
          style={{ color: error ? 'var(--cinnabar)' : 'var(--ink-soft)', flexBasis: '100%' }}
        >
          {notice || (accountsEnabled ? '登录后按账号权限使用书径。' : '输入并提交口令后生效。')}
        </p>
        {accountsEnabled && (
          <div className="flex flex-wrap items-center gap-3 text-xs" style={{ flexBasis: '100%' }}>
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => { setModeOverride(memberMode ? 'owner' : 'member'); setError(''); setPassword(''); }}
            >
              {memberMode ? '管理员口令登录' : '返回账号登录'}
            </button>
            {memberMode && <a className="underline underline-offset-4" href={`/register${target ? `?returnTo=${encodeURIComponent(target)}` : ''}`}>注册</a>}
          </div>
        )}
      </form>
    </div>
  );
}
