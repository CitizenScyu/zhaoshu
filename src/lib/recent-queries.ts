import { LEGACY_RECENT_QUERIES_KEY, migrateLegacyKey, userRecentQueriesKey } from './user-scope';

/**
 * 最近搜索的最小外部 store（useSyncExternalStore 需要稳定快照）。
 * 键按 userId；旧全局键只迁给已确认的 owner；退出时同时清掉存储与模块缓存，
 * 否则同一个人再次登录会读回已经被清掉的旧快照。
 */
export const RECENT_QUERIES_MAX = 6;
/** 空快照：useSyncExternalStore 的服务端快照与稳定引用。 */
export const EMPTY_HISTORY: string[] = [];

let cache: { key: string; value: string[] } | null = null;
const listeners = new Set<() => void>();

function area(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function historyKeyFor(userId: number): string {
  return migrateLegacyKey(LEGACY_RECENT_QUERIES_KEY, userRecentQueriesKey(userId), userId);
}

function load(key: string): string[] {
  const storage = area();
  if (!storage) return EMPTY_HISTORY;
  try {
    const saved = JSON.parse(storage.getItem(key) ?? '[]');
    if (Array.isArray(saved)) return saved.filter((query) => typeof query === 'string' && query);
  } catch {
    // 坏数据当没有
  }
  return EMPTY_HISTORY;
}

function write(key: string, value: string[]): void {
  const storage = area();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不进就算了，不影响找书
  }
}

/** 稳定快照：同一 key 的同一份数据必须返回同一个引用。 */
export function historySnapshot(key: string): string[] {
  if (cache?.key !== key) cache = { key, value: load(key) };
  return cache.value;
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function rememberQuery(key: string, query: string): void {
  const next = [query, ...historySnapshot(key).filter((previous) => previous !== query)].slice(0, RECENT_QUERIES_MAX);
  write(key, next);
  cache = { key, value: next };
  for (const listener of [...listeners]) listener();
}

/** 显式退出：清当前用户的查询缓存与模块快照。 */
export function forgetHistory(userId: number): void {
  const storage = area();
  if (storage) {
    try {
      storage.removeItem(userRecentQueriesKey(userId));
    } catch {
      // 清不掉就留到下次，不阻塞退出。
    }
  }
  cache = null;
}
