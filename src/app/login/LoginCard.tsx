'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOwner } from '@/components/OwnerProvider';
import AuthForm from '@/components/AuthForm';
import { safeReturnPath } from '@/lib/auth-client';

// 独立登录页：与主页账号入口、阅读器共用同一小型表单组件。
export default function LoginCard({ returnTo }: { returnTo: string | null }) {
  const { status, user } = useOwner();
  const router = useRouter();
  // returnTo 已在服务端过滤；这里再校验一次，避免下游消费点成为唯一防线。
  const target = safeReturnPath(returnTo) ?? '/';
  return (
    <div
      className="border border-[var(--line)] bg-[var(--paper-card)]/70 px-6 sm:px-8 py-8 w-full max-w-md"
      style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
    >
      {status === 'authenticated' && user ? (
        <div className="text-sm">
          <p>已登录为 <strong>{user.username}</strong>。</p>
          <p className="mt-3">
            <Link className="underline underline-offset-4" href={target}>继续使用书径 →</Link>
          </p>
        </div>
      ) : (
        <>
          <AuthForm returnTo={returnTo} onSuccess={() => router.replace('/')} />
          <p className="mt-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
            <Link className="underline underline-offset-4" href="/">← 返回书径</Link>
          </p>
        </>
      )}
    </div>
  );
}
