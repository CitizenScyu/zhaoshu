import type { ReaderIndex, ReaderPart } from '@/lib/reader-types';

export const READER_SETTINGS_KEY = 'novel-finder-reading-settings';
export const readingProgressKey = (taskId: number) => `novel-finder-reading-progress-${taskId}`;

export type ReaderTheme = 'day' | 'night' | 'sage';

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  theme: ReaderTheme;
}

export interface ReadingPosition {
  chapterIndex: number;
  partIndex: number;
  ratio: number;
}

export interface ReadingProgress extends ReadingPosition {
  schema: 1;
  version: string;
  updatedAt: number;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = { fontSize: 20, lineHeight: 1.9, theme: 'day' };

function parseObject(raw: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseReaderSettings(raw: string | null): ReaderSettings {
  const value = parseObject(raw);
  return {
    fontSize: typeof value?.fontSize === 'number' && Number.isFinite(value.fontSize)
      ? Math.max(16, Math.min(30, Math.round(value.fontSize))) : DEFAULT_READER_SETTINGS.fontSize,
    lineHeight: typeof value?.lineHeight === 'number' && [1.6, 1.9, 2.2].includes(value.lineHeight)
      ? value.lineHeight : DEFAULT_READER_SETTINGS.lineHeight,
    theme: value?.theme === 'night' || value?.theme === 'sage' ? value.theme : 'day',
  };
}

/** Ignore stale revisions and invalid positions rather than silently opening another chapter. */
export function parseReadingProgress(raw: string | null, index: ReaderIndex): ReadingProgress | null {
  const value = parseObject(raw);
  if (!value || value.schema !== 1 || value.version !== index.version
    || !Number.isSafeInteger(value.chapterIndex) || !Number.isSafeInteger(value.partIndex)
    || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  const chapterIndex = value.chapterIndex as number;
  const partIndex = value.partIndex as number;
  const chapter = index.chapters[chapterIndex];
  if (!chapter || partIndex < 0 || partIndex >= chapter.partCount) return null;
  return {
    schema: 1,
    version: index.version,
    chapterIndex,
    partIndex,
    ratio: Math.max(0, Math.min(1, value.ratio)),
    updatedAt: value.updatedAt,
  };
}

/** Byte-weighted estimate; chapter lengths can differ by several orders of magnitude. */
export function readingPercent(index: ReaderIndex, part: ReaderPart, ratio: number): number {
  if (index.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100,
    (part.startByte + (part.endByte - part.startByte) * Math.max(0, Math.min(1, ratio)))
      / index.totalBytes * 100));
}
