import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetHistory, historyKeyFor, historySnapshot, rememberQuery, subscribeHistory } from './recent-queries';
import { LEGACY_RECENT_QUERIES_KEY, userRecentQueriesKey } from './user-scope';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    has: (key: string) => data.has(key),
  };
}

let storage: ReturnType<typeof fakeStorage>;

function mount(initial: Record<string, string> = {}) {
  storage = fakeStorage(initial);
  vi.stubGlobal('window', { localStorage: storage });
}

beforeEach(() => mount());
afterEach(() => vi.unstubAllGlobals());

describe('最近搜索的按用户隔离', () => {
  it('scopes the key per user and never reads the legacy owner key', () => {
    mount({ [LEGACY_RECENT_QUERIES_KEY]: JSON.stringify(['owner-query']) });
    expect(historyKeyFor(2)).toBe(userRecentQueriesKey(2));
    expect(historySnapshot(historyKeyFor(2))).toEqual([]);
    // member 的写入不会落到旧 owner 键上。
    rememberQuery(historyKeyFor(2), 'member-query');
    expect(storage.getItem(LEGACY_RECENT_QUERIES_KEY)).toBe(JSON.stringify(['owner-query']));
  });

  it('migrates the legacy global key for the owner', () => {
    mount({ [LEGACY_RECENT_QUERIES_KEY]: JSON.stringify(['owner-query']) });
    const key = historyKeyFor(1);
    expect(key).toBe(userRecentQueriesKey(1));
    expect(historySnapshot(key)).toEqual(['owner-query']);
    expect(storage.has(LEGACY_RECENT_QUERIES_KEY)).toBe(false);
  });

  it('keeps separate snapshots and module cache entries per user', () => {
    rememberQuery(historyKeyFor(1), 'owner-query');
    expect(historySnapshot(historyKeyFor(1))).toEqual(['owner-query']);
    // 换到另一个身份：模块缓存不能把上一个用户的记录当成新用户的快照。
    expect(historySnapshot(historyKeyFor(2))).toEqual([]);
    expect(historySnapshot(historyKeyFor(1))).toEqual(['owner-query']);
  });

  it('drops storage and the module snapshot on an explicit sign-out', () => {
    rememberQuery(historyKeyFor(1), 'owner-query');
    const key = historyKeyFor(1);
    forgetHistory(1);
    expect(storage.has(key)).toBe(false);
    // 模块缓存必须一起丢掉，否则同一个账号重新登录会读回已清掉的旧快照。
    expect(historySnapshot(key)).toEqual([]);
  });

  it('notifies subscribers and trims to the newest entries', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHistory(listener);
    const key = historyKeyFor(2);
    for (const query of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) rememberQuery(key, query);
    expect(listener).toHaveBeenCalledTimes(8);
    expect(historySnapshot(key)).toEqual(['h', 'g', 'f', 'e', 'd', 'c']);
    // 重复查询提到最前，不产生重复项。
    rememberQuery(key, 'd');
    expect(historySnapshot(key)).toEqual(['d', 'h', 'g', 'f', 'e', 'c']);
    unsubscribe();
    rememberQuery(key, 'i');
    expect(listener).toHaveBeenCalledTimes(9);
  });

  it('degrades without a window or with corrupted storage', () => {
    vi.unstubAllGlobals();
    expect(historySnapshot(historyKeyFor(1))).toEqual([]);
    mount({ [userRecentQueriesKey(1)]: 'not-json' });
    expect(historySnapshot(historyKeyFor(1))).toEqual([]);
  });
});
