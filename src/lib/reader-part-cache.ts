import type { ReaderIndex, ReaderPart } from './reader-types';
import type { ReadingPosition } from './reader-preferences';

type PartLoader = (index: ReaderIndex, position: ReadingPosition, signal: AbortSignal) => Promise<ReaderPart>;
type PartPosition = Pick<ReadingPosition, 'chapterIndex' | 'partIndex'>;
const MAX_CACHED_PARTS = 5;
const MAX_PENDING_PARTS = 5;

interface Subscriber {
  resolve: (part: ReaderPart) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

interface PendingPart {
  key: string;
  controller: AbortController;
  subscribers: Set<Subscriber>;
}

function abortError(): DOMException {
  return new DOMException('阅读请求已取消。', 'AbortError');
}

function validPosition(index: ReaderIndex, position: PartPosition): boolean {
  const { chapterIndex, partIndex } = position;
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 0
    || !Number.isSafeInteger(partIndex) || partIndex < 0) return false;
  const chapter = index.chapters[chapterIndex];
  return !!chapter && Number.isSafeInteger(chapter.partCount) && partIndex < chapter.partCount;
}

function partKey(index: ReaderIndex, position: ReadingPosition): string {
  return JSON.stringify([index.taskId, index.version, position.chapterIndex, position.partIndex]);
}

/** Adjacent sections come before chapter changes; every returned section starts at its top. */
export function nextReadingPosition(index: ReaderIndex, position: PartPosition): ReadingPosition | null {
  if (!validPosition(index, position)) return null;
  const next = position.partIndex + 1 < index.chapters[position.chapterIndex].partCount
    ? { chapterIndex: position.chapterIndex, partIndex: position.partIndex + 1, ratio: 0 }
    : { chapterIndex: position.chapterIndex + 1, partIndex: 0, ratio: 0 };
  return validPosition(index, next) ? next : null;
}

export function previousReadingPosition(index: ReaderIndex, position: PartPosition): ReadingPosition | null {
  if (!validPosition(index, position)) return null;
  const previous = position.partIndex > 0
    ? { chapterIndex: position.chapterIndex, partIndex: position.partIndex - 1, ratio: 0 }
    : {
      chapterIndex: position.chapterIndex - 1,
      partIndex: (index.chapters[position.chapterIndex - 1]?.partCount ?? 0) - 1,
      ratio: 0,
    };
  return validPosition(index, previous) ? previous : null;
}

/**
 * Memory-only cache for one authenticated ReaderSession; never share it across tokens.
 * At most five completed sections and five distinct pending loads are retained.
 * A foreground get owns a separate subscription; a prefetch is one replaceable intent.
 */
export class ReaderPartCache {
  private readonly completed = new Map<string, ReaderPart>();
  private readonly pending = new Map<string, PendingPart>();
  private prefetching: PendingPart | null = null;
  private disposed = false;

  constructor(private readonly loader: PartLoader, private readonly capacity = MAX_CACHED_PARTS) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CACHED_PARTS) {
      throw new RangeError('正文缓存容量必须在 1 到 5 段之间。');
    }
  }

  get(index: ReaderIndex, position: ReadingPosition, signal?: AbortSignal): Promise<ReaderPart> {
    if (this.disposed) return Promise.reject(abortError());
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    if (!validPosition(index, position)) return Promise.reject(new RangeError('章节或段落不存在。'));
    const key = partKey(index, position);
    const cached = this.touch(key);
    if (cached) return Promise.resolve(cached);

    let entry = this.pending.get(key);
    const existing = !!entry;
    if (!entry) {
      // Foreground navigation can reclaim a speculative request, but it must
      // never cancel a different section that still has a foreground reader.
      if (this.pending.size >= MAX_PENDING_PARTS && this.prefetching?.subscribers.size === 0) {
        this.cancel(this.prefetching, abortError());
      }
      if (this.pending.size >= MAX_PENDING_PARTS) {
        const error = new Error('正在准备其他阅读内容，请稍后重试。');
        error.name = 'ReaderPartCacheBusyError';
        return Promise.reject(error);
      }
      entry = this.createPending(key);
    }

    const result = this.subscribe(entry, signal);
    if (!existing && this.isCurrent(entry)) this.start(entry, index, position);
    return result;
  }

  /** Best effort only: speculative failures are consumed and never become unhandled rejections. */
  prefetch(index: ReaderIndex, position: ReadingPosition): void {
    if (this.disposed || !validPosition(index, position)) return;
    const key = partKey(index, position);
    if (this.prefetching?.key !== key) this.cancelPrefetch();
    if (this.touch(key)) return;
    let entry = this.pending.get(key);
    const existing = !!entry;
    if (!entry) {
      // Drop excess prefetch work instead of retaining an unbounded queue.
      if (this.pending.size >= MAX_PENDING_PARTS) return;
      entry = this.createPending(key);
    }
    this.prefetching = entry;
    if (!existing) this.start(entry, index, position);
  }

  /** Remove speculative interest without interrupting foreground subscribers. */
  cancelPrefetch(): void {
    const previous = this.prefetching;
    this.prefetching = null;
    if (previous) this.cancelIfUnused(previous);
  }

  /** Abort current work and empty the cache; a subsequent get can start a fresh request. */
  clear(): void {
    this.completed.clear();
    this.prefetching = null;
    for (const entry of [...this.pending.values()]) this.cancel(entry, abortError());
  }

  /** End the session permanently. Use clear for effect replays that reuse the same instance. */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private touch(key: string): ReaderPart | undefined {
    const part = this.completed.get(key);
    if (part) {
      this.completed.delete(key);
      this.completed.set(key, part);
    }
    return part;
  }

  private createPending(key: string): PendingPart {
    const entry = { key, controller: new AbortController(), subscribers: new Set<Subscriber>() };
    this.pending.set(key, entry);
    return entry;
  }

  private isCurrent(entry: PendingPart): boolean {
    return this.pending.get(entry.key) === entry && !entry.controller.signal.aborted;
  }

  private subscribe(entry: PendingPart, signal?: AbortSignal): Promise<ReaderPart> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!entry.subscribers.delete(subscriber)) return;
        subscriber.cleanup();
        reject(signal?.reason ?? abortError());
        this.cancelIfUnused(entry);
      };
      const subscriber: Subscriber = {
        resolve, reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      entry.subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private start(entry: PendingPart, index: ReaderIndex, position: ReadingPosition): void {
    try {
      void this.loader(index, { ...position }, entry.controller.signal).then(
        (part) => this.finish(entry, { part }),
        (error: unknown) => this.finish(entry, { error }),
      );
    } catch (error) {
      this.finish(entry, { error });
    }
  }

  private finish(entry: PendingPart, result: { part: ReaderPart } | { error: unknown }): void {
    // The entry identity prevents an aborted response from repopulating the
    // cache or settling a newer request for the same key after clear/retry.
    if (!this.isCurrent(entry)) return;
    this.pending.delete(entry.key);
    if (this.prefetching === entry) this.prefetching = null;
    if ('part' in result) {
      this.completed.delete(entry.key);
      this.completed.set(entry.key, result.part);
      while (this.completed.size > this.capacity) {
        const oldest = this.completed.keys().next().value;
        if (oldest === undefined) break;
        this.completed.delete(oldest);
      }
    }
    for (const subscriber of entry.subscribers) {
      subscriber.cleanup();
      if ('part' in result) subscriber.resolve(result.part);
      else subscriber.reject(result.error);
    }
    entry.subscribers.clear();
  }

  private cancelIfUnused(entry: PendingPart): void {
    if (entry.subscribers.size === 0 && this.prefetching !== entry) this.cancel(entry, abortError());
  }

  private cancel(entry: PendingPart, reason: unknown): void {
    if (this.pending.get(entry.key) !== entry) return;
    this.pending.delete(entry.key);
    if (this.prefetching === entry) this.prefetching = null;
    for (const subscriber of entry.subscribers) {
      subscriber.cleanup();
      subscriber.reject(reason);
    }
    entry.subscribers.clear();
    entry.controller.abort(reason);
  }
}
