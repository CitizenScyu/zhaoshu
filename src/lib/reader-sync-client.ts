// 阅读进度 / 设置云端同步的**客户端核心**（readsync42）。纯逻辑，不 import React、不碰
// 数据库、不读 window —— 存储与网络都从参数注入，所以整份合并/退避逻辑可以在假 localStorage
// 与假 fetch 下完整单测（见 reader-sync-client.test.ts）。
//
// 降级语义（钉死）：任何失败都不抛给调用方，一律退回 localStorage。本模块是阅读的**旁路**，
// 失败只影响跨设备续读，不影响进入阅读、翻页、设置生效。

import { READER_SYNC_SETTINGS_ITEM, readerSyncItemKey, readerSyncWins, type ReaderSyncEntry } from './reader-sync';
import { READER_SETTINGS_KEY } from './reader-preferences';

export const READER_SYNC_PATH = '/api/reader-sync';
export const READER_SYNC_PUSH_DELAY_MS = 2_000;
export const READER_SYNC_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * 设置的本地时间戳与归属用户记在哪：READER_SETTINGS_KEY 是**全局**键（不按用户分桶），
 * 云端却是按用户存的。不带归属就出真事故——A 退出、B 在同一台机器登录，B 首次进阅读时会把
 * A 留在本机的设置当成自己的推上云，反之又被 B 的云端设置覆盖掉 A 的本机值。
 */
export const READER_SYNC_SETTINGS_MARK = 'novel-finder-reading-settings-sync';

export interface ReaderSyncStore {
  read(key: string): string | null;
  write(key: string, raw: string): void;
}

/** 抛出这个错表示「服务端不会接受我们了」（未登录/无权限），同步就此停用而不是反复重试。 */
export class ReaderSyncUnauthorizedError extends Error {}

export type ReaderSyncRequest = (
  method: 'GET' | 'PUT', body?: unknown, signal?: AbortSignal,
) => Promise<ReaderSyncEntry[]>;

export interface ReaderSyncOptions {
  userId: number;
  request: ReaderSyncRequest;
  store: ReaderSyncStore;
  delayMs?: number;
  now?: () => number;
}

export interface ReaderSync {
  /** 只有拉到过一次云端真值之后才为 true；false 时 schedule 是空操作。 */
  readonly enabled: boolean;
  /** 拉全量并按 last-write-wins 合并进本地，返回**实际覆盖了本地**的条目。 */
  pull(signal?: AbortSignal): Promise<ReaderSyncEntry[]>;
  scheduleProgress(key: string, payload: unknown, updatedAt: number): void;
  scheduleSettings(settings: unknown, updatedAt: number): void;
  dispose(): void;
}

export function createReaderSync(options: ReaderSyncOptions): ReaderSync {
  const { userId, request, store } = options;
  const delayMs = options.delayMs ?? READER_SYNC_PUSH_DELAY_MS;
  const now = options.now ?? Date.now;
  const pending = new Map<string, ReaderSyncEntry>();
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  function parseObject(raw: string | null): Record<string, unknown> | null {
    try {
      const value: unknown = raw ? JSON.parse(raw) : null;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  function parseStored(key: string): { updatedAt: number; payload: Record<string, unknown> } | null {
    let raw: string | null = null;
    try { raw = store.read(key); } catch { return null; }
    if (raw === null) return null;
    const value = parseObject(raw);
    const updatedAt = value?.updatedAt;
    return typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt) && value
      ? { updatedAt, payload: value }
      : null;
  }

  /** 本地这一项的版本；本地没有 / 形状不对 / 不是当前用户写的，一律当 0（最旧）。 */
  function localVersion(entry: { kind: string; key: string }): { updatedAt: number; payload: Record<string, unknown> } | null {
    if (entry.kind === 'settings') {
      const mark = parseObject(store.read(READER_SYNC_SETTINGS_MARK));
      // 归属不是本人 ⇒ 本机上这份设置不参与比较，也绝不会被推上本人的云端。
      if (!mark || mark.userId !== userId || typeof mark.updatedAt !== 'number' || !Number.isSafeInteger(mark.updatedAt)) return null;
      return { updatedAt: mark.updatedAt, payload: {} };
    }
    return parseStored(entry.key);
  }

  /** 把云端条目写进本地。写入失败（存储被禁用/配额满）只算没同步，绝不抛。 */
  function apply(entry: ReaderSyncEntry): boolean {
    try {
      if (entry.kind === 'settings') store.write(READER_SETTINGS_KEY, JSON.stringify(entry.payload));
      else store.write(entry.key, JSON.stringify(entry.payload));
      if (entry.kind === 'settings') store.write(READER_SYNC_SETTINGS_MARK, JSON.stringify({ userId, updatedAt: entry.updatedAt }));
      return true;
    } catch {
      return false;
    }
  }

  /** 服务端真值 → 本地。云端较新才覆盖；本地较新则把本地重新排进推送队列。 */
  function absorb(entries: readonly ReaderSyncEntry[]): ReaderSyncEntry[] {
    const applied: ReaderSyncEntry[] = [];
    for (const entry of entries) {
      const local = localVersion(entry);
      if (readerSyncWins(local, entry) === 'remote') {
        if (apply(entry)) applied.push(entry);
      } else if (local && entry.updatedAt < local.updatedAt) {
        queue({ ...entry, payload: entry.kind === 'settings' ? readSettingsPayload() : local.payload, updatedAt: local.updatedAt });
      }
    }
    return applied;
  }

  function readSettingsPayload(): Record<string, unknown> {
    let raw: string | null = null;
    try { raw = store.read(READER_SETTINGS_KEY); } catch { return {}; }
    return parseObject(raw) ?? {};
  }

  function arm() {
    if (disposed || !pending.size || !enabled) return;
    const wait = failures ? Math.min(delayMs * 2 ** failures, READER_SYNC_MAX_BACKOFF_MS) : delayMs;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void flush(); }, wait);
  }

  function queue(entry: ReaderSyncEntry) {
    if (!enabled || disposed) return;
    pending.set(readerSyncItemKey(entry.kind, entry.key), entry);
    arm();
  }

  async function flush(): Promise<void> {
    if (disposed || !pending.size) return;
    const batch = [...pending.values()];
    try {
      const stored = await request('PUT', { entries: batch });
      failures = 0;
      for (const item of batch) pending.delete(readerSyncItemKey(item.kind, item.key));
      // 推送期间另一台设备可能写得更新的值：服务端真值仍较新就覆盖本地。
      absorb(stored);
      if (pending.size) arm();
    } catch (error) {
      if (error instanceof ReaderSyncUnauthorizedError) { enabled = false; return; }
      // 离线 / 5xx：条目留在队列里按指数退避重试，本地值始终是权威副本，不丢数据。
      failures += 1;
      arm();
    }
  }

  return {
    get enabled() { return enabled; },
    async pull(signal) {
      // 未登录（userId=0）根本不发请求：这一层必须与「未登录时的现有行为」完全一致。
      if (disposed || !Number.isSafeInteger(userId) || userId < 1) return [];
      const controller = new AbortController();
      inFlight = controller;
      try {
        const entries = await request('GET', undefined, signal ?? controller.signal);
        enabled = true;
        const applied = absorb(entries);
        if (pending.size) arm();
        return applied;
      } catch {
        // 拉失败（含 401）就整个停用：此时我们不知道云端有没有更新的值，
        // 贸然推送等于用本机值盲覆盖别人的设备。降级为纯 localStorage。
        enabled = false;
        pending.clear();
        return [];
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },
    scheduleProgress(key, payload, updatedAt) {
      if (!payload || typeof payload !== 'object') return;
      queue({ kind: 'progress', key, payload: payload as Record<string, unknown>, updatedAt });
    },
    scheduleSettings(settings, updatedAt) {
      if (!settings || typeof settings !== 'object') return;
      try {
        store.write(READER_SYNC_SETTINGS_MARK, JSON.stringify({ userId, updatedAt }));
      } catch { /* 本地存储不可用：设置本来也存不下去，同步一并放弃 */ return; }
      queue({ kind: 'settings', key: READER_SYNC_SETTINGS_ITEM, payload: settings as Record<string, unknown>, updatedAt });
    },
    dispose() {
      disposed = true;
      enabled = false;
      pending.clear();
      if (timer) { clearTimeout(timer); timer = null; }
      inFlight?.abort();
      inFlight = null;
    },
  };
}
