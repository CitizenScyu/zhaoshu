'use client';

import Link from 'next/link';
import { bookReadingHref } from '@/lib/reader-session';
import type { ReaderOrigin } from '@/lib/reader-types';

interface Props {
  taskId?: number | null;
  title: string;
  author: string;
  from: ReaderOrigin;
  label?: string;
}

export default function ReadBookLink({ label = '阅读', ...book }: Props) {
  return (
    <Link
      href={bookReadingHref(book)}
      prefetch={false}
      className="chip chip-dai !inline-flex min-h-11 items-center justify-center !px-4 !text-sm"
      aria-label={`${label}《${book.title}》`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >{label} →</Link>
  );
}
