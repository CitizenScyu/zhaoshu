import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import ReaderClient from '@/components/reader/ReaderClient';
import { cleanString } from '@/lib/sanitize';

export const metadata: Metadata = { title: '书源阅读 · 书径', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function SourceReaderPage({ searchParams }: {
  searchParams: Promise<{
    title?: string | string[]; author?: string | string[]; from?: string | string[];
    book_url?: string | string[]; source?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const title = cleanString(query.title, 200);
  const author = cleanString(query.author ?? '', 200);
  if (!title || (query.author && !author)) notFound();
  const from = query.from === 'shelf' || query.from === 'find' ? query.from : 'library';
  // 模糊候选的用户确认路径：点选候选后 URL 带 book_url 重放（服务端再做白名单校验）。
  const bookUrl = cleanString(query.book_url ?? '', 2048);
  // 扇出面板换源后 URL 同时存 source（源 url），刷新时确认路径仍按该源规则建目录；无 book_url 时不用。
  const sourceUrl = bookUrl ? cleanString(query.source ?? '', 2048) : '';
  return <ReaderClient session={{ kind: 'source', title, author, ...(bookUrl ? { bookUrl } : {}), ...(sourceUrl ? { sourceUrl } : {}) }} from={from} />;
}
