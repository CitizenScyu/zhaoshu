// 阅读进度/设置云端同步的客户端合并与降级（readsync42）。
// 全部用假存储 + 假 fetch + 假计时器：不碰 window、不发真请求，钉死的是
//   ① 云端较新才覆盖本地（两个方向）；② 未登录一次请求都不发；
//   ③ 拉/推失败静默退回 localStorage；④ 推送 debounce ≥2s 且按项合并。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReaderSync, READER_SYNC_SETTINGS_MARK, ReaderSyncUnauthorizedError,
  type ReaderSync, type ReaderSyncRequest, type ReaderSyncStore,
} from './reader-sync-client';
import { READER_SETTINGS_KEY } from './reader-preferences';
import type { ReaderSyncEntry } from './reader-sync';

const USER = 7;
const PROGRESS_KEY = 'novel-finder-reading-progress-source-u7-src-42';
const progress = (chapterIndex: number, updatedAt: number): ReaderSyncEntry => ({
  kind: 'progress', key: PROGRESS_KEY,
  payload: { schema: 1, version: 'v1', chapterIndex, partIndex: 0, ratio: 0.4, updatedAt }, updatedAt,
});
const settings = (fontSize: number, updatedAt: number): ReaderSyncEntry => ({
  kind: 'settings', key: 'default', payload: { fontSize, lineHeight: 1.9, theme: 'day' }, updatedAt,
});

function fakeStore(): ReaderSyncStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    read: (key) => data.get(key) ?? null,
    write: (key, raw) => { data.set(key, raw); },
  };
}

describe('阅读进度/设置云端同步客户端核心', () => {
  let store: ReturnType<typeof fakeStore>;
  let calls: { method: 'GET' | 'PUT'; body: unknown }[];
  let respond: (method: 'GET' | 'PUT', body: unknown) => Promise<ReaderSyncEntry[]>;
  let sync: ReaderSync;

  const make = (userId = USER) => {
    const request: ReaderSyncRequest = async (method, body) => { calls.push({ method, body }); return respond(method, body); };
    return createReaderSync({ userId, request, store, delayMs: 2_000 });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = fakeStore();
    calls = [];
    respond = async () => [];
    sync = make();
  });
  afterEach(() => { sync.dispose(); vi.useRealTimers(); });

  it('云端较新才覆盖本地：云端新 → 写本地并上报；本地新 → 保留本地并回推云端', async () => {
    store.data.set(PROGRESS_KEY, JSON.stringify(progress(2, 1_000).payload));
    respond = async () => [progress(9, 5_000)];
    const applied = await sync.pull();
    expect(applied).toEqual([progress(9, 5_000)]);
    expect(JSON.parse(store.data.get(PROGRESS_KEY)!).chapterIndex).toBe(9);

    // 反向：本地版本更高时不被云端覆盖，并被排进推送队列。
    store.data.set(PROGRESS_KEY, JSON.stringify(progress(11, 9_000).payload));
    calls.length = 0;
    respond = async () => [progress(9, 5_000)];
    expect(await sync.pull()).toEqual([]);
    expect(JSON.parse(store.data.get(PROGRESS_KEY)!).chapterIndex).toBe(11);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('版本相等不互相覆盖（同一毫秒内的两次保存）', async () => {
    store.data.set(PROGRESS_KEY, JSON.stringify(progress(3, 4_000).payload));
    respond = async () => [progress(7, 4_000)];
    expect(await sync.pull()).toEqual([]);
    expect(JSON.parse(store.data.get(PROGRESS_KEY)!).chapterIndex).toBe(3);
  });

  it('设置云端较新时同时刷新设置值与归属标记；标记不属于本人时本地值不参与比较', async () => {
    respond = async () => [settings(26, 5_000)];
    expect(await sync.pull()).toEqual([settings(26, 5_000)]);
    expect(JSON.parse(store.data.get(READER_SETTINGS_KEY)!).fontSize).toBe(26);
    expect(JSON.parse(store.data.get(READER_SYNC_SETTINGS_MARK)!)).toEqual({ userId: USER, updatedAt: 5_000 });

    // 同一台机器上的上一位用户：那份本机设置**不参与版本比较**，所以本人的云端设置直接接管这个
    // 全局键；同时它也绝不会被顶着本人的账号推上云（否则 A 的字号会写进 B 的云端）。
    const other = fakeStore();
    other.data.set(READER_SETTINGS_KEY, JSON.stringify({ fontSize: 30 }));
    other.data.set(READER_SYNC_SETTINGS_MARK, JSON.stringify({ userId: USER + 1, updatedAt: 9_999 }));
    const pushed: unknown[] = [];
    const s2 = createReaderSync({
      userId: USER, store: other, delayMs: 2_000,
      request: async (method, body) => {
        if (method === 'PUT') pushed.push(body);
        return [settings(26, 5_000)];
      },
    });
    await s2.pull();
    expect(JSON.parse(other.data.get(READER_SETTINGS_KEY)!).fontSize).toBe(26);
    expect(JSON.parse(other.data.get(READER_SYNC_SETTINGS_MARK)!)).toEqual({ userId: USER, updatedAt: 5_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushed).toEqual([]);
    s2.dispose();
  });

  it('未登录（userId=0）一次请求都不发，schedule 也是空操作', async () => {
    const anonymous = make(0);
    expect(await anonymous.pull()).toEqual([]);
    anonymous.scheduleProgress(PROGRESS_KEY, progress(1, 1_000).payload, 1_000);
    anonymous.scheduleSettings({ fontSize: 20 }, 1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    expect(anonymous.enabled).toBe(false);
    anonymous.dispose();
  });

  it('拉取失败（含未登录）整体停用并退回 localStorage：不覆盖本地、不推送', async () => {
    store.data.set(PROGRESS_KEY, JSON.stringify(progress(2, 1_000).payload));
    respond = async () => { throw new ReaderSyncUnauthorizedError(); };
    expect(await sync.pull()).toEqual([]);
    expect(sync.enabled).toBe(false);
    sync.scheduleProgress(PROGRESS_KEY, progress(3, 2_000).payload, 2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(store.data.get(PROGRESS_KEY)!).chapterIndex).toBe(2);
  });

  it('推送失败静默重试且带退避；成功后才清队列', async () => {
    respond = async () => [];
    await sync.pull();
    let attempts = 0;
    respond = async () => { attempts += 1; if (attempts < 3) throw new Error('offline'); return [progress(4, 3_000)]; };
    sync.scheduleProgress(PROGRESS_KEY, progress(4, 3_000).payload, 3_000);
    await vi.advanceTimersByTimeAsync(2_000);       // 第 1 次：失败，退避到 4s
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);       // 第 2 次：失败，退避到 8s
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(8_000);       // 第 3 次：成功
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);      // 成功后不再有任何重试
    expect(attempts).toBe(3);
  });

  it('debounce：连续保存只推一次，且同一项取最后一次的值', async () => {
    respond = async () => [];
    await sync.pull();
    sync.scheduleProgress(PROGRESS_KEY, progress(1, 10).payload, 10);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    sync.scheduleProgress(PROGRESS_KEY, progress(2, 20).payload, 20);
    sync.scheduleProgress(PROGRESS_KEY, progress(3, 30).payload, 30);
    await vi.advanceTimersByTimeAsync(2_000);
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ entries: [progress(3, 30)] });
  });

  it('dispose 之后不再推送（离开阅读页）', async () => {
    respond = async () => [];
    await sync.pull();
    sync.scheduleProgress(PROGRESS_KEY, progress(1, 10).payload, 10);
    sync.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(await sync.pull()).toEqual([]);
  });
});
