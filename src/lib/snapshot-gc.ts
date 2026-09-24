// B2-05:快照区 GC —— 只回收 `books/.snapshots/<stem>/v-<sha8>.txt`(分卷快照)。
//
// 读端与下载导出**先读**快照卷(volume-manifest.ts volumeReadPaths,B2-01):读者可能仍持上一版
// 清单(清单缓存 5 分钟,客户端更久),规范阶段中途失败时线上 index.json 本身就指向旧版快照。
// 因此判据只有一条:**只删任何存活清单都不再引用的快照卷**。快照按卷内容寻址,内容相同的卷在
// 多个版本间共用同一文件 ⇒ 绝不按版本整批删,而是「候选 = 目录里的 v-*.txt − 存活清单引用集」。
//
// 存活清单 = 线上规范 `books/<stem>/index.json`
//          ∪ current.json 的 current
//          ∪ current.json history 的最近 keepVersions 个(至少 2:当前版 + 上一版)
//          ∪ generated_at 在 graceMs 之内(或无法判定)的版本清单(新落的被拒候选、在途发布)。
// 任何一份需要读的清单/指针读不懂 ⇒ 整本书跳过(fail closed),不删任何东西。
// 版本清单 `<version>.json`、current.json、旧单文件时代的其他文件一律不动。
//
// 默认 dry-run(只报告将删什么);真删须显式 `execute: true`,且类型上必须同时给出
// `isPublishing`:删前确认该书没有在途发布(阶段 1 已写卷、阶段 2 清单未落的窗口里,
// 新卷看起来就是孤儿)。孤儿被删后,同内容重试会在发布阶段 1 幂等重写,不丢数据。
//
// 本模块不联网、不碰 DB:存储走注入的 SnapshotGcStore。仓内没有生产实现(GitHub 侧的
// 列目录/DELETE 适配器与是否接 cron 由主会话决定)。

import { SNAPSHOT_DIR } from './download-publisher';

/** GC 所需的最小存储接缝(测试注入内存实现)。 */
export interface SnapshotGcStore {
  /** 列出目录下的文件名(只要名字、不递归);目录不存在返回 []。 */
  listFiles(dir: string): Promise<string[]>;
  getBytes(path: string): Promise<Buffer | null>;
  deleteFile(path: string): Promise<void>;
}

/** 至少保留当前版与上一版引用的全部快照卷。 */
export const SNAPSHOT_GC_MIN_KEEP_VERSIONS = 2;
/** 新近清单保护窗:被拒候选留档、在途发布、长期持有旧清单的读者。 */
export const SNAPSHOT_GC_DEFAULT_GRACE_MS = 7 * 24 * 60 * 60_000;

interface SnapshotGcCommonOptions {
  /** 保留 history 里最近几个版本(含当前版);小于 2 按 2 算。 */
  keepVersions?: number;
  graceMs?: number;
  /** 测试注入时钟(毫秒)。 */
  now?: number;
}

export type SnapshotGcOptions =
  | (SnapshotGcCommonOptions & { execute?: false })
  | (SnapshotGcCommonOptions & {
      execute: true;
      /** 该书是否有在途发布(pending/running 下载任务);true ⇒ 整本跳过。 */
      isPublishing: (stem: string) => Promise<boolean>;
    });

export type SnapshotGcSkipReason =
  | 'unreadable_pointer' | 'unreadable_canonical' | 'unreadable_manifest' | 'missing_manifest' | 'publishing';

export interface SnapshotGcReport {
  stem: string;
  mode: 'dry-run' | 'execute';
  /** 非 null ⇒ 整本跳过,orphans/deleted 均为空。 */
  skipped: SnapshotGcSkipReason | null;
  liveVersions: string[];
  /** 仍被存活清单引用而保留的快照卷。 */
  retained: string[];
  /** 不被任何存活清单引用的快照卷(dry-run 下即「将删」)。 */
  orphans: string[];
  deleted: string[];
  /** 真删时失败的路径(不中断其余删除)。 */
  failed: string[];
}

const VERSION = /^[a-f0-9]{8}$/;
const MANIFEST_FILE = /^([a-f0-9]{8})\.json$/;
const VOLUME_SNAPSHOT_FILE = /^v-[a-f0-9]{8}\.txt$/;

interface ManifestRefs { generatedAt: string | undefined; refs: string[] }

/**
 * 宽松抽取清单引用的快照卷:只要求是 JSON 对象、volumes 是数组且每项都有字符串 snapshot_path。
 * 不做读端全量校验 —— 这里要的是「它引用了谁」,校验更严反而会把引用漏掉。
 * 没有 volumes 键的旧单文件清单不引用分卷快照(requireVolumes 时视为读不懂)。
 */
function manifestRefs(bytes: Buffer, requireVolumes: boolean): ManifestRefs | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const generatedAt = typeof raw.generated_at === 'string' ? raw.generated_at : undefined;
  if (raw.volumes === undefined && !requireVolumes) return { generatedAt, refs: [] };
  if (!Array.isArray(raw.volumes)) return null;
  const refs: string[] = [];
  for (const volume of raw.volumes as unknown[]) {
    const path = volume && typeof volume === 'object' ? (volume as { snapshot_path?: unknown }).snapshot_path : undefined;
    if (typeof path !== 'string') return null;
    refs.push(path);
  }
  return { generatedAt, refs };
}

function parsePointer(bytes: Buffer): { current: string; history: string[] } | null {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as { current?: unknown; history?: unknown };
    if (!value || typeof value.current !== 'string' || !Array.isArray(value.history)) return null;
    if (!value.history.every((item): item is string => typeof item === 'string')) return null;
    return { current: value.current, history: value.history };
  } catch {
    return null;
  }
}

/**
 * 单本书的快照卷 GC。stem 是 `books/.snapshots/` 下的目录名(即 snapshotPaths 的编码 stem),
 * 规范清单为 `books/<stem>/index.json`。默认 dry-run。
 */
export async function collectSnapshotGarbage(
  store: SnapshotGcStore,
  stem: string,
  options: SnapshotGcOptions = {},
): Promise<SnapshotGcReport> {
  if (!stem || stem.includes('/') || stem === '.' || stem === '..') throw new Error('snapshot stem is invalid');
  const dir = `${SNAPSHOT_DIR}/${stem}`;
  const report: SnapshotGcReport = {
    stem, mode: options.execute ? 'execute' : 'dry-run', skipped: null,
    liveVersions: [], retained: [], orphans: [], deleted: [], failed: [],
  };
  const skip = (reason: SnapshotGcSkipReason) => ({ ...report, skipped: reason, retained: [], orphans: [] });
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? SNAPSHOT_GC_DEFAULT_GRACE_MS;
  const keepVersions = Math.max(SNAPSHOT_GC_MIN_KEEP_VERSIONS, Math.floor(options.keepVersions ?? SNAPSHOT_GC_MIN_KEEP_VERSIONS));

  const files = await store.listFiles(dir);

  const live = new Set<string>();
  if (files.includes('current.json')) {
    const bytes = await store.getBytes(`${dir}/current.json`);
    if (bytes !== null) {
      const pointer = parsePointer(bytes);
      if (!pointer) return skip('unreadable_pointer');
      for (const version of [pointer.current, ...pointer.history.slice(-keepVersions)]) {
        if (VERSION.test(version)) live.add(version);
      }
    }
  }

  const referenced = new Set<string>();
  const canonical = await store.getBytes(`books/${stem}/index.json`);
  if (canonical !== null) {
    const refs = manifestRefs(canonical, true);
    if (!refs) return skip('unreadable_canonical');
    refs.refs.forEach(path => referenced.add(path));
  }

  const manifests = new Map<string, ManifestRefs>();
  for (const name of files) {
    const version = MANIFEST_FILE.exec(name)?.[1];
    if (!version) continue;
    const bytes = await store.getBytes(`${dir}/${name}`);
    if (bytes === null) continue;
    const refs = manifestRefs(bytes, false);
    if (!refs) return skip('unreadable_manifest');
    manifests.set(version, refs);
    const generated = refs.generatedAt === undefined ? Number.NaN : Date.parse(refs.generatedAt);
    // 生成时间读不出按新近算(保守);窗内的被拒候选/在途版本都算存活。
    if (!Number.isFinite(generated) || now - generated < graceMs) live.add(version);
  }

  for (const version of live) {
    const refs = manifests.get(version);
    // 存活版本的清单不在:不知道它引用了哪些卷,整本不动。
    if (!refs) return skip('missing_manifest');
    refs.refs.forEach(path => referenced.add(path));
  }

  report.liveVersions = [...live].sort();
  for (const name of files) {
    if (!VOLUME_SNAPSHOT_FILE.test(name)) continue;
    const path = `${dir}/${name}`;
    (referenced.has(path) ? report.retained : report.orphans).push(path);
  }
  report.retained.sort();
  report.orphans.sort();

  if (!options.execute || report.orphans.length === 0) return report;
  if (await options.isPublishing(stem)) return skip('publishing');
  for (const path of report.orphans) {
    try {
      await store.deleteFile(path);
      report.deleted.push(path);
    } catch {
      report.failed.push(path);
    }
  }
  return report;
}
