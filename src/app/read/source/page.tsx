import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import ReaderClient from '@/components/reader/ReaderClient';
import { cleanString } from '@/lib/sanitize';

export const metadata: Metadata = { title: '书源阅读 · 书径', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function SourceReaderPage({ searchParams }: {
  searchParams: Promise<{ title?: string | string[]; author?: string | string[]; from?: string | string[] }>;
}) {
  const query = await searchParams;
  const title = cleanString(query.title, 200);
  const author = cleanString(query.author ?? '', 200);
  if (!title || (query.author && !author)) notFound();
  const from = query.from === 'shelf' || query.from === 'find' ? query.from : 'library';
  return <ReaderClient session={{ kind: 'source', title, author }} from={from} />;
}
