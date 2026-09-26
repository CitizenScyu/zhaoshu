// 41-srcmem「按书记住上次成功的源」（外部审视 F3.2）：浏览器端记忆，按书的稳定身份键存"上次读通的源"。
// 记忆存 localStorage、不进数据库（裁定 #1：不新增表/迁移，避免每次阅读多一次库读写）。
// 身份键复用换源比对同一套归一口径（sourceBookIdentityKey），不另起一套（裁定 #3）。
//
// 记忆是**软提示**：下次打开同一本书时优先请求这个源；服务端会再校验它仍在可用源池内、
// bookUrl 过 host/SSRF 门、且能读通，失败就静默回落整池搜索并让前端清掉这条记忆（见 route 的 prefer 分支）。
// 记忆不可信、不构成对服务端准入的绕过。

import { sourceBookIdentityKey } from './source-parser';

export const SOURCE_MEMORY_KEY = 'zhaoshu:source-memory:v1';
/** 有效期 30 天：太旧的"上次成功"多半已失效，过期视为无记忆。 */
export const SOURCE_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 条数上限 200 本，超出按 LRU（最久未成功）淘汰，防 localStorage 无限膨胀。 */
export const SOURCE_MEMORY_LIMIT = 200;

export interface SourceMemoryEntry {
  /** 源唯一标识（源 url），= 扇出候选 / probe 的 sourceUrl；服务端据此精确定位规则。 */
  sourceUrl: string;
  /** 书在该源的详情页 url（catalog.bookUrl）。 */
  bookUrl: string;
  /** 记录 / 最近命中时间（ms）；TTL 与 LRU 都据此。 */
  at: number;
}

export type SourceMemoryStore = Record<string, SourceMemoryEntry>;

function isEntry(value: unknown): value is SourceMemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sourceUrl === 'string' && entry.sourceUrl.length > 0
    && typeof entry.bookUrl === 'string' && entry.bookUrl.length > 0
    && typeof entry.at === 'number' && Number.isFinite(entry.at);
}

/** 解析存储字符串为 store；坏 JSON / 坏形状条目一律丢弃（不抛）。 */
export function parseSourceMemory(raw: string | null): SourceMemoryStore {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const store: SourceMemoryStore = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isEntry(value)) store[key] = { sourceUrl: value.sourceUrl, bookUrl: value.bookUrl, at: value.at };
  }
  return store;
}

/** 纯函数：取命中且未过期的条目（过期返回 null，视为无记忆）。 */
export function pickEntry(store: SourceMemoryStore, key: string, now: number): SourceMemoryEntry | null {
  const entry = store[key];
  if (!entry) return null;
  if (now - entry.at > SOURCE_MEMORY_TTL_MS) return null;
  return entry;
}

/** 纯函数：写入本条（at=now）+ 顺带剔除已过期条目 + 超上限按 LRU（at 最小）淘汰；返回新 store。 */
export function putEntry(
  store: SourceMemoryStore, key: string, entry: Pick<SourceMemoryEntry, 'sourceUrl' | 'bookUrl'>, now: number,
): SourceMemoryStore {
  const next: SourceMemoryStore = {};
  // 先保留其余未过期的条目，本条稍后以最新时间覆盖写入。
  for (const [existingKey, existing] of Object.entries(store)) {
    if (existingKey !== key && now - existing.at <= SOURCE_MEMORY_TTL_MS) next[existingKey] = existing;
  }
  next[key] = { sourceUrl: entry.sourceUrl, bookUrl: entry.bookUrl, at: now };
  const keys = Object.keys(next);
  if (keys.length > SOURCE_MEMORY_LIMIT) {
    keys.sort((a, b) => next[a].at - next[b].at);
    for (const stale of keys.slice(0, keys.length - SOURCE_MEMORY_LIMIT)) delete next[stale];
  }
  return next;
}

/** 纯函数：删除某条；不存在则原样返回。 */
export function dropEntry(store: SourceMemoryStore, key: string): SourceMemoryStore {
  if (!(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

function readStore(): SourceMemoryStore {
  try { return parseSourceMemory(window.localStorage.getItem(SOURCE_MEMORY_KEY)); }
  catch { return {}; }
}

function writeStore(store: SourceMemoryStore): void {
  try {
    if (Object.keys(store).length === 0) window.localStorage.removeItem(SOURCE_MEMORY_KEY);
    else window.localStorage.setItem(SOURCE_MEMORY_KEY, JSON.stringify(store));
  } catch { /* 存储不可用（隐私模式 / 配额满）：静默降级，与阅读进度同款处理，不影响阅读。 */ }
}

/** 读取某书的首选源记忆（未命中 / 已过期 / 无 window 均返回 null）。 */
export function readSourceMemory(title: string, author: string, now: number = Date.now()): SourceMemoryEntry | null {
  if (typeof window === 'undefined') return null;
  return pickEntry(readStore(), sourceBookIdentityKey(title, author), now);
}

/** 记住某书这次读通的源（sourceUrl / bookUrl 任一为空则不记）。 */
export function rememberSource(
  title: string, author: string, entry: Pick<SourceMemoryEntry, 'sourceUrl' | 'bookUrl'>, now: number = Date.now(),
): void {
  if (typeof window === 'undefined' || !entry.sourceUrl || !entry.bookUrl) return;
  writeStore(putEntry(readStore(), sourceBookIdentityKey(title, author), entry, now));
}

/** 清掉某书的首选源记忆（服务端回 hintCleared，或首选源确定失效时调用）。 */
export function forgetSource(title: string, author: string): void {
  if (typeof window === 'undefined') return;
  writeStore(dropEntry(readStore(), sourceBookIdentityKey(title, author)));
}
