import type { ReaderIndex, ReaderPart } from '@/lib/reader-types';
import { userIndexProgressKey, userReadingProgressKey } from '@/lib/user-scope';

// 设置类数据（字号 / 纸色 / 字体）不承载身份，可以作为本机设置共享。
export const READER_SETTINGS_KEY = 'novel-finder-reading-settings';
// 阅读进度是私人数据：键必须带 userId（设计 §6.4）。
export const readingProgressKey = (taskId: number, userId: number) => userReadingProgressKey(userId, taskId);
export const indexProgressKey = (index: ReaderIndex, userId: number) => userIndexProgressKey(index, userId);

export type ReaderTheme = 'day' | 'night' | 'sage';
export type ReaderFont = 'wenkai' | 'serif' | 'sans';
export type ReaderWidth = 'narrow' | 'standard' | 'wide';

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  theme: ReaderTheme;
  font: ReaderFont;
  width: ReaderWidth;
  continuous: boolean;
  preloadNext: boolean;
}

export interface ReadingPosition {
  chapterIndex: number;
  partIndex: number;
  ratio: number;
  textOffset?: number;
  viewportOffset?: number;
}

export interface ReadingProgress extends ReadingPosition {
  schema: 1;
  version: string;
  updatedAt: number;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 20, lineHeight: 1.9, theme: 'day', font: 'wenkai', width: 'standard',
  continuous: true, preloadNext: true,
};

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
    font: value?.font === 'serif' || value?.font === 'sans' ? value.font : 'wenkai',
    width: value?.width === 'narrow' || value?.width === 'wide' ? value.width : 'standard',
    continuous: typeof value?.continuous === 'boolean' ? value.continuous : true,
    preloadNext: typeof value?.preloadNext === 'boolean' ? value.preloadNext : true,
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
    ...(typeof value.textOffset === 'number' && Number.isSafeInteger(value.textOffset)
      && value.textOffset >= 0 && value.textOffset <= 32768
      && typeof value.viewportOffset === 'number' && Number.isFinite(value.viewportOffset)
      ? { textOffset: value.textOffset, viewportOffset: Math.max(-256, Math.min(256, value.viewportOffset)) } : {}),
    updatedAt: value.updatedAt,
  };
}

/** Byte-weighted estimate; chapter lengths can differ by several orders of magnitude. */
export function readingPercent(index: ReaderIndex, part: ReaderPart, ratio: number): number {
  if (index.source) {
    if (!index.chapters.length) return 0;
    return Math.max(0, Math.min(100, (part.chapterIndex + Math.max(0, Math.min(1, ratio))) / index.chapters.length * 100));
  }
  if (index.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100,
    (part.startByte + (part.endByte - part.startByte) * Math.max(0, Math.min(1, ratio)))
      / index.totalBytes * 100));
}
