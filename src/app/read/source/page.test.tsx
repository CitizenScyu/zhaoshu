import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadingSession } from '@/lib/reader-types';

// 41-srcurl(panelrev41 M10 存活项):page.tsx 的 source 护栏 —— source 只与 book_url 同用才进阅读会话。
// 服务端对「source 无 book_url」另有独立 400,这里钉的是前端这一侧:护栏被删时会话会带上 sourceUrl,
// readerIndexUrl 虽仍不拼(它自己也判 book_url),但会话里不该出现一个服务端必拒的参数。
vi.mock('@/components/reader/ReaderClient', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

const { default: SourceReaderPage } = await import('./page');

async function sessionFor(query: Record<string, string>): Promise<ReadingSession> {
  const element = await SourceReaderPage({ searchParams: Promise.resolve(query) }) as ReactElement<{ session: ReadingSession }>;
  return element.props.session;
}

describe('/read/source page:source 参数护栏', () => {
  it('source 与 book_url 同用 ⇒ 会话同时带 bookUrl 与 sourceUrl(刷新后仍按该源建目录)', async () => {
    expect(await sessionFor({ title: '诡秘之主', author: '乌贼', book_url: 'https://ok.example/b/1', source: 'https://ok.example' }))
      .toEqual({ kind: 'source', title: '诡秘之主', author: '乌贼', bookUrl: 'https://ok.example/b/1', sourceUrl: 'https://ok.example' });
  });

  it('只有 source 没有 book_url ⇒ 会话不带 sourceUrl', async () => {
    const session = await sessionFor({ title: '诡秘之主', author: '乌贼', source: 'https://ok.example' });
    expect(session).toEqual({ kind: 'source', title: '诡秘之主', author: '乌贼' });
    expect(session).not.toHaveProperty('sourceUrl');
  });

  it('book_url 为空串时同样不带 sourceUrl', async () => {
    expect(await sessionFor({ title: '诡秘之主', author: '', book_url: '', source: 'https://ok.example' }))
      .toEqual({ kind: 'source', title: '诡秘之主', author: '' });
  });
});
