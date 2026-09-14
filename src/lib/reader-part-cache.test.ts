import { describe, expect, it, vi } from 'vitest';
import { nextReadingPosition, previousReadingPosition, ReaderPartCache } from './reader-part-cache';
import type { ReaderIndex, ReaderPart } from './reader-types';
import type { ReadingPosition } from './reader-preferences';

function makeIndex(counts = [20, 2, 3]): ReaderIndex {
  let offset = 0;
  const chapters = counts.map((partCount, index) => {
    const startByte = offset;
    offset += partCount * 100;
    return { index, title: '第' + (index + 1) + '章', startByte, endByte: offset, partCount };
  });
  return { taskId: 42, title: '测试书', author: '测试作者', version: 'a'.repeat(40), totalBytes: offset, chapters };
}

function position(partIndex = 0, chapterIndex = 0, ratio = 0): ReadingPosition {
  return { chapterIndex, partIndex, ratio };
}

interface Load {
  index: ReaderIndex;
  position: ReadingPosition;
  signal: AbortSignal;
  resolve: (part: ReaderPart) => void;
  reject: (error: unknown) => void;
}

function controlledLoader() {
  const loads: Load[] = [];
  const loader = vi.fn((index: ReaderIndex, requested: ReadingPosition, signal: AbortSignal) =>
    new Promise<ReaderPart>((resolve, reject) => {
      loads.push({ index, position: requested, signal, resolve, reject });
    }));
  return { loads, loader };
}

function resultFor(load: Load, text = '模拟阅读片段'): ReaderPart {
  const { index, position: requested } = load;
  const chapter = index.chapters[requested.chapterIndex];
  const startByte = chapter.startByte + requested.partIndex * 100;
  return {
    taskId: index.taskId, version: index.version,
    chapterIndex: requested.chapterIndex, partIndex: requested.partIndex,
    partCount: chapter.partCount, title: chapter.title,
    startByte, endByte: startByte + 100, text,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReaderPartCache', () => {
  it('deduplicates foreground requests regardless of scroll ratio while giving callers separate promises', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const first = cache.get(index, position(0, 0, 0.2));
    const second = cache.get(index, position(0, 0, 0.9));
    expect(first).not.toBe(second);
    expect(loader).toHaveBeenCalledOnce();
    const result = resultFor(loads[0]);
    loads[0].resolve(result);
    await expect(first).resolves.toBe(result);
    await expect(second).resolves.toBe(result);
    await expect(cache.get(index, position())).resolves.toBe(result);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('aborts one caller without cancelling another caller or the shared upstream request', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const leaving = new AbortController();
    const first = cache.get(index, position(), leaving.signal);
    const second = cache.get(index, position());
    const reason = new Error('test caller left');
    const rejected = expect(first).rejects.toBe(reason);
    leaving.abort(reason);
    await rejected;
    expect(loads[0].signal).not.toBe(leaving.signal);
    expect(loads[0].signal.aborted).toBe(false);
    loads[0].resolve(resultFor(loads[0]));
    await expect(second).resolves.toMatchObject({ chapterIndex: 0, partIndex: 0 });
    expect(loader).toHaveBeenCalledOnce();
  });

  it('cancels the upstream only after every foreground subscriber has left', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = cache.get(index, position(), firstController.signal);
    const second = cache.get(index, position(), secondController.signal);
    const rejected = Promise.allSettled([first, second]);
    firstController.abort();
    expect(loads[0].signal.aborted).toBe(false);
    secondController.abort();
    expect(loads[0].signal.aborted).toBe(true);
    const results = await rejected;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    const retry = cache.get(index, position());
    expect(loader).toHaveBeenCalledTimes(2);
    loads[1].resolve(resultFor(loads[1]));
    await retry;
  });

  it('handles multiple subscriptions using the same abort signal', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const controller = new AbortController();
    const index = makeIndex();
    const results = Promise.allSettled([
      cache.get(index, position(), controller.signal), cache.get(index, position(), controller.signal),
    ]);
    controller.abort();
    expect(loads[0].signal.aborted).toBe(true);
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
  });

  it('rejects an already aborted caller even for a cache hit without starting another request', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const controller = new AbortController();
    controller.abort();
    await expect(cache.get(index, position(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader).not.toHaveBeenCalled();
    const first = cache.get(index, position());
    loads[0].resolve(resultFor(loads[0]));
    await first;
    await expect(cache.get(index, position(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader).toHaveBeenCalledOnce();
  });

  it('shares and upgrades speculative work when foreground readers request the prefetched section', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    cache.prefetch(index, position());
    cache.prefetch(index, position(0, 0, 0.4));
    const foreground = cache.get(index, position());
    expect(loader).toHaveBeenCalledOnce();
    cache.prefetch(index, position(1));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loads[0].signal.aborted).toBe(false);
    loads[0].resolve(resultFor(loads[0]));
    loads[1].resolve(resultFor(loads[1]));
    await foreground;
    await settle();
    await expect(cache.get(index, position(1))).resolves.toMatchObject({ partIndex: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps the prefetch intent alive when its only foreground caller aborts', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const controller = new AbortController();
    cache.prefetch(index, position());
    const foreground = cache.get(index, position(), controller.signal);
    const rejected = expect(foreground).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(loads[0].signal.aborted).toBe(false);
    loads[0].resolve(resultFor(loads[0]));
    await settle();
    await expect(cache.get(index, position())).resolves.toMatchObject({ partIndex: 0 });
    expect(loader).toHaveBeenCalledOnce();
  });

  it('cancels an old upgraded prefetch if its foreground reader leaves after the prefetch target changes', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const controller = new AbortController();
    cache.prefetch(index, position());
    const foreground = cache.get(index, position(), controller.signal);
    const rejected = expect(foreground).rejects.toMatchObject({ name: 'AbortError' });
    cache.prefetch(index, position(1));
    controller.abort();
    await rejected;
    expect(loads[0].signal.aborted).toBe(true);
    expect(loads[1].signal.aborted).toBe(false);
    cache.clear();
  });

  it('replaces unneeded prefetches, ignores late responses, and retains only one speculative intent', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    for (let partIndex = 0; partIndex < 12; partIndex++) cache.prefetch(index, position(partIndex));
    expect(loads.filter((load) => !load.signal.aborted)).toHaveLength(1);
    expect(loads[11].signal.aborted).toBe(false);
    for (const load of loads) load.resolve(resultFor(load));
    await settle();
    await expect(cache.get(index, position(11))).resolves.toMatchObject({ partIndex: 11 });
    const retryOld = cache.get(index, position());
    expect(loader).toHaveBeenCalledTimes(13);
    loads[12].resolve(resultFor(loads[12]));
    await retryOld;
  });

  it('cancels obsolete speculative work when the new prefetch target is already cached', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const first = cache.get(index, position());
    loads[0].resolve(resultFor(loads[0]));
    await first;
    cache.prefetch(index, position(1));
    cache.prefetch(index, position());
    expect(loads[1].signal.aborted).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('silently consumes asynchronous prefetch errors and retries the same section on demand', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    expect(cache.prefetch(index, position())).toBeUndefined();
    loads[0].reject(new Error('test network failure'));
    await settle();
    const retry = cache.get(index, position());
    expect(loader).toHaveBeenCalledTimes(2);
    loads[1].resolve(resultFor(loads[1]));
    await expect(retry).resolves.toMatchObject({ partIndex: 0 });
  });

  it('cancelPrefetch cancels only speculative work and leaves a different foreground load intact', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    cache.prefetch(index, position());
    const foreground = cache.get(index, position(1));
    cache.cancelPrefetch();
    cache.cancelPrefetch();
    expect(loads[0].signal.aborted).toBe(true);
    expect(loads[1].signal.aborted).toBe(false);
    loads[1].resolve(resultFor(loads[1]));
    await foreground;
  });

  it('cancelPrefetch preserves an upgraded foreground load until its final subscriber leaves', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const controller = new AbortController();
    cache.prefetch(index, position());
    const foreground = cache.get(index, position(), controller.signal);
    const cancelled = expect(foreground).rejects.toMatchObject({ name: 'AbortError' });
    cache.cancelPrefetch();
    expect(loads[0].signal.aborted).toBe(false);
    controller.abort();
    await cancelled;
    expect(loads[0].signal.aborted).toBe(true);
  });

  it('cancelPrefetch retains completed cached sections and permits a later prefetch', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    cache.prefetch(index, position());
    loads[0].resolve(resultFor(loads[0]));
    await settle();
    cache.cancelPrefetch();
    await expect(cache.get(index, position())).resolves.toMatchObject({ partIndex: 0 });
    expect(loader).toHaveBeenCalledOnce();
    cache.prefetch(index, position(1));
    expect(loader).toHaveBeenCalledTimes(2);
    cache.clear();
  });

  it('delivers a shared prefetch failure to foreground callers without caching that failure', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    cache.prefetch(index, position());
    const foreground = cache.get(index, position());
    const error = new Error('test unavailable chapter');
    const rejected = expect(foreground).rejects.toBe(error);
    loads[0].reject(error);
    await rejected;
    const retry = cache.get(index, position());
    loads[1].resolve(resultFor(loads[1]));
    await retry;
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('handles synchronously thrown loader failures for both prefetch and foreground calls', async () => {
    const error = new Error('test synchronous failure');
    const loader = vi.fn(() => { throw error; });
    const cache = new ReaderPartCache(loader);
    expect(() => cache.prefetch(makeIndex(), position())).not.toThrow();
    await expect(cache.get(makeIndex(), position())).rejects.toBe(error);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('isolates pending and completed parts by task, revision, chapter, and section', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const cases = [
      { index, position: position() },
      { index: { ...index, taskId: 43 }, position: position() },
      { index: { ...index, version: 'b'.repeat(40) }, position: position() },
      { index, position: position(1) },
      { index, position: position(0, 1) },
    ];
    const requests = cases.map((item) => cache.get(item.index, item.position));
    expect(loader).toHaveBeenCalledTimes(5);
    loads.forEach((load, offset) => load.resolve(resultFor(load, '模拟片段' + offset)));
    await Promise.all(requests);
    for (const [offset, item] of cases.entries()) {
      await expect(cache.get(item.index, item.position)).resolves.toMatchObject({
        taskId: item.index.taskId, version: item.index.version, text: '模拟片段' + offset,
      });
    }
    expect(loader).toHaveBeenCalledTimes(5);
  });

  it.each([{ capacity: undefined, count: 5 }, { capacity: 2, count: 2 }])(
    'evicts only the least recently used section at capacity $count', async ({ capacity, count }) => {
      const { loads, loader } = controlledLoader();
      const cache = new ReaderPartCache(loader, capacity);
      const index = makeIndex();
      for (let partIndex = 0; partIndex < count; partIndex++) {
        const request = cache.get(index, position(partIndex));
        loads[partIndex].resolve(resultFor(loads[partIndex]));
        await request;
      }
      await cache.get(index, position());
      const newest = cache.get(index, position(count));
      loads[count].resolve(resultFor(loads[count]));
      await newest;
      for (const partIndex of [0, ...Array.from({ length: count - 1 }, (_, offset) => offset + 2)]) {
        await expect(cache.get(index, position(partIndex))).resolves.toMatchObject({ partIndex });
      }
      expect(loader).toHaveBeenCalledTimes(count + 1);
      const evicted = cache.get(index, position(1));
      expect(loader).toHaveBeenCalledTimes(count + 2);
      loads[count + 1].resolve(resultFor(loads[count + 1]));
      await evicted;
    },
  );

  it('bounds foreground pending work and allows retry after a slot becomes free', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const requests = Array.from({ length: 5 }, (_, partIndex) => cache.get(index, position(partIndex)));
    const settledRequests = Promise.allSettled(requests);
    await expect(cache.get(index, position(5))).rejects.toMatchObject({ name: 'ReaderPartCacheBusyError' });
    for (let partIndex = 5; partIndex < 20; partIndex++) cache.prefetch(index, position(partIndex));
    expect(loader).toHaveBeenCalledTimes(5);
    expect(loads.every((load) => !load.signal.aborted)).toBe(true);
    loads[0].resolve(resultFor(loads[0]));
    await requests[0];
    await settle();
    expect(loader).toHaveBeenCalledTimes(5);
    const retry = cache.get(index, position(5));
    loads[5].resolve(resultFor(loads[5]));
    await retry;
    expect(loader).toHaveBeenCalledTimes(6);
    cache.clear();
    expect((await settledRequests).filter((result) => result.status === 'rejected')).toHaveLength(4);
  });

  it('lets foreground navigation reclaim a speculative slot without aborting existing foreground readers', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    cache.prefetch(index, position());
    const readers = Array.from({ length: 4 }, (_, offset) => cache.get(index, position(offset + 1)));
    const next = cache.get(index, position(5));
    expect(loader).toHaveBeenCalledTimes(6);
    expect(loads[0].signal.aborted).toBe(true);
    expect(loads.slice(1).every((load) => !load.signal.aborted)).toBe(true);
    loads.slice(1).forEach((load) => load.resolve(resultFor(load)));
    await Promise.all([...readers, next]);
  });

  it('never steals a full slot from a prefetch that already has a foreground subscriber', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    cache.prefetch(index, position());
    const settled = Promise.allSettled(Array.from({ length: 5 }, (_, partIndex) => cache.get(index, position(partIndex))));
    await expect(cache.get(index, position(5))).rejects.toMatchObject({ name: 'ReaderPartCacheBusyError' });
    expect(loader).toHaveBeenCalledTimes(5);
    expect(loads.every((load) => !load.signal.aborted)).toBe(true);
    cache.clear();
    await settled;
  });

  it('clear aborts subscribers and prevents late results from replacing a new request for the same key', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const cached = cache.get(index, position());
    loads[0].resolve(resultFor(loads[0]));
    await cached;
    const oldRequest = cache.get(index, position(1));
    const cancelled = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
    cache.prefetch(index, position(2));
    cache.clear();
    await cancelled;
    expect(loads[1].signal.aborted).toBe(true);
    expect(loads[2].signal.aborted).toBe(true);
    const fresh = cache.get(index, position(1));
    loads[1].resolve(resultFor(loads[1], '迟到的旧请求'));
    loads[2].resolve(resultFor(loads[2], '迟到的旧预取'));
    await settle();
    const sharedFresh = cache.get(index, position(1));
    expect(loader).toHaveBeenCalledTimes(4);
    loads[3].resolve(resultFor(loads[3], '清空后的新请求'));
    await expect(fresh).resolves.toMatchObject({ text: '清空后的新请求' });
    await expect(sharedFresh).resolves.toMatchObject({ text: '清空后的新请求' });
    const oldCachedKey = cache.get(index, position());
    expect(loader).toHaveBeenCalledTimes(5);
    loads[4].resolve(resultFor(loads[4]));
    await oldCachedKey;
    const oldPrefetchKey = cache.get(index, position(2));
    expect(loader).toHaveBeenCalledTimes(6);
    loads[5].resolve(resultFor(loads[5]));
    await oldPrefetchKey;
  });

  it('dispose ends the session permanently and is safe to call repeatedly', async () => {
    const { loads, loader } = controlledLoader();
    const cache = new ReaderPartCache(loader);
    const index = makeIndex();
    const request = cache.get(index, position());
    const cancelled = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    cache.dispose();
    cache.dispose();
    cache.clear();
    await cancelled;
    expect(loads[0].signal.aborted).toBe(true);
    loads[0].resolve(resultFor(loads[0]));
    await settle();
    await expect(cache.get(index, position())).rejects.toMatchObject({ name: 'AbortError' });
    cache.prefetch(index, position(1));
    expect(loader).toHaveBeenCalledOnce();
  });

  it('keeps two authenticated session instances independent', async () => {
    const { loads, loader } = controlledLoader();
    const first = new ReaderPartCache(loader);
    const second = new ReaderPartCache(loader);
    const index = makeIndex();
    const firstRequest = first.get(index, position());
    const secondRequest = second.get(index, position());
    const firstCancelled = expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
    first.dispose();
    await firstCancelled;
    expect(loads[0].signal.aborted).toBe(true);
    expect(loads[1].signal.aborted).toBe(false);
    loads[1].resolve(resultFor(loads[1]));
    await secondRequest;
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 6, 1.5, NaN, Infinity])('rejects an invalid cache capacity %s', (capacity) => {
    expect(() => new ReaderPartCache(vi.fn(), capacity)).toThrow(RangeError);
  });

  it('rejects invalid foreground positions and ignores invalid prefetch positions without loading', async () => {
    const loader = vi.fn();
    const cache = new ReaderPartCache(loader);
    await expect(cache.get(makeIndex(), position(-1))).rejects.toThrow(RangeError);
    cache.prefetch(makeIndex(), position(20));
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('adjacent reading positions', () => {
  const index = makeIndex([2, 1, 3]);

  it('moves within a chapter before crossing to the next chapter', () => {
    expect(nextReadingPosition(index, position(0, 0, 0.8))).toEqual(position(1, 0));
    expect(nextReadingPosition(index, position(1, 0, 0.8))).toEqual(position(0, 1));
    expect(nextReadingPosition(index, position(0, 1))).toEqual(position(0, 2));
  });

  it('moves backward within a chapter and lands on the previous chapter last section', () => {
    expect(previousReadingPosition(index, position(2, 2, 0.4))).toEqual(position(1, 2));
    expect(previousReadingPosition(index, position(0, 1))).toEqual(position(1, 0));
    expect(previousReadingPosition(index, position(0, 2))).toEqual(position(0, 1));
  });

  it('returns null at the book boundaries and for an empty index', () => {
    expect(previousReadingPosition(index, position())).toBeNull();
    expect(nextReadingPosition(index, position(2, 2))).toBeNull();
    expect(nextReadingPosition(makeIndex([]), position())).toBeNull();
    expect(previousReadingPosition(makeIndex([]), position())).toBeNull();
  });

  it.each([
    position(-1), position(0, -1), position(0, 3), position(2, 0), position(0.5), position(0, NaN),
  ])('does not turn an invalid saved position %j into a different chapter', (invalid) => {
    expect(nextReadingPosition(index, invalid)).toBeNull();
    expect(previousReadingPosition(index, invalid)).toBeNull();
  });
});
