import type { ReaderIndex } from './reader-types';

/**
 * 浏览器私有状态的按用户命名空间（设计 §6.4）。
 * 只处理“私人数据”：最近搜索、阅读进度。字号 / 纸色 / 字体等非敏感设置不进这里，
 * 它们可以作为本机设置共享，且不能用来推导身份。
 */
export const OWNER_USER_ID = 1;
export const RECENT_QUERIES_BASE = 'novel-finder-recent-queries';
export const READING_PROGRESS_BASE = 'novel-finder-reading-progress';
export const READING_PROGRESS_SOURCE_BASE = 'novel-finder-reading-progress-source';

/** 旧版本的全局键：没有任何用户维度，只能迁给已确认的 owner。 */
export const LEGACY_RECENT_QUERIES_KEY = RECENT_QUERIES_BASE;

export function userRecentQueriesKey(userId: number): string {
  return `${RECENT_QUERIES_BASE}-u${userId}`;
}

export function userReadingProgressKey(userId: number, taskId: number): string {
  return `${READING_PROGRESS_BASE}-u${userId}-${taskId}`;
}

export function userSourceProgressKey(userId: number, sourceId: string): string {
  return `${READING_PROGRESS_SOURCE_BASE}-u${userId}-${sourceId}`;
}

export function userIndexProgressKey(index: ReaderIndex, userId: number): string {
  return index.source
    ? userSourceProgressKey(userId, index.source.id)
    : userReadingProgressKey(userId, index.taskId!);
}

export function legacyIndexProgressKey(index: ReaderIndex): string {
  return index.source
    ? `${READING_PROGRESS_SOURCE_BASE}-${index.source.id}`
    : `${READING_PROGRESS_BASE}-${index.taskId!}`;
}

type ReadableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): ReadableStorage | null {
  try {
    return window.localStorage;
  } catch {
    // 浏览器禁用存储时按“没有记录”处理，不影响找书和阅读。
    return null;
  }
}

function move(area: ReadableStorage, legacyKey: string, scopedKey: string): void {
  try {
    if (area.getItem(scopedKey) === null) {
      const legacy = area.getItem(legacyKey);
      if (legacy !== null) area.setItem(scopedKey, legacy);
    }
    // 一次性迁移：迁完就删掉旧全局键，显式退出清理后不会把历史记录重新复活。
    if (area.getItem(legacyKey) !== null) area.removeItem(legacyKey);
  } catch {
    // 存储失败时保留旧键，下次再试。
  }
}

/**
 * 旧全局键只在确认 owner=1 后迁入 owner 命名空间；member 永远读不到旧 owner 记录。
 * 返回迁移后的读取键，调用方应始终使用返回值。
 */
export function migrateLegacyKey(legacyKey: string, scopedKey: string, userId: number): string {
  if (userId !== OWNER_USER_ID) return scopedKey;
  const area = storage();
  if (area) move(area, legacyKey, scopedKey);
  return scopedKey;
}

export function migrateLegacyIndexProgressKey(index: ReaderIndex, userId: number): string {
  return migrateLegacyKey(legacyIndexProgressKey(index), userIndexProgressKey(index, userId), userId);
}
