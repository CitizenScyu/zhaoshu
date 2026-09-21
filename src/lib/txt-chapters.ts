/**
 * Hard limit for one raw file pulled by the reader (a volume file or a legacy
 * single-file artifact). It is no longer a whole-book limit: reading a chapter
 * costs one volume. The publisher holds the whole book in memory and passes its
 * own larger bound explicitly.
 */
export const MAX_READER_BYTES = 16 * 1024 * 1024;
export const MAX_CHAPTER_PART_BYTES = 32 * 1024;
export const MAX_READER_CHAPTERS = 20_000;

const MAX_TITLE_LINE_BYTES = 320;
const MAX_TITLE_CHARACTERS = 80;

/** Offsets address the original UTF-8 bytes; endByte is exclusive. */
export interface ByteRange {
  startByte: number;
  endByte: number;
}

export interface TxtChapter extends ByteRange {
  index: number;
  title: string;
}

const NUMERALS = '0-9０-９〇零一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億';
const HEADING = new RegExp(
  `^(?:(?:正文[ \\t\\u3000]+)?第[ \\t\\u3000]*[${NUMERALS}]{1,20}[ \\t\\u3000]*[章回节卷部篇集]`
  + '|序章|序言|前言|序|楔子|引子|后记|尾声|终章'
  + `|番外(?:[${NUMERALS}]{1,20})?`
  + '|chapter[ \\t\\u3000]+(?:[0-9０-９]{1,9}|[ivxlcdm]{1,12}))(.*)$',
  'iu',
);
const TITLE_SEPARATOR = /^[ \t\u3000:：、.．\-—]+/u;
const encoder = new TextEncoder();
const TITLE_PREFIXES = new Set(
  Array.from('第序前楔引后尾终番正【', (character) => {
    const bytes = encoder.encode(character);
    return (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  }),
);

/** UTF-8 encodings of ECMAScript whitespace, including a possible BOM. */
function whitespaceWidth(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  if (first === 0x20 || (first >= 0x09 && first <= 0x0d)) return 1;
  if (first < 0xc2) return 0;
  const second = bytes[offset + 1];
  if (first === 0xc2 && second === 0xa0) return 2;
  const third = bytes[offset + 2];
  if (first === 0xe1 && second === 0x9a && third === 0x80) return 3;
  if (first === 0xe2) {
    if (second === 0x80 && ((third >= 0x80 && third <= 0x8a)
      || third === 0xa8 || third === 0xa9 || third === 0xaf)) return 3;
    if (second === 0x81 && third === 0x9f) return 3;
  }
  if (first === 0xe3 && second === 0x80 && third === 0x80) return 3;
  if (first === 0xef && second === 0xbb && third === 0xbf) return 3;
  return 0;
}

function skipWhitespace(bytes: Uint8Array, start: number, end: number): number {
  let offset = start;
  while (offset < end) {
    const width = whitespaceWidth(bytes, offset);
    if (!width) break;
    offset += width;
  }
  return offset;
}

function couldStartTitle(bytes: Uint8Array, offset: number): boolean {
  const first = bytes[offset];
  return first === 0x43 || first === 0x63
    || TITLE_PREFIXES.has((first << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]);
}

function headingTitle(title: string): string | null {
  if (Array.from(title).length > MAX_TITLE_CHARACTERS) return null;
  // The download worker wraps its heading in 【】. Keep the original title so
  // ReaderClient can remove exactly that first line without changing byte offsets.
  const wrapped = title.startsWith('【') && title.endsWith('】');
  const label = wrapped ? title.slice(1, -1).trim() : title;
  const match = HEADING.exec(label);
  if (!match) return null;
  // Explicit delimiters disambiguate worker captions, including periods,
  // semicolons/entities and captions immediately following the chapter number.
  if (wrapped) return title;
  const suffix = match[1];
  if (!suffix) return title;
  // A label must end here or have an explicit separator. In particular,
  // "第一章讲的是……" and a mention in the middle of a sentence are body text.
  if (!TITLE_SEPARATOR.test(suffix)) return null;
  const caption = suffix.replace(TITLE_SEPARATOR, '');
  if (!caption || /[。；;]/u.test(caption) || caption.endsWith('.')) return null;
  return title;
}

function checkBookSize(bytes: Uint8Array, maxBookBytes: number): void {
  if (!Number.isSafeInteger(maxBookBytes) || maxBookBytes < 1) {
    throw new RangeError('TXT 大小上限无效。');
  }
  if (bytes.byteLength > maxBookBytes) {
    // 16 MiB 是读端单文件默认值;发布器传入更大的内存上限,消息随之变化。
    const mib = Math.floor(maxBookBytes / (1024 * 1024));
    throw new RangeError(`暂不支持超过 ${mib} MiB 的 TXT 文件。`);
  }
}

/**
 * Scan LF, CRLF or CR lines without decoding/copying the full book. The caller
 * must validate UTF-8 when loading the bytes (reader-server does this in-stream).
 * Only possible heading lines of at most 320 bytes are decoded; labels are
 * limited to 80 Unicode characters. Headings need a standalone numbered/special
 * label, with whitespace or punctuation separating any caption. Full sentences
 * ending in a period, or containing Chinese full stops/semicolons, stay in body
 * text. This deliberately favors missing an ambiguous title over losing text.
 *
 * For a nonblank book, chapter ranges cover every original byte exactly once.
 * Whitespace/BOM before the first heading stay with that heading; a meaningful
 * prefix becomes "前言". With no headings the book becomes one "正文" chapter.
 * Empty/whitespace-only books return [], and the 20,000 chapter cap includes
 * a generated preface. Source bytes are never mutated or retained by the result.
 *
 * `maxBookBytes` defaults to the reader's single-file bound. The publisher holds
 * the whole book in memory and passes its own larger bound; the scan itself never
 * decodes or copies body text, so a larger bound costs no extra memory.
 */
export function parseTxtChapters(bytes: Uint8Array, maxBookBytes = MAX_READER_BYTES): TxtChapter[] {
  checkBookSize(bytes, maxBookBytes);
  const firstContentByte = skipWhitespace(bytes, 0, bytes.byteLength);
  if (firstContentByte === bytes.byteLength) return [];

  const chapters: TxtChapter[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function append(title: string, startByte: number): void {
    if (chapters.length >= MAX_READER_CHAPTERS) {
      throw new RangeError(`TXT 章节数量超过 ${MAX_READER_CHAPTERS}，暂时无法生成目录。`);
    }
    if (chapters.length) chapters[chapters.length - 1].endByte = startByte;
    chapters.push({ index: chapters.length, title, startByte, endByte: bytes.byteLength });
  }

  function visitLine(start: number, end: number): void {
    if (start === end || end - start > MAX_TITLE_LINE_BYTES) return;
    const contentStart = skipWhitespace(bytes, start, end);
    if (contentStart === end || !couldStartTitle(bytes, contentStart)) return;
    const title = headingTitle(decoder.decode(bytes.subarray(contentStart, end)).trim());
    if (!title) return;
    if (!chapters.length && firstContentByte < start) append('前言', 0);
    append(title, chapters.length ? start : 0);
  }

  let lineStart = 0;
  for (let offset = 0; offset < bytes.byteLength; offset++) {
    if (bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) continue;
    visitLine(lineStart, offset);
    if (bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a) offset++;
    lineStart = offset + 1;
  }
  visitLine(lineStart, bytes.byteLength);
  if (!chapters.length) append('正文', 0);
  return chapters;
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Bound every response, including an unmarked book or a very large chapter.
 * Prefer a line break in the latter half of a part; otherwise cut at a UTF-8
 * code-point boundary. CRLF pairs are kept together. The optional smaller limit
 * is useful for other bounded consumers; limits below one UTF-8 scalar (4 bytes)
 * or above the reader's 32 KiB response budget are rejected.
 *
 * `maxBookBytes` mirrors `parseTxtChapters`: a slice of a large book (for example
 * one volume) must not be rejected just because the whole book exceeds the reader
 * bound; the publisher passes its own bound the same way.
 */
export function splitChapterParts(
  bytes: Uint8Array,
  chapter: ByteRange,
  maxPartBytes = MAX_CHAPTER_PART_BYTES,
  maxBookBytes = MAX_READER_BYTES,
): ByteRange[] {
  checkBookSize(bytes, maxBookBytes);
  const { startByte, endByte } = chapter;
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)
    || startByte < 0 || endByte < startByte || endByte > bytes.byteLength
    || (startByte < bytes.byteLength && isContinuationByte(bytes[startByte]))
    || (endByte < bytes.byteLength && isContinuationByte(bytes[endByte]))) {
    throw new RangeError('TXT 章节字节范围无效。');
  }
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 4
    || maxPartBytes > MAX_CHAPTER_PART_BYTES) {
    throw new RangeError('TXT 分段大小必须在 4 到 32768 字节之间。');
  }

  const parts: ByteRange[] = [];
  let start = startByte;
  while (start < endByte) {
    let end = Math.min(start + maxPartBytes, endByte);
    if (end < endByte) {
      while (end > start && isContinuationByte(bytes[end])) end--;
      if (end === start) throw new RangeError('TXT 需要使用 UTF-8 编码。');
      if (bytes[end - 1] === 0x0d && bytes[end] === 0x0a) end--;
      const preferAfter = start + Math.floor(maxPartBytes / 2);
      for (let offset = end - 1; offset >= preferAfter; offset--) {
        if (bytes[offset] === 0x0a || bytes[offset] === 0x0d) {
          end = offset + 1;
          break;
        }
      }
    }
    parts.push({ startByte: start, endByte: end });
    start = end;
  }
  return parts;
}
