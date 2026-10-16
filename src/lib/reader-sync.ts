// 阅读进度 / 阅读设置云端同步（readsync42）的**共享契约**：条目形状、键的合法性、入参归一、
// last-write-wins 版本比较。服务端路由与前端同步器都 import 这一个模块，避免两边各写一套
// 判定后悄悄漂移（同一类洞出现过多次：同一个键格式写两遍，两边一改就只对上一半）。
//
// 本模块刻意不 import 任何数据库 / Node 内置模块 —— 前端组件（useReader）静态引入它。

export type ReaderSyncKind = 'progress' | 'settings';
export const READER_SYNC_KINDS: readonly ReaderSyncKind[] = ['progress', 'settings'];

/** 设置只有一项：本地键是全局的（READER_SETTINGS_KEY），不带书/用户维度。 */
export const READER_SYNC_SETTINGS_ITEM = 'default';

/** 单次 PUT 最多带的条目数；进度一项一书，200 已远超正常书架规模。 */
export const READER_SYNC_MAX_ENTRIES = 200;
/** 单条 payload 的 JSON 字节上限（ReadingProgress ~300B，ReaderSettings ~150B）。 */
export const READER_SYNC_MAX_PAYLOAD_BYTES = 16 * 1024;
export const READER_SYNC_MAX_KEY_LENGTH = 240;

// 进度项的本地键由 user-scope.ts 生成，只有两种形态：
//   novel-finder-reading-progress-u<userId>-<taskId>
//   novel-finder-reading-progress-source-u<userId>-<sourceId>
// 键是**客户端可控**的输入，服务端必须先判形状再落库（否则任意字符串都能进 item_key 列）。
const PROGRESS_KEY = /^novel-finder-reading-progress(?:-source)?-u[1-9]\d*-\S{1,200}$/;

export interface ReaderSyncEntry {
  kind: ReaderSyncKind;
  /** 进度项=本地存储键名；设置项=固定 READER_SYNC_SETTINGS_ITEM。 */
  key: string;
  payload: Record<string, unknown>;
  /** 客户端 epoch 毫秒，last-write-wins 的版本号。 */
  updatedAt: number;
}

export function readerSyncItemKey(kind: ReaderSyncKind, key: string): string {
  return `${kind}:${key}`;
}

export function parseReaderSyncItemKey(itemKey: string): { kind: ReaderSyncKind; key: string } | null {
  const split = itemKey.indexOf(':');
  if (split < 1) return null;
  const kind = itemKey.slice(0, split);
  if (!READER_SYNC_KINDS.includes(kind as ReaderSyncKind)) return null;
  return { kind: kind as ReaderSyncKind, key: itemKey.slice(split + 1) };
}

export function isValidReaderSyncKey(kind: ReaderSyncKind, key: string): boolean {
  if (kind === 'settings') return key === READER_SYNC_SETTINGS_ITEM;
  return key.length <= READER_SYNC_MAX_KEY_LENGTH && PROGRESS_KEY.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把不可信输入（PUT 请求体 / 数据库行）收敛成合法条目，非法返回 null。
 * payload 的体积按 JSON 字节算：字符数上限对多字节文本会低估，这里不引入额外的长度估算口径。
 */
export function normalizeReaderSyncEntry(value: unknown): ReaderSyncEntry | null {
  if (!isPlainObject(value)) return null;
  const kind = value.kind;
  if (!READER_SYNC_KINDS.includes(kind as ReaderSyncKind)) return null;
  if (typeof value.key !== 'string' || !isValidReaderSyncKey(kind as ReaderSyncKind, value.key)) return null;
  if (!isPlainObject(value.payload)) return null;
  const updatedAt = value.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  if (JSON.stringify(value.payload).length > READER_SYNC_MAX_PAYLOAD_BYTES) return null;
  return { kind: kind as ReaderSyncKind, key: value.key, payload: value.payload, updatedAt };
}

/**
 * last-write-wins 的单点判定：版本相等算**本地赢**。
 * 相等有两种来源 —— 同一毫秒内的两次写入，或「本地值本来就是从云端拉下来的」；
 * 两种都不该把刚读到的值再当成过期值覆盖回去。
 */
export function readerSyncWins(
  local: { updatedAt: number } | null, remote: { updatedAt: number },
): 'local' | 'remote' {
  if (!local) return 'remote';
  return remote.updatedAt > local.updatedAt ? 'remote' : 'local';
}
