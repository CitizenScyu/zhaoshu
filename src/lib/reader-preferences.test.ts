import { describe, expect, it } from 'vitest';
import { DEFAULT_READER_SETTINGS, parseReaderSettings, parseReadingProgress, readingPercent, readingProgressKey } from './reader-preferences';
import type { ReaderIndex, ReaderPart } from './reader-types';

const index: ReaderIndex = {
  taskId: 42, title: '测试书', author: '作者', version: 'a'.repeat(40), totalBytes: 10_000,
  chapters: [
    { index: 0, title: '第一章', startByte: 0, endByte: 1000, partCount: 1 },
    { index: 1, title: '第二章', startByte: 1000, endByte: 10_000, partCount: 3 },
  ],
};
const saved = { schema: 1, version: index.version, chapterIndex: 1, partIndex: 2, ratio: 0.45, updatedAt: 1234 };

describe('reader preferences and resume positions', () => {
  it.each([null, '', '{broken', 'null', '[]', '42'])('recovers defaults from invalid storage: %s', (raw) => {
    expect(parseReaderSettings(raw)).toEqual(DEFAULT_READER_SETTINGS);
    expect(parseReadingProgress(raw, index)).toBeNull();
  });

  it('bounds font sizes, validates line spacing, and ignores arbitrary theme names', () => {
    expect(parseReaderSettings('{"fontSize":200,"lineHeight":0,"theme":"url(evil)"}'))
      .toEqual({ fontSize: 30, lineHeight: 1.9, theme: 'day' });
    expect(parseReaderSettings('{"fontSize":10,"lineHeight":2.2,"theme":"night"}'))
      .toEqual({ fontSize: 16, lineHeight: 2.2, theme: 'night' });
    expect(parseReaderSettings('{"fontSize":22,"lineHeight":1.6,"theme":"sage"}'))
      .toEqual({ fontSize: 22, lineHeight: 1.6, theme: 'sage' });
  });

  it('resumes the exact chapter, section, and relative scroll position', () => {
    expect(parseReadingProgress(JSON.stringify(saved), index)).toEqual(saved);
    expect(readingProgressKey(42)).toBe('novel-finder-reading-progress-42');
    expect(readingProgressKey(43)).not.toBe(readingProgressKey(42));
  });

  it.each([
    { schema: 2 }, { version: 'b'.repeat(40) }, { chapterIndex: -1 }, { chapterIndex: 2 },
    { chapterIndex: 0.5 }, { chapterIndex: '1' }, { partIndex: -1 }, { partIndex: 3 },
    { partIndex: 0.5 }, { ratio: '0.5' }, { updatedAt: null },
  ])('rejects stale or invalid saved positions: %j', (change) => {
    expect(parseReadingProgress(JSON.stringify({ ...saved, ...change }), index)).toBeNull();
  });

  it('clamps a saved scroll position when the viewport changes', () => {
    expect(parseReadingProgress(JSON.stringify({ ...saved, ratio: 1.1 }), index)?.ratio).toBe(1);
    expect(parseReadingProgress(JSON.stringify({ ...saved, ratio: -0.1 }), index)?.ratio).toBe(0);
  });

  it('weights progress by bytes and reaches 100% only at the end of the file', () => {
    const part = { startByte: 7000, endByte: 10_000 } as ReaderPart;
    expect(readingPercent(index, part, 0)).toBe(70);
    expect(readingPercent(index, part, 0.5)).toBe(85);
    expect(readingPercent(index, part, 1)).toBe(100);
  });
});
