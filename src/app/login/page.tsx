import type { Metadata } from 'next';
import { OwnerProvider } from '@/components/OwnerProvider';
import { safeReturnPath } from '@/lib/auth-client';
import LoginCard from './LoginCard';

export const metadata: Metadata = { title: '登录 · 书径', robots: { index: false, follow: false } };

// 深链登录：returnTo 先在服务端过滤，只接受同源站内相对路径。
export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requested = (await searchParams).returnTo;
  const returnTo = safeReturnPath(typeof requested === 'string' ? requested : null);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="seal w-14 h-14 text-xl rotate-[-3deg]">书径</div>
      <OwnerProvider>
        <LoginCard returnTo={returnTo} />
      </OwnerProvider>
    </div>
  );
}
