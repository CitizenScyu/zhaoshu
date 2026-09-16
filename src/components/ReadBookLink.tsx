'use client';

import Link from 'next/link';
import { useOwner } from '@/components/OwnerProvider';
import { bookReadingHref } from '@/lib/reader-session';
import type { ReaderOrigin } from '@/lib/reader-types';

interface Props {
  taskId?: number | null;
  title: string;
  author: string;
  from: ReaderOrigin;
  label?: string;
}

// 无阅读权限时仍然保留深链入口，只把原因说清楚：阅读页会区分“未登录 / 没有权限 / 不存在”，
// 不能把“没有权限”渲染成“文件不存在”。
export default function ReadBookLink({ label = '阅读', ...book }: Props) {
  const { ready, can } = useOwner();
  const allowed = !ready || can('read');
  return (
    <Link
      href={bookReadingHref(book)}
      prefetch={false}
      className="chip chip-dai !inline-flex min-h-11 items-center justify-center !px-4 !text-sm"
      aria-label={allowed ? `${label}《${book.title}》` : `${label}《${book.title}》（当前账号尚无阅读权限）`}
      title={allowed ? undefined : '当前账号尚未获得阅读权限，打开后会说明原因'}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {label} →
      {!allowed && <span className="sr-only">（当前账号尚无阅读权限）</span>}
    </Link>
  );
}
