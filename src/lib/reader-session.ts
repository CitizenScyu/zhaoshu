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
  if (session.kind === 'download') return `/api/read/${session.taskId}/index`;
  const query = new URLSearchParams({ title: session.title, author: session.author });
  // 模糊候选点选后的确认重放：book_url 告诉服务端这是用户已确认的详情页。
  if (session.bookUrl) query.set('book_url', session.bookUrl);
  return '/api/read/source/index?' + query;
}

export function readerChapterUrl(index: ReaderIndex, position: ReadingPosition): string {
  const query = new URLSearchParams({ chapter: String(position.chapterIndex), part: String(position.partIndex), version: index.version });
  if (index.source) query.set('session', index.source.session);
  return `/api/read/${index.source ? 'source' : index.taskId}/chapter?${query}`;
}

/**
 * 章内换源后的目录身份(洞 2 的前端半边):服务端在 part 上带出新源的目录会话版本时,
 * 以**服务端为权威**构造新 index —— 版本/sourceId/会话全部换新源,后续章节直接用新源。
 * 无变化(未换源 / 下载类)时原样返回,既有路径逐点不变。
 */
export function switchedReaderIndex(index: ReaderIndex, part: ReaderPart): ReaderIndex {
  if (!index.source || !part.sourceSession || part.sourceSession === index.source.session) return index;
  return {
    ...index,
    version: part.version,
    source: { ...index.source, session: part.sourceSession, ...(part.sourceId ? { id: part.sourceId } : {}) },
  };
}

export function readerPartMatches(index: ReaderIndex, part: ReaderPart, position: ReadingPosition): boolean {
  // 唯一的合法例外:章内换源(sourceSession===part.version 由服务端对备用源标注)。
  // 无此标记而来源/版本不符仍判「内容与目录不一致」(既有语义不变)。
  const switched = !!index.source && !!part.sourceSession && part.sourceSession === part.version;
  const ownership = index.source
    ? part.taskId === null && (part.sourceId === index.source.id || switched)
    : part.taskId === index.taskId && !part.sourceId;
  return ownership && (part.version === index.version || switched)
    && part.chapterIndex === position.chapterIndex
    && part.partIndex === position.partIndex && typeof part.text === 'string';
}
