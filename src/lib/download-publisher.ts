// T3：F03 五阶段发布器（快照 → manifest → 规范 → 指针 → DB）。
//
// 从 zhaoshu-books/worker.mjs 的 publishArtifact 提取，按设计 §B.6/§D-T3 改造：
// - 每次状态变更写前都过 LeaseGuard（T1 v7 lease_generation fencing）：失租约立即停止，
//   不再发下一跳 PUT。GitHub 与 DB 无分布式事务，已发出的 PUT 无法撤销，因此单写者
//   切换必须以「写前检查 + 新租约接管前确认旧进程退出」为前提（设计原文）。
// - 同内容重试不破坏 manifest：版本 manifest 已存在且完整 hash 一致时保留原始字节
//   （首次发布的 task_id/generated_at 不被重写）；同短版本（sha8）不同完整 hash 直接拒绝。
// - 晋升校验保留 90%/70% 门槛：候选章数 < 旧×0.9 或字数 < 旧×0.7 时规范路径与指针
//   都不动（旧完整版受保护），候选快照留档，任务层置 superseded_by_incomplete。
// - partial 候选永远到不了这里：任务层在 adapter 判定 incomplete 时零发布。
// - DB 阶段（第五阶段）在任务层 download-worker.ts 完成登记后收口。
//
// 本模块不触碰 DB、不做网络请求：GitHub 读写走注入的 GitHubContents，租约走注入的
// LeaseGuard，合成故障注入测试因此无需真实凭据（红线：不连生产、不真实联网）。

import { createHash } from 'node:crypto';
import { bookFilename } from './book-file-name';

export const SNAPSHOT_DIR = 'books/.snapshots';
export const CHAPTER_PROMOTION_RATIO = 0.9;
export const CHARS_PROMOTION_RATIO = 0.7;
export const SNAPSHOT_HISTORY_LIMIT = 20;
export const MAX_TXT_BYTES = 15 * 1024 * 1024;

export type PublicationStage = 'snapshot' | 'manifest' | 'canonical' | 'pointer';

/** T1 v7 fencing 的发布侧表现：守卫失败即失租约，调用方必须停止一切后续写。 */
export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  constructor() {
    super('download task lease lost; single writer must stop');
    this.name = 'LeaseLostError';
  }
}

/** 阶段化发布失败：错误码只含阶段名，不携带上游 URL/响应体/凭据。 */
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

/** 同短版本（sha8）不同完整 hash：目录里已有别的整本顶着这个版本号，拒绝写入。 */
export class ManifestVersionConflictError extends Error {
  readonly code = 'MANIFEST_VERSION_CONFLICT';
  constructor(version: string) {
    super(`manifest version conflict: ${version}`);
    this.name = 'ManifestVersionConflictError';
  }
}

/** 版本清单（快照目录 <version>.json 的负载）。 */
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

/** 发布指针（current.json）。 */
export interface ReleasePointer {
  current: string;
  history: string[];
}

/** GitHub contents 读写接缝：测试注入内存实现；生产实现见 createGitHubContents。 */
export interface GitHubContents {
  put(path: string, text: string, message: string): Promise<void>;
  getBytes(path: string): Promise<Buffer | null>;
}

/** 写前租约检查；失败必须抛 LeaseLostError。 */
export interface LeaseGuard {
  check(): Promise<void>;
}

export function gitBlobSha(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0`).update(text, 'utf8').digest('hex');
}

export function snapshotPaths(title: string, author: string): { stem: string; canonicalPath: string; dir: string } {
  const filename = bookFilename(title, author);
  const stem = filename.replace(/\.txt$/, '');
  return {
    stem,
    canonicalPath: `books/${encodeURIComponent(filename)}`,
    dir: `${SNAPSHOT_DIR}/${encodeURIComponent(stem)}`,
  };
}

/** 新候选是否显著差于旧 manifest（章数 < 旧×0.9 或字数 < 旧×0.7）。 */
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

export type PublishOutcome =
  | {
      promoted: true;
      version: string;
      blobSha: string;
      canonicalPath: string;
      snapshotPath: string;
      bytes: number;
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

/** 失败原因只保留可读类别，不透传上游原文（脱敏红线）。 */
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
    // 失租约与版本冲突是调用方必须区分的语义错误，原样上抛。
    if (error instanceof LeaseLostError || error instanceof ManifestVersionConflictError) throw error;
    throw new PublicationStageError(stage, stageDetail(error));
  }
}

interface Baseline {
  pointer: ReleasePointer | null;
  /** current 指向版本的 manifest；指针缺失时退回规范路径内容 hash 对账。 */
  manifest: SnapshotManifest | null;
}

async function loadCurrentBaseline(github: GitHubContents, dir: string, canonicalPath: string): Promise<Baseline> {
  const pointerBytes = await github.getBytes(`${dir}/current.json`);
  if (pointerBytes === null) return fallbackBaseline(github, dir, canonicalPath);
  const pointer = parseJson<ReleasePointer>(pointerBytes);
  if (!pointer || typeof pointer.current !== 'string' || !Array.isArray(pointer.history)) {
    // 指针损坏时静默放行会绕过晋升保护，按可人工修复的硬失败处理（同原 worker 语义）。
    throw new PublicationStageError('pointer', 'current_json_unreadable');
  }
  // current 是合法 JSON 字符串但不是 8-hex 版本号：按「指针不可用」走规范路径内容 hash 兜底，
  // 与 !current/!oldManifest 同口径（原 worker !current || !oldManifest → findCanonicalPriorVersion）。
  // 直接返回 manifest:null 会让 manifestIsWorse 恒 false → 更差候选覆盖规范路径，晋升保护失效。
  if (!/^[a-f0-9]{8}$/.test(pointer.current)) return fallbackBaseline(github, dir, canonicalPath, pointer);
  const manifestBytes = await github.getBytes(`${dir}/${pointer.current}.json`);
  const manifest = manifestBytes === null ? null : parseManifest(manifestBytes);
  if (manifest) return { pointer, manifest };
  return fallbackBaseline(github, dir, canonicalPath, pointer);
}

/**
 * 兜底对账（原 worker findCanonicalPriorVersion）：指针/manifest 缺失但规范路径已有旧文件时，
 * 按内容 hash 前缀找回快照 manifest；找不到（历史文件无快照）返回 null → 放行，不把存量书
 * 锁死在原地，也不把保护降级成「规范路径上随便什么都能覆盖」。
 */
async function fallbackBaseline(
  github: GitHubContents, dir: string, canonicalPath: string, pointer: ReleasePointer | null = null,
): Promise<Baseline> {
  const canonical = await github.getBytes(canonicalPath);
  if (canonical === null) return { pointer, manifest: null };
  const version = gitBlobSha(canonical.toString('utf8')).slice(0, 8);
  const manifestBytes = await github.getBytes(`${dir}/${version}.json`);
  return { pointer, manifest: manifestBytes === null ? null : parseManifest(manifestBytes) };
}

/**
 * 五阶段发布的前四阶段（GitHub 侧）。顺序：
 *   1 快照   books/.snapshots/<stem>/<sha8>.txt（内容寻址，幂等 PUT）
 *   2 manifest 同目录 <sha8>.json；同版本已存在且完整 hash 一致 → 保留原 manifest 不重写
 *   （晋升校验：更差不晋升，直接返回 promoted:false，规范/指针零写入）
 *   3 规范   books/<名>.txt；已发布同内容（完整 hash 一致）→ 跳过 PUT
 *   4 指针   current.json；current 已等于本版本 → 跳过 PUT（同内容重试不重写指针）
 * 每阶段写前 guard.check()；LeaseLostError 原样上抛，其余失败收敛为 PublicationStageError。
 */
export async function publishBookVersion(
  github: GitHubContents,
  guard: LeaseGuard,
  candidate: PublishCandidate,
): Promise<PublishOutcome> {
  const bytes = Buffer.byteLength(candidate.txt, 'utf8');
  if (bytes > MAX_TXT_BYTES) {
    // 超限在第一个 PUT 之前失败，不把整包 base64 发出去（原 worker 预检语义）。
    throw new PublicationStageError('snapshot', 'size_limit');
  }
  const blobSha = gitBlobSha(candidate.txt);
  const version = blobSha.slice(0, 8);
  const { canonicalPath, dir } = snapshotPaths(candidate.title, candidate.author);
  const label = `${candidate.title} - ${candidate.author}（${candidate.chaptersDone} 章 / ${candidate.charsTotal} 字）`;
  const manifest: SnapshotManifest = {
    version,
    blob_sha: blobSha,
    chapters: candidate.chaptersDone,
    chapters_total: candidate.chaptersTotal,
    chars: candidate.charsTotal,
    generated_at: new Date().toISOString(),
    task_id: Number(candidate.taskId),
    ...(candidate.llmSummary ? { llm: candidate.llmSummary } : {}),
  };

  await guarded('snapshot', guard, () =>
    github.put(`${dir}/${version}.txt`, candidate.txt, `snapshot: ${label}`));

  await guarded('manifest', guard, async () => {
    const existing = await github.getBytes(`${dir}/${version}.json`);
    if (existing !== null) {
      const prior = parseManifest(existing);
      if (!prior || prior.blob_sha !== blobSha) throw new ManifestVersionConflictError(version);
      return; // 同内容重试：保留原始 manifest（首次发布的 task_id / generated_at 不被改写）
    }
    await github.put(`${dir}/${version}.json`, `${JSON.stringify(manifest, null, 2)}\n`, `manifest: ${label} v${version}`);
  });

  await guard.check();
  let baseline: Baseline;
  try {
    baseline = await loadCurrentBaseline(github, dir, canonicalPath);
  } catch (error) {
    if (error instanceof PublicationStageError) throw error;
    // 基线读取（current.json/manifest/规范路径 GET）失败同属指针阶段的对账读取。
    throw new PublicationStageError('pointer', stageDetail(error));
  }
  if (manifestIsWorse(baseline.manifest, candidate)) {
    return {
      promoted: false, reason: 'superseded_by_incomplete',
      version, blobSha, canonicalPath, oldManifest: baseline.manifest, manifest,
    };
  }

  await guarded('canonical', guard, async () => {
    const prior = await github.getBytes(canonicalPath);
    if (prior !== null && gitBlobSha(prior.toString('utf8')) === blobSha) return; // 已是本内容，跳过
    await github.put(canonicalPath, candidate.txt, `download: ${label}`);
  });

  await guarded('pointer', guard, async () => {
    if (baseline.pointer && baseline.pointer.current === version) return; // 指针已指本版本
    const history = [...new Set([...(baseline.pointer?.history ?? []), version])].slice(-SNAPSHOT_HISTORY_LIMIT);
    await github.put(`${dir}/current.json`, `${JSON.stringify({ current: version, history }, null, 2)}\n`,
      `release: ${label} v${version}`);
  });

  return {
    promoted: true, version, blobSha, canonicalPath,
    snapshotPath: `${dir}/${version}.txt`, bytes, manifest,
  };
}
