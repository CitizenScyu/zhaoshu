// T8 接线：生产装配入口（shell 的 main.mjs 在非 dummy 模式动态 import 本模块）。
//
// 只做装配：从环境键名取真值（值只进 neon/fetch 头，绝不打印）→ 建 sql/github/engine 模块 →
// 反查发布目标仓主键 → createExecutor。预算、限速器、决策表、日志由 shell 注入（单一实例）。
// esbuild 把它与 T3 模块打成一个自包含 ESM；@neondatabase/serverless 作为外部依赖随 tar 分发。

import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { downloadBook } from '../scripts/engine-download.mjs';
import {
  createEngineAdapter, type EngineDownloadLike, type PublicationRolloverSeam, type SourceAdapter, type WorkerStorage,
} from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import { createWorkerStorage } from './storage';
import { createGitHubContents } from './github-contents';
import { assembleEngineModules, createResolveSource, createSourceTransport, loadEnginePool, type EngineModules, type RateLimiterLike, type ResolvedSource } from './engine';
import { readBookText } from './read-book-text';
import { resolveRepositoryId } from './repository';
import { withoutProcessSignals } from './without-process-signals';
import { createBudgetRefund } from './budget-refund';
import { createIdentityPrecheck } from './identity-precheck';
import { createBuiltinFallback } from './builtin-fallback';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike, type DownloadExecutor, type LoopDecisions } from './executor';
import { dbQuotaBackoffMs, recordDbQuotaSeen } from '../src/lib/db-quota';
// capacity991：rollover 决策端口的生产装配（端口合同在 wiring、候选形状在 rollover 纯决策模块）。
import { RolloverWiringEvidenceError, type RolloverEvidencePort } from './repository-rollover-wiring';
import type { AdmissionStatus, RepositoryCandidate, RepositoryTuple } from './repository-rollover';

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

// ---------------------------------------------------------------------------
// capacity991：rollover 决策端口的生产装配
//
// 端口合同见 repository-rollover-wiring.ts（RolloverEvidencePort）；候选形状见
// repository-rollover.ts（RepositoryCandidate）。装配期只**读**：storage_repositories
// 注册行 + repository_capacity_ledger 已对账账目（state='ready'），逐行组装证据。
// 证据缺失/形状非法一律抛 RolloverWiringEvidenceError（模块语义：不静默降级、不按 0 猜），
// 由 wiring 层原样上抛到既有失败路径（发布失败收口），绝不放行「照旧写旧仓」。
// ---------------------------------------------------------------------------

/** neon HTTP 驱动对 bigint 列返回口径不一（bigint/number/十进制 string），统一规范为非负 bigint。 */
function rolloverBigint(value: unknown, column: string): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new RolloverWiringEvidenceError(`column ${column} is not a non-negative integer`);
  if (parsed < BigInt(0)) throw new RolloverWiringEvidenceError(`column ${column} is negative`);
  return parsed;
}

function rolloverText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RolloverWiringEvidenceError(`field ${field} is missing`);
  }
  return value;
}

function rolloverPositiveInt(value: unknown, field: string): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw new RolloverWiringEvidenceError(`field ${field} is not a positive integer`);
  }
  return n;
}

/** LEFT JOIN 后单行形状（storage_repositories 列 + repository_capacity_ledger 列）。 */
interface RolloverCandidateRow {
  id: unknown; owner: unknown; repo: unknown; branch: unknown;
  enabled: unknown; is_private: unknown; read_only: unknown; sealed_at: unknown;
  ledger_state: unknown; baseline_epoch: unknown; target_bytes: unknown;
  registered_bytes: unknown; reserved_bytes: unknown;
  admission_status: unknown; admission_version: unknown;
  admission_valid_until: unknown; admission_target: unknown;
}

/** 单行 → RepositoryCandidate；任何证据缺失/形状非法即抛（不降级）。 */
function toRepositoryCandidate(row: RolloverCandidateRow): RepositoryCandidate {
  const id = rolloverPositiveInt(row.id, 'id');
  const owner = rolloverText(row.owner, 'owner');
  const repo = rolloverText(row.repo, 'repo');
  const branch = rolloverText(row.branch, 'branch');
  // 四门可写标志（显式 boolean，缺失/非 boolean 即抛——纯决策要求显式 boolean，不许被当 false 放行）。
  for (const [field, value] of [['enabled', row.enabled], ['is_private', row.is_private], ['read_only', row.read_only]] as const) {
    if (typeof value !== 'boolean') throw new RolloverWiringEvidenceError(`field ${field} is not boolean`);
  }
  // 账目证据：必须已对账（state='ready'）且有非空版本（baseline_epoch）；否则无可信容量证据，抛。
  if (row.ledger_state !== 'ready') {
    throw new RolloverWiringEvidenceError(`repository ${id} has no ready capacity ledger`);
  }
  const version = rolloverText(row.baseline_epoch, 'baseline_epoch');
  const target: RepositoryTuple = { id, owner, repo, branch };
  // 账目 validUntil：ledger 无独立账目期限列，取同账行的准入期限作为可信窗口上界（缺失=null⇒决策判 unknown）。
  const admissionValidUntil = typeof row.admission_valid_until === 'string' ? row.admission_valid_until : null;
  const accounting = {
    registeredLogicalBytes: rolloverBigint(row.registered_bytes, 'registered_bytes'),
    reservedLogicalBytes: rolloverBigint(row.reserved_bytes, 'reserved_bytes'),
    version, validUntil: admissionValidUntil, target,
  };
  // 外部准入：状态/版本/期限来自账行；目标元组须与本仓一致（错绑即抛，不产可写计划）。
  const admissionStatus = row.admission_status;
  if (admissionStatus !== 'granted' && admissionStatus !== 'denied' && admissionStatus !== 'unknown') {
    throw new RolloverWiringEvidenceError(`repository ${id} admission_status invalid`);
  }
  const admissionTarget = row.admission_target as { repositoryId?: unknown; branch?: unknown } | null | undefined;
  if (admissionTarget == null || typeof admissionTarget !== 'object') {
    throw new RolloverWiringEvidenceError(`repository ${id} admission_target missing`);
  }
  if (rolloverPositiveInt(admissionTarget.repositoryId, 'admission_target.repositoryId') !== id
    || rolloverText(admissionTarget.branch, 'admission_target.branch') !== branch) {
    throw new RolloverWiringEvidenceError(`repository ${id} admission_target does not bind this repository`);
  }
  return {
    ...target,
    enabled: row.enabled as boolean,
    isPrivate: row.is_private as boolean,
    readOnly: row.read_only as boolean,
    sealed: row.sealed_at !== null && row.sealed_at !== undefined,
    targetBytes: rolloverBigint(row.target_bytes, 'target_bytes'),
    accounting,
    externalAdmission: {
      status: admissionStatus as AdmissionStatus,
      version: typeof row.admission_version === 'string' ? row.admission_version : null,
      validUntil: admissionValidUntil,
      target,
    },
  };
}

/** 生产证据端口：有序候选（按 id 升序，优先序即数组顺序）+ 显式时钟。 */
export function createRolloverEvidencePort(
  sql: ReturnType<typeof neon>,
  log: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void,
): RolloverEvidencePort {
  return {
    async listCandidates() {
      let rows: RolloverCandidateRow[];
      try {
        rows = await sql`
          SELECT r.id, r.owner, r.repo, r.branch, r.enabled, r.is_private, r.read_only, r.sealed_at,
                 l.state AS ledger_state, l.baseline_epoch, l.target_bytes,
                 l.registered_bytes, l.reserved_bytes,
                 l.admission_status, l.admission_version, l.admission_valid_until, l.admission_target
          FROM storage_repositories r
          LEFT JOIN repository_capacity_ledger l ON l.repository_id = r.id
          ORDER BY r.id ASC` as unknown as RolloverCandidateRow[];
      } catch (error) {
        // 端口故障 = 容量未知：上抛（wiring 层转 RolloverWiringEvidenceError），不降级回旧仓。
        throw new RolloverWiringEvidenceError(`candidate query failed: ${(error as Error)?.message?.slice(0, 120) ?? ''}`);
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new RolloverWiringEvidenceError('no registered repositories');
      }
      // 只记数量，不含仓名/凭据。
      log('info', 'rollover 候选证据装配', { candidates: rows.length });
      return rows.map(toRepositoryCandidate);
    },
    now: () => new Date(),
  };
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

  let sql: ReturnType<typeof neon> | undefined;
  const storage = options.storage ?? createWorkerStorage(
    (sql = neon(requiredEnv(env, 'DATABASE_URL'))),
  );

  let repositoryId = options.repositoryId;
  if (repositoryId === undefined) {
    if (!sql) sql = neon(requiredEnv(env, 'DATABASE_URL'));
    repositoryId = await resolveRepositoryId(sql, target!);
  }
  const github = hasGithub ? options.github! : createGitHubContents({
    token: requiredEnv(env, 'GITHUB_TOKEN'),
    repository: target!.repository,
    branch: target!.branch,
  });

  // capacity991：rollover 决策缝装配。缺省关（未设 ZHAOSHU_ROLLOVER_ENABLED=1）= 不注入，
  // 生产语义与 986 前逐字一致。开则构造真端口：listCandidates 查注册行 + 对账账目（拿不到即抛，
  // 不降级）；now=装配期时钟；current=装配期仓元组；rebuildGitHubContents=按 target 用同配置重建闭包。
  const rolloverEnabled = env.ZHAOSHU_ROLLOVER_ENABLED === '1';
  let rollover: PublicationRolloverSeam | undefined;
  if (rolloverEnabled) {
    // 端口需要仓 owner/repo 元组，只有默认装配路径（从 ZHAOSHU_BOOKS_REPO 解析出 target）才有；
    // 完整 DI（注入 github/repositoryId）不带 owner/repo，开开关即证据不可得，抛（不静默降级）。
    if (!target) throw new RolloverWiringEvidenceError('rollover requires the default storage target assembly');
    if (!sql) sql = neon(requiredEnv(env, 'DATABASE_URL'));
    const rolloverSql = sql;
    const current: RepositoryTuple = { id: repositoryId, owner: target.owner, repo: target.repo, branch: target.branch };
    rollover = {
      port: createRolloverEvidencePort(rolloverSql, log),
      current,
      // switch 时按新仓元组用与装配期相同的配置重建 GitHubContents 闭包（token 留在装配期）。
      rebuildGitHubContents: (t: RepositoryTuple) => createGitHubContents({
        token: requiredEnv(env, 'GITHUB_TOKEN'),
        repository: `${t.owner}/${t.repo}`,
        branch: t.branch,
      }),
    };
  }

  const modules = options.modules ?? assembleEngineModules();
  const resolveSource = options.resolveSource ?? createResolveSource(modules);
  const transport = options.transport ?? createSourceTransport(options.rateLimiter);

  const outRoot = join(options.workDir, 'out');
  // 常驻 drain：包一层去掉 downloadBook 对 process 的 SIGINT/SIGTERM 注册（外部停机由 hooks.signal
  // 覆盖）；不然每本调用累积进程监听。并发=1，同一时刻只有一次 downloadBook 在跑。
  const engineDownload = withoutProcessSignals(
    (options.engineDownload ?? downloadBook) as unknown as (...a: unknown[]) => Promise<unknown>,
  ) as unknown as EngineDownloadLike;
  // book15 不可达时 builtin 任务回退引擎源池（41-T8FB，见 builtin-fallback.ts）。默认开；
  // DOWNLOAD_ENGINE_FALLBACK=0 关（回到引入前行为：只退避等 book15）。测试注入 adapters 时不装（包的是默认两条腿）。
  const fallback = options.adapters || env.DOWNLOAD_ENGINE_FALLBACK === '0'
    ? undefined
    : createBuiltinFallback({
      modules, transport, log,
      loadPool: options.loadEnginePool ?? (signal => loadEnginePool(modules, signal)),
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
  const adapters = options.adapters ?? ([
    engineAdapter,
    fallback ? fallback.wrapAdapter(builtinAdapter, engineAdapter) : builtinAdapter,
  ]);

  // 扣额度前的身份预检默认开；DOWNLOAD_IDENTITY_PRECHECK=0 关（回到引入前行为：书源不可达只在下载中判出、
  // 事后退还日预算）。与下载腿共用 modules/resolveSource/transport（同一个运行时限速器）。
  const identityPrecheck = env.DOWNLOAD_IDENTITY_PRECHECK === '0'
    ? undefined
    : createIdentityPrecheck({ modules, resolveSource, transport });
  // 回退开启时预检多一步：book15 不可达就在扣额度前选好引擎源，选不到仍按不可达退避（不扣额度）。
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
    ...(rollover ? { rollover } : {}),
    // 数据库配额（Neon 402）长退避：默认 30 分钟，env DB_QUOTA_BACKOFF_MS 覆盖；恢复后在 cron_health 补记。
    quotaBackoffMs: dbQuotaBackoffMs(env),
    recordQuotaSeen: quotaSql ? (seenAt => recordDbQuotaSeen(quotaSql, seenAt)) : undefined,
  });
}
