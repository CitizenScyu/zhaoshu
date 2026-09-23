import { describe, expect, it } from 'vitest';
import { bookReadingHref, readerChapterUrl, readerIndexUrl, readerPartMatches, readingSessionKey, switchedReaderIndex } from './reader-session';
import { indexProgressKey, readingPercent, parseReadingProgress } from './reader-preferences';
import { nextReadingPosition } from './reader-part-cache';
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

  // H7:换源后前端必须改用**新目录**。备用站目录是 [序言, 第一章, 第二章],
  // 旧实现保留旧 chapters(只有 [第一章, 第二章]),下一章按「旧序号 +1 = 1」请求,
  // 打到新目录的序号 1 —— 那是「第一章」,于是静默交付重复章。
  it('H7:换源附带新目录时替换 chapters,下一章请求落在新目录的第二章而不是重复的第一章', () => {
    const newSession = 'b'.repeat(40);
    const oldCatalog: ReaderIndex = {
      ...online,
      chapters: [
        { index: 0, title: '第一章', startByte: 0, endByte: 0, partCount: 1 },
        { index: 1, title: '第二章', startByte: 0, endByte: 0, partCount: 1 },
      ],
    };
    const newChapters = [
      { index: 0, title: '序言', startByte: 0, endByte: 0, partCount: 1 },
      { index: 1, title: '第一章', startByte: 0, endByte: 0, partCount: 1 },
      { index: 2, title: '第二章', startByte: 0, endByte: 0, partCount: 1 },
    ];
    const switchedPart: ReaderPart = {
      taskId: null, sourceId: 'source-two', servedFrom: '备用源',
      version: newSession, sourceSession: newSession,
      chapterIndex: 0, partIndex: 0, partCount: 1, title: '第一章', text: '备用源第一章', startByte: 0, endByte: 18,
      switchedChapters: newChapters, switchedChapterIndex: 1,
    };
    const adopted = switchedReaderIndex(oldCatalog, switchedPart);
    expect(adopted.chapters.map((chapter) => chapter.title)).toEqual(['序言', '第一章', '第二章']);
    // 当前位置迁到服务端给的新序号 1;之后的「下一章」必须是新目录序号 2(第二章)。
    const here = { chapterIndex: switchedPart.switchedChapterIndex!, partIndex: 0, ratio: 0 };
    const next = nextReadingPosition(adopted, here);
    expect(next?.chapterIndex).toBe(2);
    expect(adopted.chapters[next!.chapterIndex].title).toBe('第二章');
    expect(new URL(readerChapterUrl(adopted, next!), 'http://localhost').searchParams.get('chapter')).toBe('2');
  });

  it('H7:旧响应形状(不带新目录)时 chapters 原样保留', () => {
    const newSession = 'c'.repeat(40);
    const bare: ReaderPart = {
      ...position, taskId: null, sourceId: 'source-two', version: newSession, sourceSession: newSession,
      partCount: 1, title: '第一章', text: '正文', startByte: 0, endByte: 6,
    };
    expect(switchedReaderIndex(online, bare).chapters).toBe(online.chapters);
  });

  it('H7:switched 状态下标题与目录不符 ⇒ readerPartMatches 为 false(不交付错章)', () => {
    const newSession = 'd'.repeat(40);
    // 客户端仍持**旧目录**(旧响应形状:换了 session 但 chapters 没换),以为序号 0 是「第一章」。
    const stale: ReaderIndex = {
      ...online, version: newSession,
      source: { ...online.source!, id: 'source-two', session: newSession },
    };
    // 服务端按新目录取回序号 0 —— 那是备用目录的「序言」,标题对不上 ⇒ 不放行。
    const wrongChapter: ReaderPart = {
      taskId: null, sourceId: 'source-two', version: newSession, sourceSession: newSession,
      chapterIndex: 0, partIndex: 0, partCount: 1, title: '序言', text: '序言正文', startByte: 0, endByte: 12,
    };
    expect(readerPartMatches(stale, wrongChapter, position)).toBe(false);
    // 标题对得上(写法差异按归一化口径折叠)时仍放行。
    const rightChapter: ReaderPart = { ...wrongChapter, title: '第1章' };
    expect(readerPartMatches(stale, rightChapter, position)).toBe(true);
    // 未换源的响应不受标题比对影响(既有语义不变)。
    const plain: ReaderPart = { ...wrongChapter, sourceSession: undefined, version: online.version, sourceId: online.source!.id, title: '完全不同的标题' };
    expect(readerPartMatches(online, plain, position)).toBe(true);
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
