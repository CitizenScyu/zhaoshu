// Pure production template; no filesystem, environment or build dependencies.
// Renders the B-line prefetch service entry. The build script writes it into the
// deployed package as runtime/service/prefetch.mjs (the 883 shell source has no
// such file). Same-package reuse only: env/log-filter/instance-lock/shared-rate/drain.
// Contract deltas vs download main.mjs: shared-rate backend mandatory with
// minIntervalMs >= 1000, no daily budget, separate prefetch.instance.lock, prefetch
// round outcomes map completed -> TASK_DONE, anything else -> NO_TASK, exceptions go
// to the existing drain backoff. Error logs carry fixed reason codes only
// (executor_error/fatal/unhandled_rejection/startup_failed): upstream error text may
// embed SQL/connection details that collectSecrets cannot reliably mask. The rendered
// source contains no backticks and no interpolations on purpose: this generator must
// stay a plain literal.
// 静态来源门：只核已知装配接缝的源码形态，不 import/执行所选 shell，不读环境真值。
// 这不是共享限速的运行验收；逐次许可/账本/20 实例仍需独立验证。
export function assertSharedRuntimeShell(sources) {
  const env = sources['lib/env.mjs'] ?? '';
  const bindings = [
    /dataRoot:\s*env\.DOWNLOAD_SHARED_RATE_DIR\b/,
    /controlFile:\s*env\.DOWNLOAD_RATE_CONTROL_FILE\b/,
    /authorityId:\s*env\.DOWNLOAD_RATE_AUTHORITY_ID\b/,
    /expectedEpoch:\s*env\.DOWNLOAD_RATE_EXPECTED_EPOCH\b/,
    /config\.sharedRate\s*=\s*sharedRate\b/,
  ];
  if (!bindings.every(binding => binding.test(env))) throw new Error('RUNTIME_SHELL_SHARED_ENV_INCOMPATIBLE');
  const main = sources['service/main.mjs'] ?? '';
  if (!main.includes("'../lib/env.mjs'")
    || !/startSharedRateSupervisor\(\{\s*sharedRate:\s*config\.sharedRate\s*,\s*stateDir\s*\}/.test(main)
    || !/rateLimiter\s*=\s*startup\.limiter\b/.test(main)) {
    throw new Error('RUNTIME_SHELL_SHARED_DOWNLOAD_INCOMPATIBLE');
  }
  for (const [path, symbol] of [
    ['lib/shared-rate/limiter.mjs', 'createSharedRateLimiter'],
    ['lib/shared-rate/startup.mjs', 'verifySharedRateStartup'],
    ['lib/shared-rate/supervisor.mjs', 'startSharedRateSupervisor'],
  ]) {
    if (!new RegExp('export (?:async )?function ' + symbol + '\\b').test(sources[path] ?? '')) {
      throw new Error('RUNTIME_SHELL_SHARED_MODULE_INCOMPATIBLE');
    }
  }
}

export function renderPrefetchService() {
  return `#!/usr/bin/env node
// B线预取服务入口（systemd ExecStart 目标；由 scripts/build-runtime-download.mjs 生成到
// 构建产物 runtime/service/prefetch.mjs，shell 源不含此文件）。
// 与下载服务同包复用：readEnvironment / log-filter / instance-lock / shared-rate / drain。
// 预取合同差异：仅共享限速后端（无进程内回退）、无日预算账本、独立 prefetch.instance.lock、
// 预取轮 completed→TASK_DONE 其余→NO_TASK、异常交 drain 既有退避。
// 本文件不含任何环境值；凭据只在部署方 EnvironmentFile（仅服务账号可读）里。

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvironment } from '../lib/env.mjs';
import { collectSecrets, installLogFilter } from '../lib/log-filter.mjs';
import { acquireInstanceLock, releaseInstanceLock, InstanceLockHeldError } from '../lib/instance-lock.mjs';
import { createSharedRateLimiter } from '../lib/shared-rate/limiter.mjs';
import { verifySharedRateStartup } from '../lib/shared-rate/startup.mjs';
import { startSharedRateSupervisor } from '../lib/shared-rate/supervisor.mjs';
import { createDrainLoop, LoopDecision } from './drain.mjs';

const SERVICE_NAME = 'zhaoshu-prefetch';
const RATE_FLOOR_MS = 1000; // 风控下限：每源许可间隔不得低于 1s

// 固定原因码（配置形态错误，区别于共享限速持久闸门的 78）。
const EXIT_SHARED_RATE_REQUIRED = 2;    // 未选择共享限速后端：预取不回退进程内限速
const EXIT_MIN_INTERVAL_INVALID = 3;    // 共享限速间隔低于风控下限
const EXIT_DATABASE_URL_REQUIRED = 4;   // 缺业务键 DATABASE_URL（只报键名）
const EXIT_INSTANCE_LOCK_HELD = 5;      // prefetch.instance.lock 被占用

function log(level, message, fields = {}) {
  console[level === 'error' ? 'error' : 'log'](
    new Date().toISOString() + ' ' + SERVICE_NAME + ' ' + level + ' ' + message
      + (Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''));
}

const SIGNAL_NAMES = { 1: 'SIGHUP', 2: 'SIGINT', 15: 'SIGTERM' };
const signalName = (signal) => SIGNAL_NAMES[signal] ?? ('signal-' + signal);

export async function main() {
  const { missing, config } = readEnvironment();

  // 业务键只要 DATABASE_URL；GITHUB_* 是下载腿的键，预取不要求。
  // DOWNLOAD_RATE_CONTROL_FILE/AUTHORITY_ID/EXPECTED_EPOCH 缺失不在本层拦，
  // 交给 supervisor 的 verifyStartup 按既有合同拒绝（missing 只含键名，无值）。
  if (missing.includes('DATABASE_URL')) {
    log('error', '缺少必需环境键', { missing: ['DATABASE_URL'] });
    process.exitCode = EXIT_DATABASE_URL_REQUIRED;
    return;
  }
  // 预取与下载共用每源配额，必须走 flock 跨进程账本；未选择共享是配置错误，不回退内存限速。
  if (!config.sharedRate) {
    log('error', '预取服务要求共享限速后端', { reason: 'DOWNLOAD_SHARED_RATE_DIR_NOT_SELECTED' });
    process.exitCode = EXIT_SHARED_RATE_REQUIRED;
    return;
  }
  if (config.sharedRate.minIntervalMs < RATE_FLOOR_MS) {
    log('error', '共享限速间隔低于风控下限', { minIntervalMs: config.sharedRate.minIntervalMs, floorMs: RATE_FLOOR_MS });
    process.exitCode = EXIT_MIN_INTERVAL_INVALID;
    return;
  }

  const uninstallFilter = installLogFilter({ secrets: collectSecrets() });
  const stateDir = config.stateDir || join(tmpdir(), SERVICE_NAME + '-state');

  // 持久闸门先行：denied 按 supervisor 合同退出（此刻零执行器构造、零数据库调用）。
  // createLimiter 原样共享 flock 后端；选定 limiter 只此一处，绝不重造。
  const startup = await startSharedRateSupervisor({ sharedRate: config.sharedRate, stateDir }, {
    verifyStartup: verifySharedRateStartup,
    createLimiter: (sharedRate) => createSharedRateLimiter({
      ...sharedRate,
      breakerThreshold: 5, breakerCooldownMs: 30 * 60_000, // 与下载服务一致
    }),
  });
  if (!startup.allowed) {
    log('error', '共享限速启动被持久闸门拒绝', {
      code: startup.code, recordState: startup.recordState, blockPersistence: startup.blockPersistence,
    });
    process.exitCode = startup.exitCode;
    uninstallFilter();
    return;
  }
  const rateLimiter = startup.limiter;
  log('info', '共享限速后端启用（flock 跨进程账本）');

  // 独立实例锁：与下载服务的 instance.lock 同目录不同名，互不冲突。
  const lockPath = join(stateDir, 'prefetch.instance.lock');
  let lock;
  try {
    lock = await acquireInstanceLock({ lockPath });
  } catch (error) {
    if (error instanceof InstanceLockHeldError) {
      log('error', '已有预取实例在运行', { pid: error.pid });
      process.exitCode = EXIT_INSTANCE_LOCK_HELD;
      uninstallFilter();
      return;
    }
    throw error;
  }
  if (lock.replacedStale != null) log('info', '接管陈旧锁（前实例已死）', { replacedStalePid: lock.replacedStale });
  log('info', '启动', { pid: process.pid });

  // 预取执行器接缝：动态 import 第二 bundle（runtime/executor/prefetch.mjs，懒加载一次）。
  // run(signal) 单轮返回 'completed'|'idle_bound'|'failure_bound'|'aborted'；每轮上限
  // （maxTasksPerRound/maxIdlePolls/五分钟单书预算）由 entry 侧约束。completed→TASK_DONE，
  // 其余→NO_TASK；异常原样上抛交 drain 既有退避，动态 import 失败不吞（下轮重试）。
  // 本服务不建日预算账本、不读写预算状态文件、不改下载任务表。
  let prefetchRun = null;
  const runOnce = async (signal) => {
    if (!prefetchRun) {
      const { createSourcePrefetch } = await import('../executor/prefetch.mjs');
      const prefetcher = await createSourcePrefetch({ rateLimiter, log });
      prefetchRun = prefetcher.run;
    }
    const outcome = await prefetchRun(signal);
    return outcome === 'completed' ? LoopDecision.TASK_DONE : LoopDecision.NO_TASK;
  };

  const loop = createDrainLoop({
    runOnce,
    idleMs: config.idleSeconds * 1000,
    errorBackoffMs: config.errorBackoffSeconds * 1000,
    dbQuotaBackoffMs: config.dbQuotaBackoffSeconds * 1000,
    watchdogMs: config.taskWatchdogMs,
    // 错误只出固定原因码：SQL/上游异常的 message 可能带连接串或表细节，白名单脱敏兜不住。
    onEvent: ({ type, decision, cycles, backoffMs, retryAt }) => {
      if (type === 'decision') log('info', 'drain 决策', { decision, cycles });
      else if (type === 'db-quota') log('error', '数据库额度超限，长退避', { backoffMs, retryAt, cycles });
      else if (type === 'executor-error') log('error', '预取执行器异常', { reason: 'executor_error', cycles });
      else if (type === 'fatal') log('error', '致命错误停服', { reason: 'fatal', cycles });
    },
  });

  // 停机：SIGTERM/SIGINT → 同一 drain.signal 中止（drain 停止领新轮并等在途 runOnce 收尾）；
  // loop.run() 落定后 finally 释放锁与日志过滤。
  const shutdown = (reason) => {
    log('info', '收到停机信号', { reason: signalName(reason) });
    loop.stop(reason);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', () => log('error', 'unhandledRejection', { reason: 'unhandled_rejection' }));

  try {
    const cycles = await loop.run();
    log('info', '退出', { cycles });
    if (loop.signal.reason instanceof Error) process.exitCode = 1;
  } finally {
    // 嵌套 finally：锁释放失败（含锁文件损坏/被替换）也必须卸载日志过滤。
    try {
      await releaseInstanceLock(lockPath); // lib 侧只删自己 pid 持有的锁
    } finally {
      uninstallFilter();
    }
  }
}

main().catch(() => {
  log('error', '启动失败', { reason: 'startup_failed' });
  process.exitCode = 1;
});
`;
}
