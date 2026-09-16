import type { Metadata } from 'next';
import { OwnerProvider } from '@/components/OwnerProvider';
import { safeReturnPath } from '@/lib/auth-client';
import RegisterCard from './RegisterCard';

export const metadata: Metadata = { title: '注册 · 书径', robots: { index: false, follow: false } };

// 注册接口属于第 35 批（A07）；本批只交付最小表单骨架与明确的关闭状态。
export default async function RegisterPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requested = (await searchParams).returnTo;
  const returnTo = safeReturnPath(typeof requested === 'string' ? requested : null);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="seal w-14 h-14 text-xl rotate-[-3deg]">书径</div>
      <OwnerProvider>
        <RegisterCard returnTo={returnTo} />
      </OwnerProvider>
    </div>
  );
}
