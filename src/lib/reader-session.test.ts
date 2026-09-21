import { describe, expect, it } from 'vitest';
import { bookReadingHref, readerChapterUrl, readerIndexUrl, readerPartMatches, readingSessionKey, switchedReaderIndex } from './reader-session';
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
    expect(indexProgressKey(local, 1)).toBe('novel-finder-reading-progress-u1-7');
    expect(indexProgressKey(online, 1)).not.toBe(indexProgressKey(local, 1));
    expect(indexProgressKey({ ...online, source: { ...online.source!, id: 'source-two' } }, 1)).not.toBe(indexProgressKey(online, 1));
    // 进度键必须带 userId：同一本书在两个账号下互不覆盖。
    expect(indexProgressKey(local, 2)).not.toBe(indexProgressKey(local, 1));
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

  // 洞 2 的续读链路:章内换源成功后服务端带出新源的目录会话,前端(useReader)据此
  // 把「仍在生效的目录」切成新源 —— 下一章直接打向新源,不再每章回到故障原源重试。
  it('章内换源:带 sourceSession 的 part 换出可续读的新目录,且被判定为与目录一致', () => {
    const newSession = 'b'.repeat(40);
    // 前端只以服务端给的两个事实为权威:新会话版本 + 新 sourceId(名字沿用,章头显示走 servedFrom)。
    const expectedSource = { ...online.source, id: 'source-two', session: newSession };
    const switchedPart: ReaderPart = {
      ...position, taskId: null, sourceId: 'source-two', servedFrom: '备用源',
      version: newSession, sourceSession: newSession,
      partCount: 1, title: '第一章', text: '备用源正文', startByte: 0, endByte: 18,
    };
    const adopted = switchedReaderIndex(online, switchedPart);
    expect(adopted.version).toBe(newSession);
    expect(adopted.source).toEqual(expectedSource);
    // 后续章节用新目录拼请求:session 命中新源;前端一致性闸门也放行(换源是唯一例外)。
    expect(new URL(readerChapterUrl(adopted, position), 'http://localhost').searchParams.get('session'))
      .toBe(newSession);
    expect(readerPartMatches(adopted, switchedPart, position)).toBe(true);
    // 负对照:没有 sourceSession 的 part(未换源)仍按既有语义拒绝跨源/跨版本内容。
    const plain: ReaderPart = { ...switchedPart, sourceSession: undefined };
    expect(switchedReaderIndex(online, plain)).toBe(online);
    expect(readerPartMatches(online, plain, position)).toBe(false);
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
