import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_RECENT_QUERIES_KEY,
  legacyIndexProgressKey,
  migrateLegacyIndexProgressKey,
  migrateLegacyKey,
  userIndexProgressKey,
  userReadingProgressKey,
  userRecentQueriesKey,
} from './user-scope';
import type { ReaderIndex } from './reader-types';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    has: (key: string) => data.has(key),
    get: (key: string) => data.get(key),
  };
}

const local: ReaderIndex = { taskId: 7, title: '测试书', author: '作者', version: 'a'.repeat(40), totalBytes: 100,
  chapters: [{ index: 0, title: '第一章', startByte: 0, endByte: 100, partCount: 1 }] };
const online: ReaderIndex = { ...local, taskId: null, totalBytes: 0,
  source: { id: 'source-one', name: '书源', url: 'https://book15.net/books/details7.html', session: local.version } };

function withStorage(initial: Record<string, string> = {}) {
  const storage = fakeStorage(initial);
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

afterEach(() => vi.unstubAllGlobals());

describe('浏览器私有状态按用户分开', () => {
  it('places every private key in a user namespace', () => {
    expect(userRecentQueriesKey(2)).toBe('novel-finder-recent-queries-u2');
    expect(userReadingProgressKey(2, 42)).toBe('novel-finder-reading-progress-u2-42');
    expect(userIndexProgressKey(local, 2)).toBe('novel-finder-reading-progress-u2-7');
    expect(userIndexProgressKey(online, 2)).toBe('novel-finder-reading-progress-source-u2-source-one');
    expect(userIndexProgressKey(local, 3)).not.toBe(userIndexProgressKey(local, 2));
  });

  it('keeps the legacy key shape recognizable only for migration', () => {
    expect(legacyIndexProgressKey(local)).toBe('novel-finder-reading-progress-7');
    expect(legacyIndexProgressKey(online)).toBe('novel-finder-reading-progress-source-source-one');
  });

  it('never hands the legacy owner key to a member', () => {
    const storage = withStorage({ [LEGACY_RECENT_QUERIES_KEY]: JSON.stringify(['owner-query']) });
    const scoped = userRecentQueriesKey(2);
    expect(migrateLegacyKey(LEGACY_RECENT_QUERIES_KEY, scoped, 2)).toBe(scoped);
    expect(storage.has(scoped)).toBe(false);
    // 旧键原样保留，等 owner 登录时再迁。
    expect(storage.get(LEGACY_RECENT_QUERIES_KEY)).toBe(JSON.stringify(['owner-query']));
  });

  it('moves the legacy key into the owner namespace exactly once', () => {
    const storage = withStorage({ [LEGACY_RECENT_QUERIES_KEY]: JSON.stringify(['owner-query']) });
    migrateLegacyKey(LEGACY_RECENT_QUERIES_KEY, userRecentQueriesKey(1), 1);
    expect(storage.get(userRecentQueriesKey(1))).toBe(JSON.stringify(['owner-query']));
    // 迁完删除旧键：之后显式退出清理不会把历史记录重新复活。
    expect(storage.has(LEGACY_RECENT_QUERIES_KEY)).toBe(false);
  });

  it('never overwrites newer owner data with a stale legacy key', () => {
    const storage = withStorage({
      [LEGACY_RECENT_QUERIES_KEY]: JSON.stringify(['stale']),
      [userRecentQueriesKey(1)]: JSON.stringify(['fresh']),
    });
    migrateLegacyKey(LEGACY_RECENT_QUERIES_KEY, userRecentQueriesKey(1), 1);
    expect(storage.get(userRecentQueriesKey(1))).toBe(JSON.stringify(['fresh']));
    expect(storage.has(LEGACY_RECENT_QUERIES_KEY)).toBe(false);
  });

  it('migrates progress for the owner only and leaves member progress untouched', () => {
    const storage = withStorage({ [legacyIndexProgressKey(local)]: '{"chapterIndex":1}' });
    expect(migrateLegacyIndexProgressKey(local, 2)).toBe(userIndexProgressKey(local, 2));
    expect(storage.has(userIndexProgressKey(local, 2))).toBe(false);
    expect(storage.get(legacyIndexProgressKey(local))).toBe('{"chapterIndex":1}');

    expect(migrateLegacyIndexProgressKey(local, 1)).toBe(userIndexProgressKey(local, 1));
    expect(storage.get(userIndexProgressKey(local, 1))).toBe('{"chapterIndex":1}');
    expect(storage.has(legacyIndexProgressKey(local))).toBe(false);
  });

  it('degrades to "no record" when the browser blocks storage', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked'); } });
    expect(migrateLegacyKey(LEGACY_RECENT_QUERIES_KEY, userRecentQueriesKey(1), 1)).toBe(userRecentQueriesKey(1));
  });

  it('does not touch storage without a window (server render)', () => {
    expect(migrateLegacyKey(LEGACY_RECENT_QUERIES_KEY, userRecentQueriesKey(1), 1)).toBe(userRecentQueriesKey(1));
  });
});
