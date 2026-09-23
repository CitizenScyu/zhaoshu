// T3：下载执行器任务层（单写者循环：领取 → 心跳 → adapter 抓取 → 五阶段发布 → DB 终态）。
//
// 从 zhaoshu-books/worker.mjs 提取，按设计 §B.2/§B.3/§B.4/§D-T3 改造：
// - 租约：claimDownloadTask（T1 v7 lease_generation fencing）；所有任务状态写
//   （心跳/进度/终态）都带 generation+owner 条件，失租约 → LeaseLostError → 停止，不复活。
// - 单写者：同一任务只有一个 running 租约；发布器每阶段写前 guard.check()。
// - 发布对账：五阶段 = 快照/manifest/规范/指针（download-publisher）+ DB 登记（本模块）。
//   partial/failed 候选零发布（只返回未晋升候选时也零规范/指针写入）。
// - adapter 接缝：SourceAdapter 抽象——book15 builtin 与引擎源两条腿（引擎腿调
//   scripts/engine-download.mjs 的 downloadBook，进程内 adapter 形态，参数数组调用）。
// - 运行不做 DDL：schema 由专用迁移负责；本模块只 DML。
//
// 测试注入 PGlite + mock GitHubContents + mock transport，不真实联网、不连生产。

import { createHash } from 'node:crypto';
import type { DownloadTaskLease } from './download-task-queue';
import {
  LeaseLostError, publishBookVersion, PublicationStageError, snapshotPaths,
  type GitHubContents, type PublishOutcome,
} from './download-publisher';
import { artifactIdentityKey } from './artifact-registry';
import type { TxtChapter } from './txt-chapters';

export { LeaseLostError };

export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;
export const WORKER_TASK_TIMEOUT_MS = 330 * 60_000;
export const PROGRESS_EVERY = 50;

export interface TaskRow {
  id: number;
  book_id: number;
  title: string;
  author: string;
  status: string;
  source_url: string;
  source_kind: string;
  source_id: string | null;
  requested_by: 'user' | 'system';
}

export type AdapterOutcome =
  | {
      kind: 'complete'; txt: string; chaptersTotal: number; chaptersDone: number; charsTotal: number;
      /** 引擎章节边界（txt 的 UTF-8 字节偏移，首尾相接铺满全书）；给了发布器就不再按标题二次解析。 */
      chapterRanges?: TxtChapter[];
    }
  | { kind: 'incomplete'; reason: string; chaptersTotal: number; chaptersDone: number; charsTotal: number }
  | { kind: 'failure'; code: string };

export interface SourceAdapterContext {
  /** 任务层提供的租约信号：adapter 中断后应立即停止抓取。 */
  signal: AbortSignal;
  /** 进度回调：转写为租约条件的心跳/进度 SQL。抛错立即中断。 */
  progress(update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }): Promise<void>;
}

export interface SourceAdapter {
  /** 稳定源标识（任务 source_kind/source_id 之外的运行形态区分），仅用于日志与对账。 */
  readonly kind: 'builtin' | 'engine';
  download(task: TaskRow, context: SourceAdapterContext): Promise<AdapterOutcome>;
}

export interface WorkerStorage {
  /** 领取一个 pending 任务（含 v7 租约递增）。返回 null 表示队列空。 */
  claim(owner: string): Promise<DownloadTaskLease | null>;
  /** 读取被领取任务的完整行。 */
  taskRow(id: number): Promise<TaskRow | null>;
  /** 心跳（租约条件）；false = 失租约。 */
  heartbeat(lease: DownloadTaskLease): Promise<boolean>;
  /** 进度（租约条件）；false = 失租约。 */
  progress(lease: DownloadTaskLease, update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }): Promise<boolean>;
  /** 终态（租约条件）；false = 失租约。 */
  finish(lease: DownloadTaskLease, result: { status: 'done' | 'failed' | 'partial' | 'superseded_by_incomplete'; error?: string }): Promise<boolean>;
  /** T2 发布对账的 DB 前置：写前登记路径声明。 */
  reserveArtifactPath(input: { labeledBookId: number; identityKey: string; repositoryId: number; branch: string; canonicalPath: string }): Promise<number>;
  /** DB 阶段收口：登记已发布产物并把任务指向 artifact_id。 */
  registerArtifact(input: {
    artifactId: number; version: string; blobSha: string; bytes: number;
    chaptersTotal: number; chaptersDone: number; charsTotal: number; sourceRevision: string;
    snapshotPath: string;
  }): Promise<boolean>;
}

/** PG 严格 text 禁 \x00 与孤立代理对（zhaoshu-books cleanPgText 同形）。 */
export function cleanPgText(value: string): string {
  return String(value ?? '')
    .replace(/\x00/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '\u{fffd}')
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\u{fffd}');
}

export class TaskLeaseLostError extends Error {
  readonly code = 'TASK_LEASE_LOST';
  constructor() {
    super('download task lease lost; worker stops without terminal write');
    this.name = 'TaskLeaseLostError';
  }
}

/** 泛化为「失权停止」：发布器 LeaseLostError 与任务层 TaskLeaseLostError 共用这一个判据。 */
export function isLeaseLostError(error: unknown): boolean {
  return error instanceof LeaseLostError || error instanceof TaskLeaseLostError;
}

/** 任务预算耗尽的归一判据：worker 侧定时器与引擎侧定时器共用 `budget_exhausted` 字面量。 */
export function isBudgetExhausted(error: unknown): boolean {
  return error instanceof Error && error.message === 'budget_exhausted';
}

/**
 * 写终态前的 abort 守卫。
 * `taskTimer` 以 `budget_exhausted` abort 合成 signal 后，adapter 已把结果归一为 incomplete；
 * 若此处无条件 `throwIfAborted()`，partial 写入被跳过、外层 catch 落 failed，与预算归一目标矛盾。
 * 预算耗尽仍持有租约，按 adapter 已分类结果收口；失权（心跳 abort 的 TaskLeaseLostError）必须抛、不得写终态。
 */
function throwIfAbortedUnlessBudget(signal: AbortSignal): void {
  if (!isBudgetExhausted(signal.reason)) signal.throwIfAborted();
}

/**
 * 心跳定时器（zhaoshu-books task-heartbeat 的 v7 化形态）：
 * 每 60s 一次租约条件心跳；连续失败置 signal，抓取/发布链路立即停。
 */
export function startLeaseHeartbeat(storage: WorkerStorage, lease: DownloadTaskLease, intervalMs = WORKER_HEARTBEAT_INTERVAL_MS) {
  const controller = new AbortController();
  let stopped = false;
  let pending: Promise<void> | null = null;
  const pulse = async () => {
    if (controller.signal.aborted) return;
    if (stopped) return;
    if (pending) return pending;
    pending = (async () => {
      const alive = await storage.heartbeat(lease);
      if (!alive) throw new TaskLeaseLostError();
    })().catch(error => {
      if (error instanceof TaskLeaseLostError) controller.abort(error);
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void pulse().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    check: pulse,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending?.catch(() => {});
    },
  };
}

export interface WorkerOptions {
  storage: WorkerStorage;
  github: GitHubContents;
  adapters: SourceAdapter[];
  /** 任务总预算（默认 330 分钟）。 */
  taskTimeoutMs?: number;
  /** 供发布对账的 DB 侧目标仓（T2 registry）。 */
  repositoryId: number;
  branch: string;
}

export interface WorkerResult {
  /** 领取并处理了一个任务（true）还是队列空/失租约停止（false）。 */
  processed: boolean;
  terminal?: 'done' | 'failed' | 'partial' | 'superseded_by_incomplete';
  reason?: string;
}

function selectAdapter(adapters: SourceAdapter[], task: TaskRow): SourceAdapter {
  // 引擎腿按任务 source_kind 显式选择；builtin 兜底两条腿都存在时的默认。
  const wanted = task.source_kind === 'engine' ? 'engine' : 'builtin';
  return adapters.find(adapter => adapter.kind === wanted) ?? adapters[0];
}

/** 单任务执行：领取（已由调用方完成）→ adapter → 五阶段发布 → DB 终态。 */
export async function runDownloadTask(
  options: WorkerOptions,
  lease: DownloadTaskLease,
): Promise<WorkerResult> {
  const { storage, github, repositoryId, branch } = options;
  const task = await storage.taskRow(lease.id);
  if (!task) throw new Error('claimed task row missing');
  if (task.status !== 'running') {
    // 领取语句与行读取之间被回收/终态化：停止，不写任何状态。
    return { processed: false, reason: 'task_not_running_after_claim' };
  }

  const heartbeat = startLeaseHeartbeat(storage, lease);
  const taskDeadline = new AbortController();
  // 预算耗尽的 reason 用引擎已知码 `budget_exhausted`（不是带空格的描述串）：下载器 knownError
  // 会把它归入 incomplete（检查点可续传），而不是当源站失败写 failed 终态。
  const taskTimer = setTimeout(() => taskDeadline.abort(new Error('budget_exhausted')), options.taskTimeoutMs ?? WORKER_TASK_TIMEOUT_MS);
  const signal = AbortSignal.any([heartbeat.signal, taskDeadline.signal]);
  let sawProgress = 0;

  try {
    await heartbeat.check();
    const adapter = selectAdapter(options.adapters, task);
    const outcome = await adapter.download(task, {
      signal,
      async progress(update) {
        // adapter 进度即心跳数据通道：写失败（失租约）立即中断抓取。
        sawProgress = update.chaptersDone;
        const alive = await storage.progress(lease, update);
        if (!alive) throw new TaskLeaseLostError();
      },
    });

    if (outcome.kind === 'incomplete') {
      // partial 零发布：任何 GitHub PUT 都没发生，DB 只写终态。
      await heartbeat.stop();
      throwIfAbortedUnlessBudget(signal);
      // 源不可用是「没尝试成抓取」，章数 0/0 读作缺章会误导——按源侧措辞落库。
      const detail = outcome.reason === 'source_unavailable'
        ? '源不可用（未尝试抓取）：source_unavailable'
        : `缺章 ${outcome.chaptersDone}/${outcome.chaptersTotal}：${outcome.reason}`;
      const written = await storage.finish(lease, {
        status: 'partial',
        error: cleanPgText(detail.slice(0, 4000)),
      });
      if (!written) throw new TaskLeaseLostError();
      return { processed: true, terminal: 'partial', reason: outcome.reason };
    }
    if (outcome.kind === 'failure') {
      await heartbeat.stop();
      throwIfAbortedUnlessBudget(signal);
      const written = await storage.finish(lease, { status: 'failed', error: outcome.code.slice(0, 4000) });
      if (!written) throw new TaskLeaseLostError();
      return { processed: true, terminal: 'failed', reason: outcome.code };
    }

    // complete → 五阶段发布。DB 前置：T2 reserveArtifactPath（identity_key 唯一，
    // 同身份重复发布取回同一 artifact id）。
    const { canonicalPath, dir } = snapshotPaths(task.title, task.author);
    const artifactId = await storage.reserveArtifactPath({
      labeledBookId: task.book_id,
      identityKey: artifactIdentityKey(task.title, task.author),
      repositoryId, branch, canonicalPath,
    });

    await heartbeat.check();
    let release: PublishOutcome;
    try {
      release = await publishBookVersion(github, {
        check: async () => {
          const alive = await storage.heartbeat(lease);
          if (!alive) throw new LeaseLostError();
        },
      }, {
        taskId: task.id,
        title: task.title,
        author: task.author,
        txt: outcome.txt,
        chaptersDone: outcome.chaptersDone,
        chaptersTotal: outcome.chaptersTotal,
        charsTotal: outcome.charsTotal,
        chapterRanges: outcome.chapterRanges,
      });
    } catch (error) {
      if (error instanceof LeaseLostError || error instanceof PublicationStageError) throw error;
      throw new Error(`publication_failed:${(error as { code?: string })?.code ?? 'unknown'}`);
    }

    if (!release.promoted) {
      await heartbeat.stop();
      throwIfAbortedUnlessBudget(signal);
      const written = await storage.finish(lease, {
        status: 'superseded_by_incomplete',
        error: cleanPgText([
          `更差版本不晋升：新版 ${outcome.chaptersDone} 章 / ${outcome.charsTotal} 字，`
          + `已发布版 ${release.oldManifest?.chapters ?? '?'} 章 / ${release.oldManifest?.chars ?? '?'} 字`,
          `候选快照留档 ${dir}/${release.version}.json，人工确认后可手动晋升`,
        ].join('\n').slice(0, 4000)),
      });
      if (!written) throw new TaskLeaseLostError();
      return { processed: true, terminal: 'superseded_by_incomplete' };
    }

    // 第五阶段（DB）：登记已发布产物并指向任务行；失败按可对账恢复的 failed 收口，
    // 快照/manifest 已落库，修复器凭完整 hash 与目标路径补登记，不重复下载。
    await heartbeat.stop();
    throwIfAbortedUnlessBudget(signal);
    const registered = await storage.registerArtifact({
      artifactId, version: release.version, blobSha: release.blobSha, bytes: release.bytes,
      chaptersTotal: outcome.chaptersTotal, chaptersDone: outcome.chaptersDone,
      charsTotal: outcome.charsTotal, sourceRevision: '', snapshotPath: release.snapshotPath,
    });
    if (!registered) throw new TaskLeaseLostError();
    const written = await storage.finish(lease, { status: 'done', error: '' });
    if (!written) throw new TaskLeaseLostError();
    return { processed: true, terminal: 'done' };
  } catch (error) {
    await heartbeat.stop();
    if (isLeaseLostError(error) || signal.reason instanceof TaskLeaseLostError || signal.reason instanceof LeaseLostError) {
      // 失租约：不写终态（行已不属于本租约），让接管者/回收器决定后续。
      return { processed: false, reason: 'lease_lost' };
    }
    // 其余异常：failed（租约条件写；失败不影响单写者——本租约仍持有）。
    await storage.finish(lease, {
      status: 'failed',
      error: cleanPgText((error instanceof Error ? error.message : String(error)).slice(0, 4000)),
    }).catch(() => undefined);
    return { processed: true, terminal: 'failed', reason: (error as Error).message };
  } finally {
    clearTimeout(taskTimer);
    await heartbeat.stop();
    void sawProgress;
  }
}

/** 一次 worker 运行：领取一个任务并处理（设计 §B.4：进程内有界 drain loop 的单步）。 */
export async function runWorkerOnce(options: WorkerOptions, owner: string): Promise<WorkerResult> {
  const lease = await options.storage.claim(owner);
  if (!lease) return { processed: false, reason: 'queue_empty' };
  return runDownloadTask(options, lease);
}

// ---- book15 builtin 腿（进程内 adapter；真实部署放运行包，见 §C）----

/**
 * engine-download CLI 以 adapter 形态接入的公共接缝：调用方注入 downloadBook 实现与
 * resolveSource（参数数组形态由调用方组装，不在本模块拼 shell 字符串）。
 * book15 builtin 与引擎源两条腿由同一 downloadBook 承担（其内部按 builtin 分支）。
 */
export interface EngineDownloadLike {
  (m: unknown, args: Record<string, unknown>, resolveSource: (m: unknown, url: string, signal: AbortSignal) => Promise<unknown>,
    transport?: unknown, hooks?: { signal?: AbortSignal; onProgress?: (update: { chaptersDone: number; chaptersTotal: number; charsTotal: number }) => Promise<void> }): Promise<{
      code: number;
      manifest: {
        status: string;
        errors: string[];
        chapters_total?: number;
        chapters_done?: number;
        chars?: number;
        artifact?: { file: string; sha256: string; bytes: number };
        chapters?: EngineChapterRecord[];
      };
    }>;
}

export interface EngineAdapterOptions {
  downloadBook: EngineDownloadLike;
  modules: unknown;
  resolveSource: (m: unknown, url: string, signal: AbortSignal) => Promise<unknown>;
  transport?: unknown;
  /** 读结果目录拼接 TXT 的方式：默认 require manifest.artifact 由 downloadBook 已写 book.txt。 */
  readBookText: (manifest: { artifact: { file: string } }, options: { out: string }) => Promise<string>;
  outRoot: string;
  /** 引擎腿固定参数（与 CLI 契约一致的有界值）。 */
  maxChapters?: number;
  rateMs?: number;
  timeoutMs?: number;
  budgetMs?: number;
  sourceKind?: 'builtin' | 'engine';
}

/** 引擎清单里单章的记录（engine-download.mjs 每章写 title/chars/sha256/status，这里只取这四个字段）。 */
export interface EngineChapterRecord {
  title?: unknown;
  chars?: unknown;
  sha256?: unknown;
  status?: unknown;
}

/**
 * 按引擎拼整本的真实方式还原每章在 txt 里的字节边界：engine-download.mjs 把整本拼成逐章
 * `${title}\n\n${正文}\n\n` 的顺序串接（book.txt 即此串）。逐章核对——标题逐字相符、正文码点数
 * 等于记录的 chars（`[...text].length` 口径）、正文 sha256 等于记录值、段尾是 `\n\n`，全部走完
 * 恰好到 txt 结尾；任一不符返回 null（调用方不给边界，发布器退回解析，不猜）。
 * 章名去掉首尾空白：阅读端按「首行 trim 后等于章名」去掉重复的标题行（ReaderClient）。
 */
export function engineChapterRanges(txt: string, chapters: readonly EngineChapterRecord[] | undefined): TxtChapter[] | null {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const ranges: TxtChapter[] = [];
  let at = 0; // UTF-16 下标
  let byte = 0; // UTF-8 字节偏移
  for (const [index, chapter] of chapters.entries()) {
    const record: EngineChapterRecord = chapter ?? {};
    const { title, chars, sha256 } = record;
    if (record.status !== 'done' || typeof title !== 'string' || typeof sha256 !== 'string'
      || typeof chars !== 'number' || !Number.isSafeInteger(chars) || chars < 0) return null;
    const head = `${title}\n\n`;
    if (!txt.startsWith(head, at)) return null;
    const bodyStart = at + head.length;
    let bodyEnd = bodyStart;
    // 按码点走 chars 步（代理对算一个），与引擎 [...text].length 同口径。
    for (let step = 0; step < chars; step++) {
      if (bodyEnd >= txt.length) return null;
      bodyEnd += txt.codePointAt(bodyEnd)! > 0xffff ? 2 : 1;
    }
    if (!txt.startsWith('\n\n', bodyEnd)) return null;
    const body = txt.slice(bodyStart, bodyEnd);
    if (createHash('sha256').update(body).digest('hex') !== sha256) return null;
    const size = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(body, 'utf8') + 2;
    ranges.push({ index, title: title.trim(), startByte: byte, endByte: byte + size });
    byte += size;
    at = bodyEnd + 2;
  }
  return at === txt.length ? ranges : null;
}

/** engine-download → SourceAdapter 的桥：code=0 完整；其余按 manifest.errors 分类。 */
export function createEngineAdapter(options: EngineAdapterOptions): SourceAdapter {
  const kind = options.sourceKind ?? 'engine';
  return {
    kind,
    async download(task, context) {
      const out = `${options.outRoot}/${createHash('sha256').update(`${task.source_url}|${task.title}|${task.author}`).digest('hex').slice(0, 24)}`;
      let result;
      try {
        result = await options.downloadBook(options.modules, {
          source: task.source_url,
          title: task.title,
          author: task.author,
          out,
          'max-chapters': options.maxChapters ?? 20000,
          'rate-ms': options.rateMs ?? 800,
          'timeout-ms': options.timeoutMs ?? 30000,
          'budget-ms': options.budgetMs ?? 19800000,
        }, options.resolveSource, options.transport, {
          signal: context.signal,
          onProgress: update => context.progress(update),
        });
      } catch (error) {
        // 心跳失权由 startLeaseHeartbeat 以 TaskLeaseLostError 实例 abort（见 :117），
        // 判据收窄到「reason 是失权错误」——task signal 上的普通 abort（预算耗尽）不算失权。
        if (isLeaseLostError(error) || isLeaseLostError(context.signal.reason)) throw new TaskLeaseLostError();
        // 任务预算耗尽（worker 侧定时器）不是源站失败：按可续传的 incomplete 收口，
        // 与引擎自身 budget 定时器的 budget_exhausted 分类一致（检查点保留，下次续传）。
        if (isBudgetExhausted(error) || isBudgetExhausted(context.signal.reason)) {
          return { kind: 'incomplete', reason: 'budget_exhausted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
        }
        return { kind: 'failure', code: /^[a-z0-9_]+$/.test((error as Error).message) ? (error as Error).message : 'adapter_runtime_error' };
      }
      const manifest = result.manifest;
      const chaptersTotal = manifest.chapters_total ?? 0;
      const chaptersDone = manifest.chapters_done ?? 0;
      const charsTotal = manifest.chars ?? 0;
      if (result.code === 0 && manifest.status === 'done' && manifest.artifact) {
        // 读回整本：book.txt 由 engine-download 在完整校验通过后原子写入。
        const txt = await options.readBookText({ artifact: manifest.artifact }, { out });
        // 章节边界取引擎拼接时的真实偏移：发布器若按标题二次解析，源站标题不规整（「13.第13章」
        // 「完本感言」）就会并章/拆章，清单 chapter_index 与 chapters 对不上，读端判清单无效（生产 502）。
        // 还原不出或章数对不上就不给，发布器退回解析（行为同旧）。
        const chapterRanges = engineChapterRanges(txt, manifest.chapters);
        return {
          kind: 'complete', txt, chaptersTotal, chaptersDone, charsTotal,
          ...(chapterRanges && chapterRanges.length === chaptersDone ? { chapterRanges } : {}),
        };
      }
      const reason = manifest.errors[0] ?? 'incomplete';
      // downloadBook 正常返回但外部租约信号已触发：抓取是被任务层中止的，属失权停止，
      // 不是源站问题——交回任务层按 lease_lost 收口（无终态写入）。
      if (context.signal.aborted && isLeaseLostError(context.signal.reason)) throw new TaskLeaseLostError();
      // 任务预算耗尽按「谁触发的」归一：外部 abort reason 透传到章循环后不再匹配引擎 knownError，
      // errors[0] 会退化成兜底 download_failed；此时真实语义是可续传的预算耗尽。
      // code=2 是 P2-5 的退出码契约（源不可用=没尝试成抓取，与普通运行失败不同档）：单列分类，
      // 按可重试的 incomplete 收口（零发布、候选保留），不与代码缺陷混同在 failed 桶。
      const classified = isBudgetExhausted(context.signal.reason) ? 'budget_exhausted'
        : result.code === 2 ? 'source_unavailable' : reason;
      if (classified === 'source_unavailable' || classified === 'missing_chapters' || classified === 'toc_changed' || classified === 'budget_exhausted' || classified === 'interrupted' || classified === 'operation_timeout') {
        return { kind: 'incomplete', reason: classified, chaptersTotal, chaptersDone, charsTotal };
      }
      return { kind: 'failure', code: classified };
    },
  };
}
