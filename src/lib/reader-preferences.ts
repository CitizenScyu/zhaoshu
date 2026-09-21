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
  /**
   * 在线目录的稳定章节键（章节标题）。下载类不写：字节区间语义下换本等于换代。
   * 目录追加只让 version 变，本键用于证明「进度指向的还是同一章」。
   */
  chapterTitle?: string;
  /** 目录前缀 [0..chapterIndex] 的标题指纹，用于证明纯追加（详见 catalogPrefixKey）。 */
  catalogPrefix?: string;
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

const CATALOG_KEY_MAX = 512;
const PREFIX_KEY_MAX = 64;

/**
 * 目录前缀指纹：把 [0..chapterIndex] 的章节标题按序混入两个独立的 32 位哈希，并带上前缀长度。
 * 只有在「读取位置之前的标题序列逐字未变、变化只发生在该位置之后」时新旧指纹才相等。
 * 这是在不保存整份旧目录、也不改 ReaderIndex / ReaderChapter 形状的前提下，对「纯追加」
 * 能做的最强证明；仅靠「新目录更长」不能证明原章位置未被打乱，因此必须比指纹。
 */
export function catalogPrefixKey(index: ReaderIndex, chapterIndex: number): string {
  const end = chapterIndex + 1;
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < end; i++) {
    const title = index.chapters[i]?.title ?? '';
    for (let j = 0; j < title.length; j++) {
      const code = title.charCodeAt(j);
      a = Math.imul(a ^ code, 0x01000193);
      b = (Math.imul(b, 33) + code) | 0;
    }
    // 分隔符：避免 ['ab','c'] 与 ['a','bc'] 拼出同一指纹。
    a = Math.imul(a ^ 0x1f, 0x01000193);
    b = (Math.imul(b, 33) + 0x1f) | 0;
  }
  return `${end}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/** 稳定章节键与前缀指纹只在目录可增长（在线源 taskId=null）时才有意义。 */
function onlineCatalogKey(value: Record<string, unknown>, index: ReaderIndex): Pick<ReadingProgress, 'chapterTitle' | 'catalogPrefix'> | null {
  if (index.taskId !== null || !index.source) return null;
  const { chapterTitle, catalogPrefix } = value;
  if (typeof chapterTitle !== 'string' || !chapterTitle || chapterTitle.length > CATALOG_KEY_MAX) return null;
  if (typeof catalogPrefix !== 'string' || !catalogPrefix || catalogPrefix.length > PREFIX_KEY_MAX) return null;
  return { chapterTitle, catalogPrefix };
}

/** 可选文本锚点：非法时退化为纯比例定位（保持既有语义）。 */
function anchorFields(value: Record<string, unknown>): Pick<ReadingProgress, 'textOffset' | 'viewportOffset'> | Record<string, never> {
  return typeof value.textOffset === 'number' && Number.isSafeInteger(value.textOffset)
    && value.textOffset >= 0 && value.textOffset <= 32768
    && typeof value.viewportOffset === 'number' && Number.isFinite(value.viewportOffset)
    ? { textOffset: value.textOffset, viewportOffset: Math.max(-256, Math.min(256, value.viewportOffset)) } : {};
}

/** Ignore stale revisions and invalid positions rather than silently opening another chapter. */
export function parseReadingProgress(raw: string | null, index: ReaderIndex): ReadingProgress | null {
  const value = parseObject(raw);
  if (!value || value.schema !== 1
    || !Number.isSafeInteger(value.chapterIndex) || !Number.isSafeInteger(value.partIndex)
    || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  const chapterIndex = value.chapterIndex as number;
  const partIndex = value.partIndex as number;

  if (value.version !== index.version) {
    // 目录版本变了：只有能证明「读取位置及其之前逐字未变、变化只在其后」才迁移。
    // 下载类（taskId≠null）不迁移，保持既有「版本不符即失效」的文件保护。
    const key = onlineCatalogKey(value, index);
    if (!key) return null;
    const chapter = index.chapters[chapterIndex];
    // 同索引处标题必须一致，且该标题在新目录里唯一 —— 否则可能指向别的同名章。
    if (!chapter || chapter.title !== key.chapterTitle) return null;
    if (index.chapters.filter(candidate => candidate.title === key.chapterTitle).length !== 1) return null;
    // 前缀指纹相等 = 保存进度时 [0..chapterIndex] 的标题序列逐字未变（只有尾部追加能成立）。
    if (catalogPrefixKey(index, chapterIndex) !== key.catalogPrefix) return null;
    if (partIndex < 0 || partIndex >= chapter.partCount) return null;
    return {
      schema: 1,
      version: index.version,
      chapterIndex,
      partIndex,
      ratio: Math.max(0, Math.min(1, value.ratio)),
      ...anchorFields(value),
      ...key,
      updatedAt: value.updatedAt,
    };
  }

  const chapter = index.chapters[chapterIndex];
  if (!chapter || partIndex < 0 || partIndex >= chapter.partCount) return null;
  return {
    schema: 1,
    version: index.version,
    chapterIndex,
    partIndex,
    ratio: Math.max(0, Math.min(1, value.ratio)),
    ...anchorFields(value),
    ...(onlineCatalogKey(value, index) ?? {}),
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

// ---- M3 手动换源:跨源进度迁移(设计 §5) ----

// 客户端章标题归一化:**直接复用** `source-parser.ts` 的 `normalizeChapterTitle`
// (NFKC / trim / 去全角书名号 / 去空白 / 小写 / 章号折叠「第一章」=「第1章」/ 去尾部标点),
// 不在客户端再写第二套折叠逻辑,避免两份实现漂移(复审 P1-1)。
// source-parser 的依赖链(source-policy / supported-sources 均 client-safe,db 仅动态 import)
// 可安全静态 import 进客户端包;测试文件同时 import 两边做一致性钉死。
import { normalizeChapterTitle } from './source-parser';
export { normalizeChapterTitle };

/** 比例估算:按旧目录相对位置映射到新目录索引(边界 clamp)。 */
function estimateIndex(oldChapterIndex: number, oldTotal: number, newTotal: number): number {
  if (newTotal <= 0) return 0;
  if (oldTotal <= 1) return 0;
  return Math.max(0, Math.min(newTotal - 1,
    Math.round(oldChapterIndex / (oldTotal - 1) * (newTotal - 1))));
}

/** 归一化标题在新目录里的全部匹配索引。 */
function matchingIndexes(index: ReaderIndex, title: string): number[] {
  const key = normalizeChapterTitle(title);
  const hits: number[] = [];
  for (let i = 0; i < index.chapters.length; i++) {
    if (normalizeChapterTitle(index.chapters[i].title) === key) hits.push(i);
  }
  return hits;
}

/**
 * 跨源进度迁移(设计 §5 三级保守回退,never silently 跳到明显错误的章):
 * 1) 标题锚定(唯一匹配 ⇒ exact;重复章名按序号邻近度破平 ⇒ estimated)
 * 2) 邻章锚定(旧目录 chapterIndex±1 唯一匹配 ⇒ 推算目标 ⇒ estimated)
 * 3) 比例回退(estimated);全失败 ⇒ null。
 * 产出只给 ReadingPosition:partIndex=0(在线目录恒单 part)、ratio 保留并 clamp、
 * **丢弃 textOffset/viewportOffset**(字符锚点绑定具体正文,跨源必错);
 * version/chapterTitle/catalogPrefix 由调用方按新目录重写(与 capturePosition 写入口径一致)。
 */
export function migrateProgressAcrossSources(
  old: ReadingProgress, oldIndex: ReaderIndex, newIndex: ReaderIndex,
): { position: ReadingPosition; confidence: 'exact' | 'estimated' } | null {
  if (!newIndex.chapters.length) return null;
  const oldTotal = oldIndex.chapters.length;
  const newTotal = newIndex.chapters.length;
  const ratio = Math.max(0, Math.min(1, old.ratio));
  const estimate = estimateIndex(old.chapterIndex, oldTotal, newTotal);
  // 空标题不是有效锚点(parseReadingProgress 同样把空 chapterTitle 判为无键)⇒ 退回旧目录索引标题。
  const anchor = old.chapterTitle || oldIndex.chapters[old.chapterIndex]?.title;
  if (anchor) {
    const hits = matchingIndexes(newIndex, anchor);
    if (hits.length === 1) return { position: { chapterIndex: hits[0], partIndex: 0, ratio }, confidence: 'exact' };
    if (hits.length > 1) {
      const best = hits.reduce((a, b) => Math.abs(a - estimate) <= Math.abs(b - estimate) ? a : b);
      return { position: { chapterIndex: best, partIndex: 0, ratio }, confidence: 'estimated' };
    }
    // 邻章锚定:当前章标题在新源不存在时,看旧目录 ±1 两章是否有唯一匹配。
    const derived: number[] = [];
    for (const offset of [-1, 1] as const) {
      const neighborTitle = oldIndex.chapters[old.chapterIndex + offset]?.title;
      if (!neighborTitle) continue;
      const hits2 = matchingIndexes(newIndex, neighborTitle);
      // 邻章在新目录的索引 = 目标 ∓ offset;故目标 = 新索引 − offset。
      if (hits2.length === 1) derived.push(Math.max(0, Math.min(newTotal - 1, hits2[0] - offset)));
    }
    if (derived.length) {
      // 两邻章推算一致 ⇒ 采用;不一致取更接近比例估算者(仍标 estimated)。
      const chosen = derived.reduce((a, b) => Math.abs(a - estimate) <= Math.abs(b - estimate) ? a : b);
      return { position: { chapterIndex: chosen, partIndex: 0, ratio }, confidence: 'estimated' };
    }
    // 旧章标题有证据、但标题与邻章在新源都锚定不到 ⇒ 没有任何可采信的标题锚点。
    // 比例回退会落到一个纯按序号估算的章(可能完全无关),这比「落空让用户自己选」更糟。
    // 宁可返回 null:调用方保持 START 位置并提示用户手动换源/选章(设计 §5 三级回退的兜底语义)。
    return null;
  }
  return { position: { chapterIndex: estimate, partIndex: 0, ratio }, confidence: 'estimated' };
}
