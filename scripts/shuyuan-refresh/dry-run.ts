// 只读 dry-run(dry-run 能力,不写库)。
//
// 只抓上游合集 + 合并去重,打印「将写入」的计数,不做任何写库动作。
// **不修改 refreshShuyuan 及其任何既有函数契约**——复用 refreshWithinBudget 抓取段的
// 同一批导出件(fetchText / parseIndex / sameRules / normalizeUrl / cleanJson;本次仅由
// 非导出改为导出,逻辑零改动),独立做一次只读的抓取 + 差异统计。
//
// DRY_RUN_NO_DB=1:不连库,只打印上游抓取计数(added/updated/removed/unchanged 置空)。
// 用于 phoenix 首次部署时先证明「上游可达且能解析」,再落库。
import { getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';
import { createDeadline } from '@/lib/deadline';
import {
  INDEX_URL, LATEST_COUNT, RESPONSE_TIMEOUT_MS, REFRESH_BUDGET_MS,
  fetchText, parseIndex, sameRules, normalizeUrl, cleanJson,
} from '@/lib/shuyuan';

export type DryRunCounts = {
  collectionIds: number[];
  merged: number;
  sourceCounts: { id: number; count: number }[];
  added: number | null;
  updated: number | null;
  removed: number | null;
  unchanged: number | null;
  compared: boolean;
};

/**
 * 只读干跑:同样的 index + 最新 LATEST_COUNT 个合集抓取与去重;随后(除非 DRY_RUN_NO_DB=1)
 * 与库内 shuyuan_sources 逐行比对,得出新增/更新/删除预测。行情比对全程只有 SELECT。
 */
export async function dryRunRefresh(parentSignal?: AbortSignal): Promise<DryRunCounts> {
  const budget = createDeadline(REFRESH_BUDGET_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, budget.signal]) : budget.signal;
  try {
    const html = await fetchText(INDEX_URL, RESPONSE_TIMEOUT_MS * 2, signal);
    const entries = parseIndex(html);
    if (entries.length === 0) throw new Error('书源列表页解析到 0 个合集,页面结构可能变了');

    const merged = new Map<string, Record<string, unknown>>();
    const collectionIds: number[] = [];
    const sourceCounts: { id: number; count: number }[] = [];
    for (const entry of entries.slice(0, LATEST_COUNT)) {
      signal.throwIfAborted();
      const parsed = JSON.parse(await fetchText(
        `https://www.yckceo.com/yuedu/shuyuans/json/id/${entry.id}.json`, RESPONSE_TIMEOUT_MS, signal));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!isRecord(item) || typeof item.bookSourceUrl !== 'string') continue;
        const url = normalizeUrl(item.bookSourceUrl);
        if (!url || merged.has(url)) continue;
        const cleaned = cleanJson(item);
        if (isRecord(cleaned)) merged.set(url, cleaned);
      }
      collectionIds.push(entry.id);
      sourceCounts.push({ id: entry.id, count: parsed.length });
    }
    if (merged.size === 0) throw new Error('上游合集整体不可达,dry-run 无法给出差异');

    if (process.env.DRY_RUN_NO_DB === '1') {
      return { collectionIds, merged: merged.size, sourceCounts, added: null, updated: null, removed: null, unchanged: null, compared: false };
    }

    const s = getSql();
    const rows = (await s`
      SELECT source_url, source FROM shuyuan_sources`) as { source_url: string; source: Record<string, unknown> }[];
    const previous = new Map(rows.map((row) => [row.source_url, row]));

    let added = 0; let updated = 0; let unchanged = 0;
    for (const [url, item] of merged) {
      const old = previous.get(url);
      if (!old) added += 1;
      else if (!sameRules(old.source, item)) updated += 1;
      else unchanged += 1;
    }
    let removed = 0;
    for (const url of previous.keys()) if (!merged.has(url)) removed += 1;
    return { collectionIds, merged: merged.size, sourceCounts, added, updated, removed, unchanged, compared: true };
  } finally {
    budget.dispose();
  }
}