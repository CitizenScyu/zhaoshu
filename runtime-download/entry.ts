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
} from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import { createWorkerStorage } from './storage';
import { createGitHubContents } from './github-contents';
import { assembleEngineModules, createResolveSource, createSourceTransport, type EngineModules, type RateLimiterLike, type ResolvedSource } from './engine';
import { readBookText } from './read-book-text';
import { resolveRepositoryId } from './repository';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike, type DownloadExecutor, type LoopDecisions } from './executor';

export type { DownloadExecutor, DailyBudgetLike, LoopDecisions } from './executor';

export interface RuntimeStorage extends WorkerStorage {
  releaseClaim(lease: Parameters<WorkerStorage['heartbeat']>[0]): Promise<boolean>;
}

export interface ProductionExecutorOptions {
  budget: DailyBudgetLike;
  /** 运行包工作目录（out 落地处）；由 shell 的状态目录派生。 */
  workDir: string;
  rateLimiter?: RateLimiterLike;
  decisions?: LoopDecisions;
  log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  owner?: string;
  taskTimeoutMs?: number;
  // ---- 测试注入缝（生产均走默认装配）----
  storage?: RuntimeStorage;
  github?: GitHubContents;
  modules?: EngineModules;
  resolveSource?: (m: unknown, url: string, signal: AbortSignal) => Promise<ResolvedSource>;
  transport?: ReturnType<typeof createSourceTransport>;
  adapters?: SourceAdapter[];
  engineDownload?: EngineDownloadLike;
  repositoryId?: number;
  branch?: string;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment key: ${key}`); // 只报键名
  return value;
}

export async function createDownloadExecutor(options: ProductionExecutorOptions): Promise<DownloadExecutor> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const branch = options.branch ?? env.DOWNLOAD_TARGET_BRANCH ?? 'main';

  let sql: ReturnType<typeof neon> | undefined;
  const storage = options.storage ?? createWorkerStorage(
    (sql = neon(requiredEnv(env, 'DATABASE_URL'))),
  );

  const github = options.github ?? createGitHubContents({
    token: requiredEnv(env, 'GITHUB_TOKEN'),
    repository: requiredEnv(env, 'GITHUB_REPOSITORY'),
  });

  const modules = options.modules ?? assembleEngineModules();
  const resolveSource = options.resolveSource ?? createResolveSource(modules);
  const transport = options.transport ?? createSourceTransport(options.rateLimiter);

  const outRoot = join(options.workDir, 'out');
  const adapters = options.adapters ?? ([
    createEngineAdapter({
      downloadBook: (options.engineDownload ?? downloadBook) as unknown as EngineDownloadLike,
      modules, resolveSource, transport, readBookText, outRoot, sourceKind: 'engine',
    }),
    // builtin book15 任务（source_kind='builtin'）走同一 downloadBook 的 source-parser 分支。
    createEngineAdapter({
      downloadBook: (options.engineDownload ?? downloadBook) as unknown as EngineDownloadLike,
      modules, resolveSource, transport, readBookText, outRoot, sourceKind: 'builtin',
    }),
  ]);

  let repositoryId = options.repositoryId;
  if (repositoryId === undefined) {
    if (!sql) sql = neon(requiredEnv(env, 'DATABASE_URL'));
    const [owner, repo, extra] = requiredEnv(env, 'GITHUB_REPOSITORY').split('/');
    if (!owner || !repo || extra !== undefined) throw new Error('GITHUB_REPOSITORY must be owner/repo');
    repositoryId = await resolveRepositoryId(sql, { owner, repo, branch });
  }

  log('info', '执行器装配完成', { repositoryId, branch, owner: options.owner ?? `service-${process.pid}` });

  return createExecutor({
    storage: storage as RuntimeStorage,
    github,
    adapters,
    budget: options.budget,
    repositoryId,
    branch,
    owner: options.owner ?? `service-${process.pid}`,
    taskTimeoutMs: options.taskTimeoutMs,
    decisions: options.decisions ?? DEFAULT_DECISIONS,
  });
}
