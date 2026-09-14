import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import ReaderClient from '@/components/reader/ReaderClient';

export const metadata: Metadata = {
  title: '在线阅读 · 书径',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function ReaderPage({ params, searchParams }: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { taskId } = await params;
  const id = Number(taskId);
  if (!/^[1-9]\d*$/.test(taskId) || !Number.isSafeInteger(id) || id > 2_147_483_647) notFound();
  const from = (await searchParams).from === 'shelf' ? 'shelf' : 'library';
  return <ReaderClient key={id} taskId={id} from={from} />;
}
