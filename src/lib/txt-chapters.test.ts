import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_CHAPTER_PART_BYTES,
  MAX_READER_BYTES,
  MAX_READER_CHAPTERS,
  parseTxtChapters,
  splitChapterParts,
} from './txt-chapters';
import type { ByteRange } from './txt-chapters';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function expectCoverage(bytes: Uint8Array, ranges: ByteRange[], start = 0, end = bytes.length) {
  expect(ranges[0]?.startByte).toBe(start);
  expect(ranges.at(-1)?.endByte).toBe(end);
  let next = start;
  for (const range of ranges) {
    expect(range.startByte).toBe(next);
    expect(range.endByte).toBeGreaterThan(range.startByte);
    // Invalid code-point cuts throw instead of silently inserting replacement characters.
    expect(() => decode(bytes.subarray(range.startByte, range.endByte))).not.toThrow();
    next = range.endByte;
  }
  expect(Buffer.concat(ranges.map(({ startByte, endByte }) => bytes.subarray(startByte, endByte)))
    .equals(Buffer.from(bytes.subarray(start, end)))).toBe(true);
}

describe('parseTxtChapters', () => {
  it('indexes the worker TXT format including book metadata and preserves every original byte', () => {
    // Same title/author prefix, wrapped headings and paragraph separators as worker.mjs.
    const bytes = readFileSync(new URL('./fixtures/worker-book.txt', import.meta.url));
    const chapters = parseTxtChapters(bytes);
    expect(chapters.map(({ title }) => title)).toEqual(['前言', '【第一章 夜行。】', '【第2章：消息】', '【尾声】']);
    expectCoverage(bytes, chapters);
    for (const chapter of chapters) expectCoverage(bytes, splitChapterParts(bytes, chapter, 32), chapter.startByte, chapter.endByte);
    for (const chapter of chapters.slice(1)) {
      const firstLine = decode(bytes.subarray(chapter.startByte, chapter.endByte)).split(/\r?\n/)[0];
      expect(firstLine).toBe(chapter.title); // ReaderClient's heading de-duplication contract.
    }
  });

  it.each(['第一章 起点', '第２回：来信', 'Chapter IV — Return', '番外三 假期', '序章', '第1章 论坛里的鬼故事。', '第115章 布鲁斯&middot;皮', '第一章起点'])
    ('recognizes a worker-wrapped heading with CRLF: %s', (label) => {
      const bytes = encode(`【${label}】\r\n\r\n正文。`);
      expect(parseTxtChapters(bytes)).toEqual([{ index: 0, title: `【${label}】`, startByte: 0, endByte: bytes.length }]);
    });

  it.each(['【第一章 起点', '【第一章 起点】之后仍是正文', '【系统消息】', '【他说第一章讲的是正文。】'])
    ('does not mistake bracketed body text for a heading: %s', (text) => {
      expect(parseTxtChapters(encode(text + '\n普通正文。'))[0].title).toBe('正文');
    });

  it('preserves Chinese byte offsets, BOM, preface, CRLF and the final unterminated line', () => {
    const source = '\uFEFF这是一段书前说明。\r\n\r\n第一章 初遇\r\n中文与 😀 的正文。\r\n\r\n第二回：夜访\r\n最后一行';
    const bytes = encode(source);
    const first = Buffer.from(bytes).indexOf('第一章');
    const second = Buffer.from(bytes).indexOf('第二回');
    const chapters = parseTxtChapters(bytes);

    expect(chapters).toEqual([
      { index: 0, title: '前言', startByte: 0, endByte: first },
      { index: 1, title: '第一章 初遇', startByte: first, endByte: second },
      { index: 2, title: '第二回：夜访', startByte: second, endByte: bytes.length },
    ]);
    expectCoverage(bytes, chapters);
  });

  it.each([
    '第零章 起点',
    '第〇一章 风雪',
    '第一百零二回 山海',
    '第两千零三章 归来',
    '第壹佰贰拾章 别来无恙',
    '第１２０章 全角数字',
    '第42节: 清风',
    '第 12 章 — 空格',
    '正文 第十卷 风起',
    'Chapter 12: A beginning',
    'CHAPTER IV — Return',
    '番外三 假期',
    '序章',
    '楔子',
    '终章 再会？',
  ])('recognizes a standalone short heading: %s', (title) => {
    const bytes = encode(`${title}\n这里是正文。`);
    expect(parseTxtChapters(bytes)).toEqual([
      { index: 0, title, startByte: 0, endByte: bytes.length },
    ]);
  });

  it('handles adjacent chapter labels and LF, CRLF and CR without losing separators', () => {
    const bytes = encode('第一章\n第二章\r\n第三章\r第四章');
    const chapters = parseTxtChapters(bytes);
    expect(chapters.map(({ title, index }) => [index, title])).toEqual([
      [0, '第一章'], [1, '第二章'], [2, '第三章'], [3, '第四章'],
    ]);
    expect(chapters.map(({ startByte, endByte }) => decode(bytes.subarray(startByte, endByte))))
      .toEqual(['第一章\n', '第二章\r\n', '第三章\r', '第四章']);
    expectCoverage(bytes, chapters);
  });

  it('folds only whitespace and BOM before a heading into its original range', () => {
    const bytes = encode('\uFEFF\r\n \t\u3000\n\u3000第一章 初遇  \r\n正文\r\n  \t');
    expect(parseTxtChapters(bytes)).toEqual([
      { index: 0, title: '第一章 初遇', startByte: 0, endByte: bytes.length },
    ]);
    expectCoverage(bytes, parseTxtChapters(bytes));
  });

  it.each(['', '\uFEFF', '\uFEFF \t\r\n\u3000', '\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f'])
    ('returns no chapters for an empty or whitespace-only TXT (%j)', (source) => {
      expect(parseTxtChapters(encode(source))).toEqual([]);
    });

  it('uses a single complete body chapter for unmarked text and ordinary chapter mentions', () => {
    const source = [
      '他读到了第一章。',
      '第一章讲述了人物的过往。',
      '第一章，故事从这里开始。',
      '第1章 讲的是前面那件事。',
      '第一章 只是举例；这还是正文',
      'Chapter 1 is where the story begins.',
      '序言中的这句话并不是标题。',
      '最后还有一行没有换行',
    ].join('\n');
    const bytes = encode(source);
    expect(parseTxtChapters(bytes)).toEqual([
      { index: 0, title: '正文', startByte: 0, endByte: bytes.length },
    ]);
  });

  it('keeps overlong heading-like lines as body and still discovers subsequent titles', () => {
    const source = `第一章 ${'长'.repeat(100)}\n第二章 ${'字'.repeat(300_000)}\n第三章 短标题\n正文`;
    const bytes = encode(source);
    const chapters = parseTxtChapters(bytes);
    expect(chapters.map(({ title }) => title)).toEqual(['前言', '第三章 短标题']);
    expect(chapters[1].startByte).toBe(Buffer.from(bytes).indexOf('第三章'));
    expectCoverage(bytes, chapters);
  });

  it('limits directory metadata instead of allocating a chapter for every malicious line', () => {
    const bytes = encode('第一章\n'.repeat(MAX_READER_CHAPTERS));
    const chapters = parseTxtChapters(bytes);
    expect(chapters).toHaveLength(MAX_READER_CHAPTERS);
    expect(chapters.at(-1)?.index).toBe(MAX_READER_CHAPTERS - 1);
    expect(chapters.at(-1)?.endByte).toBe(bytes.length);
    expect(() => parseTxtChapters(encode('第一章\n'.repeat(MAX_READER_CHAPTERS + 1))))
      .toThrow(new RangeError('TXT 章节数量超过 10000，暂时无法生成目录。'));
    expect(() => parseTxtChapters(encode(`书前说明\n${'第一章\n'.repeat(MAX_READER_CHAPTERS)}`)))
      .toThrow(RangeError);
  });

  it('supports the full 16 MiB bound without decoding a full unmarked book', () => {
    const bytes = new Uint8Array(MAX_READER_BYTES).fill(0x61);
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    let chapters;
    try {
      chapters = parseTxtChapters(bytes);
      expect(decodeSpy).not.toHaveBeenCalled();
    } finally {
      decodeSpy.mockRestore();
    }
    expect(chapters).toEqual([{ index: 0, title: '正文', startByte: 0, endByte: bytes.length }]);
    const parts = splitChapterParts(bytes, chapters[0]);
    expect(parts).toHaveLength(MAX_READER_BYTES / MAX_CHAPTER_PART_BYTES);
    expect(parts.every(({ startByte, endByte }) => endByte - startByte <= MAX_CHAPTER_PART_BYTES)).toBe(true);
    expectCoverage(bytes, parts);
  });

  it('rejects oversized books before attempting to decode or scan them', () => {
    expect(() => parseTxtChapters(new Uint8Array(MAX_READER_BYTES + 1)))
      .toThrow(new RangeError('暂不支持超过 16 MiB 的 TXT 文件。'));
  });

  it('decodes only short heading candidates, even when most lines are body text', () => {
    const bytes = encode(`第一章 初遇\n${'这是一行普通正文。\n'.repeat(30_000)}第二章 重逢\n${'很长的正文'.repeat(100_000)}`);
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      expect(parseTxtChapters(bytes).map(({ title }) => title)).toEqual(['第一章 初遇', '第二章 重逢']);
      expect(decodeSpy).toHaveBeenCalledTimes(2);
      for (const [input] of decodeSpy.mock.calls) {
        expect(input?.byteLength).toBeLessThanOrEqual(320);
      }
    } finally {
      decodeSpy.mockRestore();
    }
  });
});

describe('splitChapterParts', () => {
  it('keeps short chapters in one part and respects a chapter range within the book', () => {
    const bytes = encode('第一章 开篇\n正文 😀\n第二章 继续\n最后一行');
    const chapters = parseTxtChapters(bytes);
    for (const chapter of chapters) {
      const parts = splitChapterParts(bytes, chapter);
      expect(parts).toEqual([{ startByte: chapter.startByte, endByte: chapter.endByte }]);
      expectCoverage(bytes, parts, chapter.startByte, chapter.endByte);
    }
  });

  it.each(Array.from({ length: 14 }, (_, index) => index + 4))
    ('preserves CJK, four-byte characters, emoji and CRLF for %i-byte parts', (maxPartBytes) => {
      const source = '中a😀𠮷\r\n文b🧭\r甲\n乙'.repeat(20);
      const bytes = encode(source);
      const parts = splitChapterParts(bytes, { startByte: 0, endByte: bytes.length }, maxPartBytes);
      expectCoverage(bytes, parts);
      expect(parts.map(({ startByte, endByte }) => decode(bytes.subarray(startByte, endByte))).join(''))
        .toBe(source);
      for (const { startByte, endByte } of parts) {
        expect(endByte - startByte).toBeLessThanOrEqual(maxPartBytes);
        expect(bytes[endByte - 1] === 0x0d && bytes[endByte] === 0x0a).toBe(false);
      }
    });

  it('prefers a complete newline in the latter half of a response', () => {
    const bytes = encode('123456789\r\nabcdefghijklmnop');
    const parts = splitChapterParts(bytes, { startByte: 0, endByte: bytes.length }, 16);
    expect(parts[0]).toEqual({ startByte: 0, endByte: 11 });
    expectCoverage(bytes, parts);
  });

  it('moves a hard boundary before a CRLF pair', () => {
    const bytes = encode('abc\r\ndefgh');
    const parts = splitChapterParts(bytes, { startByte: 0, endByte: bytes.length }, 4);
    expect(parts[0]).toEqual({ startByte: 0, endByte: 3 });
    expectCoverage(bytes, parts);
    expect(parts.every(({ endByte }) => !(bytes[endByte - 1] === 13 && bytes[endByte] === 10))).toBe(true);
  });

  it('bounds an enormous single marked chapter even with no body line breaks', () => {
    const bytes = encode(`第一章 长篇\n${'😀中文𠮷'.repeat(120_000)}`);
    const chapters = parseTxtChapters(bytes);
    expect(chapters).toHaveLength(1);
    const parts = splitChapterParts(bytes, chapters[0]);
    expect(parts.length).toBeGreaterThan(20);
    expect(parts.every(({ startByte, endByte }) => endByte - startByte <= MAX_CHAPTER_PART_BYTES)).toBe(true);
    expectCoverage(bytes, parts);
  });

  it('returns no parts for an empty range', () => {
    expect(splitChapterParts(new Uint8Array(), { startByte: 0, endByte: 0 })).toEqual([]);
  });

  it.each([
    [-1, 2], [0, 99], [2, 1], [0.5, 1], [0, Number.NaN], [0, Number.POSITIVE_INFINITY], [1, 4], [0, 2],
  ])('rejects invalid or misaligned byte ranges (%s, %s)', (startByte, endByte) => {
    expect(() => splitChapterParts(encode('中😀'), { startByte, endByte })).toThrow(RangeError);
  });

  it.each([0, 1, 3, 4.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CHAPTER_PART_BYTES + 1])
    ('rejects an unsafe part size (%s)', (maxPartBytes) => {
      expect(() => splitChapterParts(encode('正文'), { startByte: 0, endByte: 6 }, maxPartBytes))
        .toThrow(RangeError);
    });
});
