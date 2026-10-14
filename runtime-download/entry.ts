// T8 接线：生产装配入口（shell 的 main.mjs 在非 dummy 模式动态 import 本模块）。
//
// 只做装配：从环境键名取真值（值只进 neon/fetch 头，绝不打印）→ 建 sql/github/engine 模块 →
// 反查发布目标仓主键 → createExecutor。预算、限速器、决策表、日志由 shell 注入（单一实例）。
// esbuild 把它与 T3 模块打成一个自包含 ESM；@neondatabase/serverless 作为外部依赖随 tar 分发。

import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { downloadBook } from '../scripts/engine-download.mjs';
import {
  createEngineAdapter, type EngineDownloadLike, type SourceAdapter, type WorkerStorage,
  WORKER_TASK_TIMEOUT_MS,
} from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import { createWorkerStorage } from './storage';
import { createGitHubContents } from './github-contents';
import {
  assembleEngineModules, createResolveSource, createSourceTransport, loadEnginePool,
  type EngineModules, type RateLimiterLike, type ResolvedSource,
} from './engine';
import { readBookText } from './read-book-text';
import { resolveRepositoryId } from './repository';
import { withoutProcessSignals } from './without-process-signals';
import { createBudgetRefund } from './budget-refund';
import { createIdentityPrecheck } from './identity-precheck';
import { createBuiltinFallback } from './builtin-fallback';
import { createHostOccupancy, type HostOccupancy } from './host-occupancy';
import {
  failedCandidateSources, markCandidateFailure, occupiedHosts, replaceSourceCandidates,
  usableSourceCandidates,
} from '../src/lib/download-source-candidates';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike, type DownloadExecutor, type LoopDecisions } from './executor';
import { dbQuotaBackoffMs, recordDbQuotaSeen } from '../src/lib/db-quota';

export type { DownloadExecutor, DailyBudgetLike, LoopDecisions } from './executor';

export interface RuntimeStorage extends WorkerStorage {
  releaseClaim(lease: Parameters<WorkerStorage['heartbeat']>[0]): Promise<boolean>;
}

export interface ProductionExecutorOptions {
  budget: DailyBudgetLike;
  /**
   * shell 日预算状态文件（main.mjs 的 join(stateDir,'daily-budget.json')，由打包注入传入）。
   * 给出时书源不可达的尝试退还日预算；缺省则照旧计入（装配日志会提示）。
   */
  budgetStatePath?: string;
  /**
   * shell 日预算上限（main.mjs 的 config.dailyBookLimit，由打包注入传入）。shell 的 read() 只回
   * {date, used}，扣额度前预检靠它判断「今天已满就不预检」；缺省时上限未知，预检照跑（装配日志会提示）。
   */
  budgetLimit?: number;
  /** 运行包工作目录（out 落地处）；由 shell 的状态目录派生。 */
  workDir: string;
  rateLimiter?: RateLimiterLike;
  decisions?: LoopDecisions;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  owner?: string;
  taskTimeoutMs?: number;
  /** 默认存储目标owner/repo；缺省使用ZHAOSHU_BOOKS_REPO，与执行仓无关。完整DI时不使用。 */
  repository?: string;
  // ---- 测试注入缝（生产均走默认装配）----
  storage?: RuntimeStorage;
  github?: GitHubContents;
  modules?: EngineModules;
  resolveSource?: (m: unknown, url: string, signal: AbortSignal) => Promise<ResolvedSource>;
  transport?: ReturnType<typeof createSourceTransport>;
  adapters?: SourceAdapter[];
  engineDownload?: EngineDownloadLike;
  loadEnginePool?: (signal: AbortSignal) => Promise<Array<{ url: string; name: string; searchUrl: unknown }>>;
  repositoryId?: number;
  branch?: string;
  /** 合成注入 sql（PGlite 等）：候选持久化/占位门与默认 storage/repository 共用同一实例。 */
  sql?: ReturnType<typeof neon>;
  /** 注入 host 占用门（默认 sql 路径自建）。 */
  hostOccupancy?: HostOccupancy;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment key: ${key}`); // 只报键名
  return value;
}

function storageTarget(value: unknown, branch: string) {
  if (value === undefined) throw new Error('MISSING_STORAGE_REPOSITORY');
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('INVALID_STORAGE_REPOSITORY');
  const parts = value.trim().split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('INVALID_STORAGE_REPOSITORY');
  }
  return { owner, repo, branch, repository: `${owner}/${repo}` };
}

export async function createDownloadExecutor(options: ProductionExecutorOptions): Promise<DownloadExecutor> {
  const hasGithub = options.github !== undefined;
  const hasRepositoryId = options.repositoryId !== undefined;
  if (hasGithub !== hasRepositoryId) throw new Error('STORAGE_TARGET_INJECTION_PAIR_REQUIRED');
  if (hasRepositoryId && (typeof options.repositoryId !== 'number'
    || !Number.isSafeInteger(options.repositoryId) || options.repositoryId <= 0)) {
    throw new Error('INVALID_STORAGE_REPOSITORY_ID');
  }
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const branch = options.branch ?? env.DOWNLOAD_TARGET_BRANCH ?? 'main';
  if (typeof branch !== 'string' || !branch.trim()) throw new Error('INVALID_STORAGE_BRANCH');
  const target = hasGithub ? undefined
    : storageTarget(options.repository !== undefined ? options.repository : env.ZHAOSHU_BOOKS_REPO, branch);

  let sql = options.sql;
  const storage = options.storage ?? createWorkerStorage(
    (sql ??= neon(requiredEnv(env, 'DATABASE_URL'))),
  );

  let repositoryId = options.repositoryId;
  if (repositoryId === undefined) {
    sql ??= neon(requiredEnv(env, 'DATABASE_URL'));
    repositoryId = await resolveRepositoryId(sql, target!);
  }
  const github = hasGithub ? options.github! : createGitHubContents({
    token: requiredEnv(env, 'GITHUB_TOKEN'),
    repository: target!.repository,
    branch: target!.branch,
  });

  const modules = options.modules ?? assembleEngineModules();
  const resolveSource = options.resolveSource ?? createResolveSource(modules);
  // 物理 host 互斥（bsrcfix-20261007）：默认 sql 路径建 hostOccupancy，对默认 transport（注入
  // transport ?? createSourceTransport）wrapTransport——下载腿 runDownload 作用域内按真实物理
  // 发射 host 占位（download TTL）、作用域外（预检/回退选源）每次调用自起 prefetch 作用域
  // （scan TTL）。TTL：download 与任务超时同源 + 10 分钟余量，scan 固定 6 分钟。
  const hostOccupancy = options.hostOccupancy ?? (sql
    ? createHostOccupancy(sql, {
      downloadTtlMs: (options.taskTimeoutMs ?? WORKER_TASK_TIMEOUT_MS) + 600_000,
      scanTtlMs: 360_000,
    })
    : undefined);
  const baseTransport = options.transport ?? createSourceTransport(options.rateLimiter);
  const transport = hostOccupancy ? hostOccupancy.wrapTransport(baseTransport) : baseTransport;

  const outRoot = join(options.workDir, 'out');
  // 常驻 drain：包一层去掉 downloadBook 对 process 的 SIGINT/SIGTERM 注册（外部停机由 hooks.signal
  // 覆盖）；不然每本调用累积进程监听。并发=1，同一时刻只有一次 downloadBook 在跑。
  const engineDownload = withoutProcessSignals(
    (options.engineDownload ?? downloadBook) as unknown as (...a: unknown[]) => Promise<unknown>,
  ) as unknown as EngineDownloadLike;
  // book15 不可达时 builtin 任务回退引擎源池（41-T8FB，见 builtin-fallback.ts）。默认开；
  // DOWNLOAD_ENGINE_FALLBACK=0 关（回到引入前行为：只退避等 book15）。测试注入 adapters 时不装
  // （包的是默认两条腿）。bsrcfix-41：注入候选源持久化接缝（0005 候选表；host 占位已改由
  // hostOccupancy 物理门负责，fallback 不再 coarse occupy）。
  const candidateSql = sql;
  const fallback = options.adapters || env.DOWNLOAD_ENGINE_FALLBACK === '0'
    ? undefined
    : createBuiltinFallback({
      modules, transport, log,
      loadPool: options.loadEnginePool ?? (signal => loadEnginePool(modules, signal)),
      ...(candidateSql ? {
        candidates: {
          usable: (bookId) => usableSourceCandidates(candidateSql, bookId),
          failedSources: (bookId) => failedCandidateSources(candidateSql, bookId),
          replace: (bookId, sources) => replaceSourceCandidates(candidateSql, bookId, sources),
          markFailure: (bookId, url, kind, reason) => markCandidateFailure(candidateSql, bookId, url, kind, reason),
          occupiedHosts: () => occupiedHosts(candidateSql),
        },
      } : {}),
    });
  const engineAdapter = createEngineAdapter({
    downloadBook: engineDownload,
    modules, resolveSource, transport, readBookText, outRoot, sourceKind: 'engine',
  });
  // builtin book15 任务（source_kind='builtin'）走同一 downloadBook 的 source-parser 分支。
  const builtinAdapter = createEngineAdapter({
    downloadBook: engineDownload,
    modules, resolveSource, transport, readBookText, outRoot, sourceKind: 'builtin',
  });
  // 每次引擎 download 各自一个物理占用作用域：fallback 换源调用的是已包装的 engine 腿，
  // 上一个源的作用域已在 engine.download 返回（finally 释放）后才进下一个源——没有整个
  // fallback 一大作用域，也不同与物理门自冲突。占位门不可用（无 sql）时腿保持原样。
  const scoped = hostOccupancy && !options.adapters
    ? (adapter: SourceAdapter): SourceAdapter => ({
      kind: adapter.kind,
      async download(task, context) {
        return hostOccupancy!.runDownload(task.id, context.signal, () => adapter.download(task, context));
      },
    })
    : (adapter: SourceAdapter): SourceAdapter => adapter;
  const scopedEngine = scoped(engineAdapter);
  const scopedBuiltin = scoped(builtinAdapter);
  const adapters = options.adapters ?? [
    fallback ? fallback.wrapAdapter(scopedEngine, scopedEngine, 'engine') : scopedEngine,
    fallback ? fallback.wrapAdapter(scopedBuiltin, scopedEngine) : scopedBuiltin,
  ];

  // 扣额度前的身份预检默认开；DOWNLOAD_IDENTITY_PRECHECK=0 关（回到引入前行为：书源不可达只在下载中判出、
  // 事后退还日预算）。与下载腿共用 modules/resolveSource/transport（同一个运行时限速器）。
  const identityPrecheck = env.DOWNLOAD_IDENTITY_PRECHECK === '0'
    ? undefined
    : createIdentityPrecheck({ modules, resolveSource, transport });
  // 回退开启时预检多一步：原始源不可达（book15/引擎源）就在扣额度前选好引擎候选，
  // 选不到仍按不可达退避（不扣额度）。927 复核点 3：engine 任务无候选时也先过原预检。
  const precheck = identityPrecheck && fallback ? fallback.wrapPrecheck(identityPrecheck) : identityPrecheck;

  // shell 的 read() 只回 {date, used}：用打包注入的上限补齐 DailyBudgetLike 契约（缺省保持未知）。
  const budget: DailyBudgetLike = {
    read: async () => {
      const state = await options.budget.read();
      return { used: state.used, limit: state.limit ?? options.budgetLimit };
    },
    consume: () => options.budget.consume(),
  };

  log('info', '执行器装配完成', {
    repositoryId, branch, owner: options.owner ?? `service-${process.pid}`, identityPrecheck: Boolean(precheck),
    engineFallback: Boolean(fallback),
  });
  if (!options.budgetStatePath) log('error', '日预算退还未接线：书源不可达仍会计入日预算', {});
  if (precheck && options.budgetLimit === undefined) log('error', '日预算上限未接线：额度已满时仍会跑身份预检', {});

  const quotaSql = sql;
  return createExecutor({
    storage: storage as RuntimeStorage,
    github,
    adapters,
    budget,
    refundBudget: options.budgetStatePath ? createBudgetRefund({ statePath: options.budgetStatePath }) : undefined,
    precheck,
    log,
    repositoryId,
    branch,
    owner: options.owner ?? `service-${process.pid}`,
    taskTimeoutMs: options.taskTimeoutMs,
    decisions: options.decisions ?? DEFAULT_DECISIONS,
    // 数据库配额（Neon 402）长退避：默认 30 分钟，env DB_QUOTA_BACKOFF_MS 覆盖；恢复后在 cron_health 补记。
    quotaBackoffMs: dbQuotaBackoffMs(env),
    recordQuotaSeen: quotaSql ? (seenAt => recordDbQuotaSeen(quotaSql, seenAt)) : undefined,
  });
}
