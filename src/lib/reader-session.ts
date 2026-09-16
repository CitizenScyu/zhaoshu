import type { ReaderIndex, ReaderOrigin, ReaderPart, ReadingSession } from './reader-types';
import type { ReadingPosition } from './reader-preferences';

export function bookReadingHref(book: { taskId?: number | null; title: string; author: string; from: ReaderOrigin }): string {
  if (book.taskId && Number.isSafeInteger(book.taskId) && book.taskId > 0) return `/read/${book.taskId}?from=${book.from}`;
  return '/read/source?' + new URLSearchParams({ title: book.title, author: book.author, from: book.from });
}

export function readingSessionKey(session: ReadingSession): string {
  return session.kind === 'download' ? 'download:' + session.taskId : JSON.stringify(['source', session.title, session.author]);
}

export function readerIndexUrl(session: ReadingSession): string {
  return session.kind === 'download' ? `/api/read/${session.taskId}/index`
    : '/api/read/source/index?' + new URLSearchParams({ title: session.title, author: session.author });
}

export function readerChapterUrl(index: ReaderIndex, position: ReadingPosition): string {
  const query = new URLSearchParams({ chapter: String(position.chapterIndex), part: String(position.partIndex), version: index.version });
  if (index.source) query.set('session', index.source.session);
  return `/api/read/${index.source ? 'source' : index.taskId}/chapter?${query}`;
}

export function readerPartMatches(index: ReaderIndex, part: ReaderPart, position: ReadingPosition): boolean {
  return (index.source ? part.taskId === null && part.sourceId === index.source.id : part.taskId === index.taskId && !part.sourceId)
    && part.version === index.version && part.chapterIndex === position.chapterIndex
    && part.partIndex === position.partIndex && typeof part.text === 'string';
}
