// readerlocal42:路由往返状态快照。/ 与 /read/* 是不同路由,往返时页面树整体重挂,
// 找书结果与阅读中的目录/正文窗口全部丢失、重新请求。这里把「落定后的状态」存进
// sessionStorage:同一标签页内往返即恢复,关标签页即失效,天然带生命周期边界。
// 快照一律带 savedAt,读取时过期(TTL)即当不存在——宁可重新加载,不拿陈旧状态冒充现况。

import type { RerankedItem } from '@/lib/types';
import type { VetoedBook } from '@/lib/find-sse';
import type { ExactState } from '@/lib/find-exact';
import type { ReaderIndex, ReaderPart } from '@/lib/reader-types';
import type { ReadingPosition } from '@/lib/reader-preferences';

interface SnapshotEnvelope { savedAt: number; value: unknown }

export function saveSnapshot(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value } satisfies SnapshotEnvelope));
  } catch { /* 配额满/隐私模式:快照不可用,功能退回无恢复 */ }
}

export function readSnapshot<T>(key: string, maxAgeMs: number): { value: T; savedAt: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SnapshotEnvelope>;
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > maxAgeMs || parsed.value == null) return null;
    return { value: parsed.value as T, savedAt: parsed.savedAt };
  } catch { return null; }
}

const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const FIND_SNAPSHOT_PREFIX = 'novel-finder-find-snapshot-u';

export interface FindSnapshot {
  q: string;
  results: RerankedItem[];
  persistNote: string;
  emptyNote: string;
  vetoed: VetoedBook[];
}

export const findSnapshotKey = (userId: number) => `${FIND_SNAPSHOT_PREFIX}${userId}`;
export const saveFindSnapshot = (userId: number, value: FindSnapshot) => saveSnapshot(findSnapshotKey(userId), value);
export const readFindSnapshot = (userId: number) => readSnapshot<FindSnapshot>(findSnapshotKey(userId), SNAPSHOT_TTL_MS);

interface ExactSnapshot { title: string; author: string; state: ExactState }

export const exactSnapshotKey = (userId: number) => `${FIND_SNAPSHOT_PREFIX}-exact-u${userId}`;
export const saveExactSnapshot = (userId: number, value: ExactSnapshot) => saveSnapshot(exactSnapshotKey(userId), value);
export const readExactSnapshot = (userId: number) => readSnapshot<ExactSnapshot>(exactSnapshotKey(userId), SNAPSHOT_TTL_MS);

// 阅读快照按 (用户, 书会话) 分键:换书/换账号互不覆盖。key 拼进 readingSessionKey,
// 与 ReaderSession 的挂载 key 同源,不用再核对形状之外的归属。
export const readerSnapshotKey = (userId: number, sessionKey: string) => `novel-finder-reader-snapshot-u${userId}:${sessionKey}`;

/** 阅读窗口快照:切页往返后恢复目录身份与在看的这几段正文,免一次目录+章节请求。 */
export interface ReaderSnapshot {
  index: ReaderIndex;
  parts: ReaderPart[];
  position: ReadingPosition;
}

export const saveReaderSnapshot = (userId: number, sessionKey: string, value: ReaderSnapshot) =>
  saveSnapshot(readerSnapshotKey(userId, sessionKey), value);
export const readReaderSnapshot = (userId: number, sessionKey: string) =>
  readSnapshot<ReaderSnapshot>(readerSnapshotKey(userId, sessionKey), SNAPSHOT_TTL_MS);
