// B2-05 快照 GC 只读核对(gcls-41):逐书串行跑 collectSnapshotGarbage 的 dry-run,汇总成行。
// 永远不传 execute —— 本模块没有删除路径。CLI 外壳见 scripts/snapshot-gc-dry-run.mjs。

import { collectSnapshotGarbage, type SnapshotGcSkipReason, type SnapshotGcStore } from '../src/lib/snapshot-gc';
import type { GitHubRateLimit } from './snapshot-gc-store';

export interface DryRunStore extends SnapshotGcStore {
  listStems(): Promise<string[]>;
  sizeOf(path: string): number | undefined;
  rateLimit?(): GitHubRateLimit | null;
}

export interface DryRunRow {
  stem: string;
  /** 可读书名目录(decodeURIComponent(stem))。 */
  name: string;
  volumes: number;
  referenced: number;
  orphans: number;
  orphanBytes: number;
  /** 孤儿里拿不到大小的个数(orphanBytes 因此偏小)。 */
  unsizedOrphans: number;
  skipped: SnapshotGcSkipReason | null;
  detail?: string;
  /** 孤儿路径样例(最多 3 个)。 */
  sample: string[];
}

export interface DryRunSummary {
  booksListed: number;
  booksScanned: number;
  booksWithVolumes: number;
  volumes: number;
  referenced: number;
  orphans: number;
  orphanBytes: number;
  booksWithOrphans: number;
  skipped: Partial<Record<SnapshotGcSkipReason, number>>;
  /** 提前停下的原因(速率限制余量不足);null = 跑完了选定范围。 */
  stoppedEarly: string | null;
}

export interface DryRunOptions {
  /** 只跑这些 stem(编码形态);不给则列全部。 */
  stems?: string[];
  offset?: number;
  limit?: number;
  now?: number;
  /** 速率限制余量低于它就停(默认 300)。 */
  minRateRemaining?: number;
  onRow?: (row: DryRunRow) => void;
}

function readableName(stem: string): string {
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

export async function runSnapshotGcDryRun(store: DryRunStore, options: DryRunOptions = {}): Promise<{ rows: DryRunRow[]; summary: DryRunSummary }> {
  const all = options.stems ?? await store.listStems();
  const offset = Math.max(0, options.offset ?? 0);
  const selected = all.slice(offset, options.limit === undefined ? undefined : offset + Math.max(0, options.limit));
  const minRemaining = options.minRateRemaining ?? 300;
  const rows: DryRunRow[] = [];
  const summary: DryRunSummary = {
    booksListed: all.length, booksScanned: 0, booksWithVolumes: 0, volumes: 0, referenced: 0,
    orphans: 0, orphanBytes: 0, booksWithOrphans: 0, skipped: {}, stoppedEarly: null,
  };

  for (const stem of selected) {
    const rate = store.rateLimit?.();
    if (rate && rate.remaining < minRemaining) {
      summary.stoppedEarly = `rate_limit_remaining=${rate.remaining} < ${minRemaining}`;
      break;
    }
    const report = await collectSnapshotGarbage(store, stem, { now: options.now });
    const sizes = report.orphans.map(path => store.sizeOf(path));
    const row: DryRunRow = {
      stem, name: readableName(stem), volumes: report.volumeCount,
      referenced: report.retained.length, orphans: report.orphans.length,
      orphanBytes: sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0),
      unsizedOrphans: sizes.filter(size => size === undefined).length,
      skipped: report.skipped, ...(report.detail === undefined ? {} : { detail: report.detail }),
      sample: report.orphans.slice(0, 3),
    };
    rows.push(row);
    options.onRow?.(row);

    summary.booksScanned++;
    if (row.volumes > 0) summary.booksWithVolumes++;
    summary.volumes += row.volumes;
    summary.referenced += row.referenced;
    summary.orphans += row.orphans;
    summary.orphanBytes += row.orphanBytes;
    if (row.orphans > 0) summary.booksWithOrphans++;
    if (row.skipped) summary.skipped[row.skipped] = (summary.skipped[row.skipped] ?? 0) + 1;
  }
  return { rows, summary };
}
