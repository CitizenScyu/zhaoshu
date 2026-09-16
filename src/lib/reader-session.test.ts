import { describe, expect, it } from 'vitest';
import { bookReadingHref, readerChapterUrl, readerIndexUrl, readerPartMatches, readingSessionKey } from './reader-session';
import { indexProgressKey, readingPercent, parseReadingProgress } from './reader-preferences';
import type { ReaderIndex, ReaderPart } from './reader-types';

const local: ReaderIndex = { taskId: 7, title: '测试书', author: '作者', version: 'a'.repeat(40), totalBytes: 100,
  chapters: [{ index: 0, title: '第一章', startByte: 0, endByte: 100, partCount: 1 }] };
const online: ReaderIndex = { ...local, taskId: null, totalBytes: 0,
  source: { id: 'source-one', name: '书源', url: 'https://book15.net/books/details7.html', session: local.version } };
const position = { chapterIndex: 0, partIndex: 0, ratio: 0.5 };

describe('download and source reading sessions', () => {
  it('keeps existing completed-download links', () => {
    expect(bookReadingHref({ taskId: 7, title: local.title, author: local.author, from: 'library' })).toBe('/read/7?from=library');
    expect(readerIndexUrl({ kind: 'download', taskId: 7 })).toBe('/api/read/7/index');
  });

  it.each(['library', 'shelf', 'find'] as const)('always offers online reading without a task (%s)', (from) => {
    const href = bookReadingHref({ title: '书&名', author: '作#者', from });
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe('/read/source');
    expect(url.searchParams.get('title')).toBe('书&名');
    expect(url.searchParams.get('author')).toBe('作#者');
    expect(url.searchParams.get('from')).toBe(from);
  });

  it('keeps local progress compatible and separates both source kinds and different sources', () => {
    expect(indexProgressKey(local)).toBe('novel-finder-reading-progress-7');
    expect(indexProgressKey(online)).not.toBe(indexProgressKey(local));
    expect(indexProgressKey({ ...online, source: { ...online.source!, id: 'source-two' } })).not.toBe(indexProgressKey(online));
    expect(readingSessionKey({ kind: 'download', taskId: 7 })).not.toBe(readingSessionKey({ kind: 'source', title: '7', author: '' }));
  });

  it('routes chapters with their actual source session and rejects cross-source parts', () => {
    const part: ReaderPart = { ...position, taskId: null, sourceId: online.source!.id, version: online.version,
      partCount: 1, title: '第一章', text: '正文', startByte: 0, endByte: 6 };
    const url = new URL(readerChapterUrl(online, position), 'http://localhost');
    expect(url.pathname).toBe('/api/read/source/chapter');
    expect(url.searchParams.get('session')).toBe(online.source!.session);
    expect(readerPartMatches(online, part, position)).toBe(true);
    expect(readerPartMatches(local, part, position)).toBe(false);
    expect(readerPartMatches(online, { ...part, sourceId: 'other-source' }, position)).toBe(false);
  });

  it('remembers source progress and estimates by chapter when total file bytes are unknown', () => {
    const progress = { ...position, schema: 1, version: online.version, updatedAt: 1234 };
    const part: ReaderPart = { ...position, taskId: null, sourceId: online.source!.id, version: online.version,
      partCount: 1, title: '第一章', text: '正文', startByte: 0, endByte: 6 };
    expect(parseReadingProgress(JSON.stringify(progress), online)).toEqual(progress);
    expect(readingPercent(online, part, 0.5)).toBe(50);
    expect(readingPercent(online, part, 1)).toBe(100);
  });
});
