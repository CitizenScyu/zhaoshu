// T3:F03 五阶段发布器(快照 → 清单 → 规范 → 指针 → DB)。
//
// 从 zhaoshu-books/worker.mjs 的 publishArtifact 提取,按设计 §B.6/§D-T3 改造:
// - 每次状态变更写前都过 LeaseGuard(T1 v7 lease_generation fencing):失租约立即停止,
//   不再发下一跳 PUT。GitHub 与 DB 无分布式事务,已发出的 PUT 无法撤销,因此单写者
//   切换必须以「写前检查 + 新租约接管前确认旧进程退出」为前提(设计原文)。
// - 同内容重试不破坏清单:版本清单已存在且完整 hash 一致时保留原始字节
//   (首次发布的 task_id/generated_at 不被重写);同短版本(sha8)不同完整 hash 直接拒绝。
// - 晋升校验保留 90%/70% 门槛:候选章数 < 旧×0.9 或字数 < 旧×0.7 时规范路径与指针
//   都不动(旧完整版受保护),候选快照留档,任务层置 superseded_by_incomplete。
// - partial 候选永远到不了这里:任务层在 adapter 判定 incomplete 时零发布。
// - DB 阶段(第五阶段)在任务层 download-worker.ts 完成登记后收口。
//
// v2 分卷(设计 volume-split-design-doc.md §六):正文按 8 MiB 卷切分,**规范路径指向
// 章节/卷清单** `books/<stem>/index.json`,卷为同目录 `vol-00N.txt`。阅读器因此只按需
// 拉一个卷(整本正文永不下载、永不拼进内存),去掉 16 MiB 的整本天花板。
// 五阶段顺序不变,其中「清单最后写 = 提交点」:v2 的提交点是卷集合已就位后写下的清单。
//
// 本模块不触碰 DB、不做网络请求:GitHub 读写走注入的 GitHubContents,租约走注入的
// LeaseGuard,合成故障注入测试因此无需真实凭据(红线:不连生产、不真实联网)。

import { createHash } from 'node:crypto';
import { bookFilename } from './book-file-name';
import { MAX_READER_BYTES, parseTxtChapters, splitChapterParts } from './txt-chapters';
import type { TxtChapter } from './txt-chapters';
import { VOLUME_MANIFEST_FORMAT, VOLUME_MANIFEST_SCHEMA, stringifyVolumeManifest } from './volume-manifest';
import type { VolumeChapterEntry, VolumeEntry, VolumeManifest } from './volume-manifest';

export const SNAPSHOT_DIR = 'books/.snapshots';
export const CHAPTER_PROMOTION_RATIO = 0.9;
export const CHARS_PROMOTION_RATIO = 0.7;
export const SNAPSHOT_HISTORY_LIMIT = 20;
/** 分卷软目标:卷边界优先落在章起点,冷读一章的代价封顶一个软目标。 */
export const MAX_VOLUME_BYTES = 8 * 1024 * 1024;
/** 单章超软目标时独占一卷的硬上限(也是读端任何一次 raw 拉取的单文件上限)。 */
export const MAX_VOLUME_HARD_BYTES = MAX_READER_BYTES;
/** 发布侧**内存**上限(整本以字符串持有);超限仍 size_limit、仍零 PUT。二期按章流式写后解除。 */
export const MAX_BOOK_BYTES = 64 * 1024 * 1024;

export type PublicationStage = 'snapshot' | 'manifest' | 'canonical' | 'pointer';

/** T1 v7 fencing 的发布侧表现:守卫失败即失租约,调用方必须停止一切后续写。 */
export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  constructor() {
    super('download task lease lost; single writer must stop');
    this.name = 'LeaseLostError';
  }
}

/** 阶段化发布失败:错误码只含阶段名,不携带上游 URL/响应体/凭据。 */
export class PublicationStageError extends Error {
  readonly stage: PublicationStage;
  readonly detail: string;
  constructor(stage: PublicationStage, detail: string) {
    super(`publication stage failed: ${stage}:${detail}`);
    this.name = 'PublicationStageError';
    this.stage = stage;
    this.detail = detail;
  }
}

/** 同短版本(sha8)不同完整 hash:目录里已有别的整本顶着这个版本号,拒绝写入。 */
export class ManifestVersionConflictError extends Error {
  readonly code = 'MANIFEST_VERSION_CONFLICT';
  constructor(version: string) {
    super(`manifest version conflict: ${version}`);
    this.name = 'ManifestVersionConflictError';
  }
}

/** 版本清单(快照目录 <version>.json 的负载)。 */
export interface SnapshotManifest {
  version: string;
  blob_sha: string;
  chapters: number;
  chapters_total?: number;
  chars: number;
  generated_at?: string;
  task_id?: number | string;
  [key: string]: unknown;
}

/** 发布指针(current.json)。 */
export interface ReleasePointer {
  current: string;
  history: string[];
}

/**
 * 路径真源:规范路径指向**卷/章节清单**(`books/<stem>/index.json`),
 * 卷在规范目录 `vol-00N.txt`、快照在 `<dir>/v-<sha8>.txt`。
 *
 * 布局与书的大小解耦(所有发布统一卷布局)⇒ 规范路径永不因书变大而迁移;
 * download-worker.ts 与本函数同源,DB 声明的 canonical_path 与 GitHub 真写路径天然一致。
 */
export interface SnapshotPaths {
  stem: string;
  dir: string;
  canonicalPath: string;
  volumePath(index: number): string;
  snapshotVolumePath(sha8: string): string;
}

/** GitHub contents 读写接缝:测试注入内存实现;生产实现见 createGitHubContents。 */
export interface GitHubContents {
  put(path: string, text: string, message: string): Promise<void>;
  getBytes(path: string): Promise<Buffer | null>;
}

/** 写前租约检查;失败必须抛 LeaseLostError。 */
export interface LeaseGuard {
  check(): Promise<void>;
}

export function gitBlobSha(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0`).update(text, 'utf8').digest('hex');
}

/**
 * stem 以 `.` 开头时补 `_` 前缀防撞名(隐藏目录/隐藏文件语义)。
 * 文件名部分整体 encodeURIComponent:与阅读侧、下载侧同口径。
 */
export function snapshotPaths(title: string, author: string): SnapshotPaths {
  const filename = bookFilename(title, author);
  const stem = filename.replace(/\.txt$/, '');
  const safeStem = stem.startsWith('.') ? `_${stem}` : stem;
  const encoded = encodeURIComponent(safeStem);
  const booksDir = `books/${encoded}`;
  const snapshotDir = `${SNAPSHOT_DIR}/${encoded}`;
  return {
    stem: safeStem,
    dir: snapshotDir,
    canonicalPath: `${booksDir}/index.json`,
    volumePath: (index: number) => `${booksDir}/vol-${String(index + 1).padStart(3, '0')}.txt`,
    snapshotVolumePath: (sha8: string) => `${snapshotDir}/v-${sha8}.txt`,
  };
}

/** 新候选是否显著差于旧 manifest(章数 < 旧×0.9 或字数 < 旧×0.7)。 */
export function manifestIsWorse(
  oldManifest: SnapshotManifest | null,
  candidate: { chaptersDone: number; charsTotal: number },
): boolean {
  if (!oldManifest || typeof oldManifest.chapters !== 'number' || typeof oldManifest.chars !== 'number') return false;
  const chapterRatio = oldManifest.chapters > 0 ? candidate.chaptersDone / oldManifest.chapters : Infinity;
  const charsRatio = oldManifest.chars > 0 ? candidate.charsTotal / oldManifest.chars : Infinity;
  return chapterRatio < CHAPTER_PROMOTION_RATIO || charsRatio < CHARS_PROMOTION_RATIO;
}

export interface PublishCandidate {
  taskId: number | string;
  title: string;
  author: string;
  txt: string;
  chaptersDone: number;
  chaptersTotal: number;
  charsTotal: number;
  llmSummary?: string;
}

export interface PublishOptions {
  /** 分卷软目标(仅测试注入;生产用 MAX_VOLUME_BYTES)。 */
  maxVolumeBytes?: number;
  /** 发布侧内存上限(仅测试注入;生产用 MAX_BOOK_BYTES)。 */
  maxBookBytes?: number;
}

export type PublishOutcome =
  | {
      promoted: true;
      version: string;
      blobSha: string;
      canonicalPath: string;
      snapshotPath: string;
      bytes: number;
      volumeCount: number;
      manifest: SnapshotManifest;
    }
  | {
      promoted: false;
      reason: 'superseded_by_incomplete';
      version: string;
      blobSha: string;
      canonicalPath: string;
      oldManifest: SnapshotManifest | null;
      manifest: SnapshotManifest;
    };

function parseJson<T>(bytes: Buffer): T | null {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

function parseManifest(bytes: Buffer): SnapshotManifest | null {
  const value = parseJson<SnapshotManifest>(bytes);
  if (!value || typeof value.chapters !== 'number' || typeof value.chars !== 'number') return null;
  return value;
}

/**
 * 读回清单并核对是否就是本次版本。
 *
 * v2 规范清单(顶层 volumes/chapter_index)与旧的单文件 manifest 形状不同,但两者都带
 * `blob_sha` —— 那才是版本身份的判据。只看 chapters/chars 会把 v2 清单误判为「不是本次
 * 版本」并每次重写它(设计 §六.3/§六.5 的比对必须按 blob_sha)。
 */
function parseManifestBlobSha(bytes: Buffer): string | null {
  const value = parseJson<{ blob_sha?: unknown }>(bytes);
  return typeof value?.blob_sha === 'string' && /^[a-f0-9]{40}$/.test(value.blob_sha) ? value.blob_sha : null;
}

/** 失败原因只保留可读类别,不透传上游原文(脱敏红线)。 */
function stageDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'transport_error';
}

async function guarded(stage: PublicationStage, guard: LeaseGuard, operation: () => Promise<void>): Promise<void> {
  await guard.check();
  try {
    await operation();
  } catch (error) {
    // 失租约与版本冲突是调用方必须区分的语义错误,原样上抛。
    if (error instanceof LeaseLostError || error instanceof ManifestVersionConflictError) throw error;
    throw new PublicationStageError(stage, stageDetail(error));
  }
}

interface Baseline {
  pointer: ReleasePointer | null;
  /** current 指向版本的 manifest;指针缺失时退回规范路径内容 hash 对账。 */
  manifest: SnapshotManifest | null;
}

async function loadCurrentBaseline(github: GitHubContents, dir: string, canonicalPath: string): Promise<Baseline> {
  const pointerBytes = await github.getBytes(`${dir}/current.json`);
  if (pointerBytes === null) return fallbackBaseline(github, dir, canonicalPath);
  const pointer = parseJson<ReleasePointer>(pointerBytes);
  // 不是合法 JSON:无法程序化恢复,硬失败(人工删文件即恢复自动发布),与原 worker.mjs 的
  // JSON.parse 抛错同档(worker.mjs:328-329)。
  if (!pointer) throw new PublicationStageError('pointer', 'current_json_unreadable');
  // 合法 JSON 但指针形状不可用(current 非字符串 / history 非数组):按「指针不可用」走规范路径
  // 内容 hash 兜底,与下面 current 非 8-hex 同口径。参照 worker.mjs 也不是硬失败——形状不对的
  // current 经 readSnapshotManifest 返回 null → findCanonicalPriorVersion 兜底(worker.mjs:332,338)。
  // 这里不透传坏 pointer:非数组 history 若进下游 [...history] 会被逐字符 spread 污染(worker.mjs:351
  // 的潜伏 bug),故丢弃它、兜底后写一份干净的新 current.json。晋升保护不失效:fallbackBaseline
  // 仍按规范路径内容 hash 重建基线,manifestIsWorse 照旧生效,只有确无旧基线可比时才放行。
  if (typeof pointer.current !== 'string' || !Array.isArray(pointer.history)) {
    return fallbackBaseline(github, dir, canonicalPath);
  }
  // current 是合法 JSON 字符串但不是 8-hex 版本号:按「指针不可用」走规范路径内容 hash 兜底,
  // 与 !current/!oldManifest 同口径(原 worker !current || !oldManifest → findCanonicalPriorVersion)。
  // 直接返回 manifest:null 会让 manifestIsWorse 恒 false → 更差候选覆盖规范路径,晋升保护失效。
  if (!/^[a-f0-9]{8}$/.test(pointer.current)) return fallbackBaseline(github, dir, canonicalPath, pointer);
  const manifestBytes = await github.getBytes(`${dir}/${pointer.current}.json`);
  const manifest = manifestBytes === null ? null : parseManifest(manifestBytes);
  if (manifest) return { pointer, manifest };
  return fallbackBaseline(github, dir, canonicalPath, pointer);
}

/**
 * 兜底对账(原 worker findCanonicalPriorVersion):指针/manifest 缺失但规范路径已有旧文件时,
 * 按内容 hash 前缀找回快照 manifest;找不到(历史文件无快照)返回 null → 放行,不把存量书
 * 锁死在原地,也不把保护降级成「规范路径上随便什么都能覆盖」。
 *
 * v2 分支(设计 §六.7):规范路径是**清单**(`/index.json`)时清单自带 `version`,
 * 优先直接读 `${dir}/${version}.json`;读不到或清单不含 version 时退回「规范字节 hash」旧径
 * (旧单文件书与解析失败的现场都不因此失去晋升保护)。**必须配测试**。
 */
async function fallbackBaseline(
  github: GitHubContents, dir: string, canonicalPath: string, pointer: ReleasePointer | null = null,
): Promise<Baseline> {
  const canonical = await github.getBytes(canonicalPath);
  if (canonical === null) return { pointer, manifest: null };
  if (/\/index\.json$/.test(canonicalPath)) {
    const declared = parseJson<{ version?: unknown }>(canonical)?.version;
    if (typeof declared === 'string' && /^[a-f0-9]{8}$/.test(declared)) {
      const declaredBytes = await github.getBytes(`${dir}/${declared}.json`);
      const manifest = declaredBytes === null ? null : parseManifest(declaredBytes);
      if (manifest) return { pointer, manifest };
    }
  }
  const version = gitBlobSha(canonical.toString('utf8')).slice(0, 8);
  const manifestBytes = await github.getBytes(`${dir}/${version}.json`);
  return { pointer, manifest: manifestBytes === null ? null : parseManifest(manifestBytes) };
}

interface VolumeRange { startByte: number; endByte: number }

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** 硬上限处的安全切点:优先行尾,其次 UTF-8 码点边界(与 splitChapterParts 同口径)。 */
function safeCut(buf: Buffer, start: number, limit: number): number {
  let end = Math.min(limit, buf.byteLength);
  while (end > start && isContinuationByte(buf[end]!)) end--;
  if (end === start) end = Math.min(limit, buf.byteLength); // 找不到码点边界(不该发生):退回硬切,绝不返回空区间
  if (buf[end - 1] === 0x0d && buf[end] === 0x0a) end--;
  return end;
}

/**
 * 按章贪心装箱分卷(设计 §六)。
 * 卷边界**永远落在章起点**(`txt-chapters.ts` 保证章节连续无损)⇒ 卷拼接 === 原文逐字节。
 * 单章 > 软目标时独占一卷;单章 > 硬上限时按行边界(再退 UTF-8 码点)切开,该章跨卷 ——
 * 此时是唯一允许卷边界不落在章起点的情形。
 */
export function splitBookVolumes(buf: Buffer, chapters: TxtChapter[], maxVolumeBytes = MAX_VOLUME_BYTES): VolumeRange[] {
  const total = buf.byteLength;
  if (!total) return [];
  const starts = chapters.length ? chapters : [{ index: 0, title: '正文', startByte: 0, endByte: total }];
  const ranges: VolumeRange[] = [];
  let start = 0;
  let filled = 0; // 当前卷已累计到的末端(整章边界)

  const flush = (to: number) => {
    if (to > start) ranges.push({ startByte: start, endByte: to });
    start = to;
    filled = to;
  };

  for (const chapter of starts) {
    if (chapter.endByte <= filled) continue; // 已被前一个病态章跨卷覆盖
    const chapterStart = Math.max(chapter.startByte, filled);
    if (chapter.endByte - start <= maxVolumeBytes) {
      filled = chapter.endByte; // 整章装得下:推进整章边界
      continue;
    }
    if (filled > start) flush(filled); // 收掉已积累的整章卷,从章起点起新卷
    let cursor = Math.max(chapterStart, start);
    while (chapter.endByte - cursor > MAX_VOLUME_HARD_BYTES) {
      const cut = safeCut(buf, cursor, cursor + MAX_VOLUME_HARD_BYTES);
      flush(cut);
      cursor = cut;
    }
    filled = Math.max(filled, chapter.endByte);
    if (filled - start >= maxVolumeBytes) flush(filled);
  }
  flush(Math.max(filled, start));
  return ranges;
}

/** 产出章节索引:`s`/`e` 用**全书逻辑偏移**,`p` 用同函数在同字节上算出的段数。 */
export function buildChapterIndex(
  buf: Buffer, chapters: TxtChapter[], ranges: VolumeRange[], maxBookBytes = MAX_BOOK_BYTES,
): VolumeChapterEntry[] {
  return chapters.map((chapter, index) => {
    const volume = ranges.findIndex((range) => chapter.startByte >= range.startByte && chapter.startByte < range.endByte);
    // 段数口径必须与读端一致:同一字节范围、同一默认段上限(32 KiB),只把「整本大小上限」
    // 放宽到发布侧的内存上限,否则大书会被误判为超出上限而抛错。
    const parts = splitChapterParts(buf, chapter, undefined, maxBookBytes);
    return {
      i: index,
      t: chapter.title,
      v: volume < 0 ? 0 : volume,
      s: chapter.startByte,
      e: chapter.endByte,
      p: parts.length,
    };
  });
}

/**
 * 五阶段发布(GitHub 侧)。顺序:
 *   1 快照 逐卷 `<dir>/v-<sha8>.txt`(内容寻址,幂等 PUT;**绝不对卷调 getBytes**)
 *   2 清单 `<dir>/<version>.json`;同内容已存在且 blob_sha 一致 → 保留原字节
 *   (晋升校验:更差不晋升,直接返回 promoted:false,规范/指针零写入)
 *   3 规范 先逐卷 PUT `vol-00N.txt`,**最后** PUT `canonicalPath`(清单最后写 = 提交点)
 *   4 指针 current.json;current 已等于本版本 → 跳过 PUT(同内容重试不重写指针)
 * 每阶段写前 guard.check();LeaseLostError 原样上抛,其余失败收敛为 PublicationStageError。
 */
export async function publishBookVersion(
  github: GitHubContents,
  guard: LeaseGuard,
  candidate: PublishCandidate,
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  const maxBookBytes = options.maxBookBytes ?? MAX_BOOK_BYTES;
  const maxVolumeBytes = options.maxVolumeBytes ?? MAX_VOLUME_BYTES;
  const bytes = Buffer.byteLength(candidate.txt, 'utf8');
  if (bytes > maxBookBytes) {
    // 超限在第一个 PUT 之前失败,不把整包 base64 发出去(原 worker 预检语义)。
    throw new PublicationStageError('snapshot', 'size_limit');
  }
  const buf = Buffer.from(candidate.txt, 'utf8');
  const blobSha = gitBlobSha(candidate.txt);
  const version = blobSha.slice(0, 8);
  const paths = snapshotPaths(candidate.title, candidate.author);
  const { canonicalPath, dir } = paths;
  const label = `${candidate.title} - ${candidate.author}(${candidate.chaptersDone} 章 / ${candidate.charsTotal} 字)`;

  // 章节必须来自**同一次输入**:与阅读侧 parseTxtChapters 同函数同字节 ⇒ 同结果。
  const chapters = parseTxtChapters(buf, maxBookBytes);
  const ranges = splitBookVolumes(buf, chapters, maxVolumeBytes);
  const volumes = ranges.map((range, index) => {
    const text = buf.toString('utf8', range.startByte, range.endByte);
    const blob = gitBlobSha(text);
    const entry: VolumeEntry = {
      path: paths.volumePath(index),
      snapshot_path: paths.snapshotVolumePath(blob.slice(0, 8)),
      blob_sha: blob,
      bytes: range.endByte - range.startByte,
      first_byte: range.startByte,
      last_byte: range.endByte,
    };
    return { text, entry };
  });
  const chapterIndex = buildChapterIndex(buf, chapters, ranges, maxBookBytes);

  const manifest: VolumeManifest = {
    schema: VOLUME_MANIFEST_SCHEMA,
    format: VOLUME_MANIFEST_FORMAT,
    version,
    blob_sha: blobSha,
    bytes,
    chars: candidate.charsTotal,
    chapters: candidate.chaptersDone,
    chapters_total: candidate.chaptersTotal,
    title: candidate.title,
    author: candidate.author,
    generated_at: new Date().toISOString(),
    task_id: Number(candidate.taskId),
    volumes: volumes.map(({ entry }) => entry),
    chapter_index: chapterIndex,
  };
  const manifestText = stringifyVolumeManifest(candidate.llmSummary
    ? ({ ...manifest, llm: candidate.llmSummary } as VolumeManifest)
    : manifest);

  // 1. 快照卷:内容寻址幂等 PUT。绝不对卷调用 getBytes(1–100 MB 文件的 JSON 信封
  //    返回 encoding:"none" + 空 content;读端同样全程走 raw 流式)。
  await guarded('snapshot', guard, async () => {
    for (const volume of volumes) {
      await guard.check();
      await github.put(volume.entry.snapshot_path, volume.text, `snapshot: ${label}`);
    }
  });

  // 2. 清单:同版本已存在(且 blob_sha 一致)则保留原始字节。
  await guarded('manifest', guard, async () => {
    const existing = await github.getBytes(`${dir}/${version}.json`);
    if (existing !== null) {
      if (parseManifestBlobSha(existing) !== blobSha) throw new ManifestVersionConflictError(version);
      return; // 同内容重试:保留原始清单(首次发布的 task_id / generated_at 不被改写)
    }
    await github.put(`${dir}/${version}.json`, manifestText, `manifest: ${label} v${version}`);
  });

  await guard.check();
  let baseline: Baseline;
  try {
    baseline = await loadCurrentBaseline(github, dir, canonicalPath);
  } catch (error) {
    if (error instanceof PublicationStageError) throw error;
    // 基线读取(current.json/manifest/规范路径 GET)失败同属指针阶段的对账读取。
    throw new PublicationStageError('pointer', stageDetail(error));
  }
  if (manifestIsWorse(baseline.manifest, candidate)) {
    return {
      promoted: false, reason: 'superseded_by_incomplete',
      version, blobSha, canonicalPath, oldManifest: baseline.manifest,
      manifest: summaryManifest(manifest),
    };
  }

  // 3. 规范:先逐卷(内容比对跳过,不做无谓 PUT),最后清单 —— 清单落位即提交点。
  await guarded('canonical', guard, async () => {
    for (const volume of volumes) {
      await guard.check();
      const prior = await github.getBytes(volume.entry.path);
      // 卷 ≤ 16 MiB,getBytes 能读到(改 raw Accept 后 ≤100 MB 都行);相同则跳过 PUT。
      if (prior !== null && gitBlobSha(prior.toString('utf8')) === volume.entry.blob_sha) continue;
      await github.put(volume.entry.path, volume.text, `download: ${label}`);
    }
    await guard.check();
    const priorManifest = await github.getBytes(canonicalPath);
    if (priorManifest !== null && parseManifestBlobSha(priorManifest) === blobSha) return; // 已是本内容
    await github.put(canonicalPath, manifestText, `download: ${label}`);
  });

  await guarded('pointer', guard, async () => {
    if (baseline.pointer && baseline.pointer.current === version) return; // 指针已指本版本
    const history = [...new Set([...(baseline.pointer?.history ?? []), version])].slice(-SNAPSHOT_HISTORY_LIMIT);
    await github.put(`${dir}/current.json`, `${JSON.stringify({ current: version, history }, null, 2)}\n`,
      `release: ${label} v${version}`);
  });

  return {
    promoted: true, version, blobSha, canonicalPath,
    // DB 的 snapshot_path 指向**清单**快照(设计 §十一):它才是该版本的完整描述。
    snapshotPath: `${dir}/${version}.json`, bytes, volumeCount: volumes.length,
    manifest: summaryManifest(manifest),
  };
}

/** 结果里回传的是「清单摘要」语义(chapters/chars 供晋升比对),与旧的 SnapshotManifest 同形。 */
function summaryManifest(manifest: VolumeManifest): SnapshotManifest {
  return {
    version: manifest.version,
    blob_sha: manifest.blob_sha,
    chapters: manifest.chapters,
    chapters_total: manifest.chapters_total,
    chars: manifest.chars,
    generated_at: manifest.generated_at,
    task_id: manifest.task_id,
  };
}
