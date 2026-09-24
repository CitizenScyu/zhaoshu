// 引擎兜底搜索的源调度（espfix41）。从 engine-fetch.mjs cmdSearch 抽出，便于用 mock 延迟模型单测。
//
// 改前：全池 for 循环逐源 await，一本书的墙钟 = 各源耗时之和（book15 宕机时单它就 2×8s）。
// 改后：按「实际请求打向的站」分组——组内严格串行（同站并发不增加），组间有界并发（默认 4）；
//   每源另有切片上限（由调用方的 searchOne 落实），整体仍受调用方 signal 约束。
// 输出顺序与并发无关：结果先落进按池序排列的槽位，汇总后按池序展开（labeler 取「首个合格命中」
// 依赖这个顺序，并发不能改变它）。

/** 组间并发上限：跨站并发，每站同一时刻至多 1 个请求在飞。 */
export const SEARCH_HOST_CONCURRENCY = 4;
/**
 * 单源搜索切片：一次卡满的请求（SOURCE_TIMEOUT_MS 8s）+ 余量。卡死的源 9s 放弃，
 * 不再用第二次尝试把它拖到 16s；5xx 秒回的源仍来得及在切片内重试一次。
 */
export const SEARCH_SOURCE_SLICE_MS = 9_000;

/**
 * @template S, R
 * @param {object} options
 * @param {S[]} options.sources 池序源列表。
 * @param {(source: S) => string} options.hostKey 该源搜索请求打向的站（分组键；空串按源独立成组）。
 * @param {(source: S) => Promise<R[]>} options.searchOne 单源搜索。
 * @param {AbortSignal} options.signal 整体截止；中止后不再起新源，已收集的照常交付。
 * @param {number} [options.concurrency] 组间并发上限。
 * @param {(source: S, error: unknown) => void} [options.onError] 单源失败（整体未中止时）。
 * @returns {Promise<R[]>} 按池序展开的候选。
 */
export async function searchSources({ sources, hostKey, searchOne, signal, concurrency = SEARCH_HOST_CONCURRENCY, onError }) {
  const groups = new Map();
  sources.forEach((source, index) => {
    const key = hostKey(source) || `#${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  const queue = [...groups.values()];
  const slots = new Array(sources.length);

  async function worker() {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const index of group) {
        if (signal.aborted) return;
        try {
          slots[index] = await searchOne(sources[index]);
        } catch (error) {
          if (signal.aborted) return;
          onError?.(sources[index], error);
        }
      }
    }
  }

  const width = Math.max(1, Math.min(Math.trunc(concurrency) || 1, queue.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return slots.flatMap((items) => items ?? []);
}
