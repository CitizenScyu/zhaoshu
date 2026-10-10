// Draft only: future patrol execution requires Node's VM modules support.
// No production modules, environment, filesystem or network are imported.
// Covers the rendered prefetch service source contract:
//   - missing DATABASE_URL exits with key names only, no values, no side effects;
//   - sharedRate absent / minIntervalMs below floor: fixed exit codes before the
//     log filter, supervisor, limiter construction, lock or any import/DB call;
//   - supervisor denial (incl. hook-failure translation, as in the real 883
//     supervisor) short-circuits with zero factory and zero lock;
//   - allowed path: selected limiter identity preserved and passed to the
//     factory, lazy dynamic import happens once, run receives the drain signal,
//     completed -> TASK_DONE and every other outcome -> NO_TASK;
//   - dynamic import failure and executor run errors escape runOnce for the
//     existing drain backoff, import retried next round;
//   - SIGTERM abort path: an in-flight round is already running when the signal
//     arrives; run observes aborted=false at entry, is cancelled by the abort,
//     main waits for its settlement, then the lock is released and the log
//     filter uninstalled;
//   - lock release failure still uninstalls the filter (nested finally) and the
//     error propagates as a startup failure; foreign locks untouched;
//   - instance lock held exits with a fixed code, foreign lock untouched;
//   - only same-package relative specifiers plus node builtins are imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { assertSharedRuntimeShell, renderPrefetchService } from './runtime-prefetch-template.mjs';

const SAME_PACKAGE_STATIC = [
  'node:os', 'node:path',
  '../lib/env.mjs',
  '../lib/log-filter.mjs',
  '../lib/instance-lock.mjs',
  '../lib/shared-rate/limiter.mjs',
  '../lib/shared-rate/startup.mjs',
  '../lib/shared-rate/supervisor.mjs',
  './drain.mjs',
];
const OUTCOMES = ['completed', 'idle_bound', 'failure_bound', 'aborted'];
const LOCK_PATH = '/synthetic/state/prefetch.instance.lock';

function sharedConfig(overrides = {}) {
  return {
    dataRoot: '/synthetic/shared', controlFile: '/synthetic/control.json',
    authorityId: 'auth-synthetic', expectedEpoch: 'epoch-7',
    minIntervalMs: 1000, dailyRequestLimit: 20_000, ...overrides,
  };
}

function fakeSignal() {
  const listeners = [];
  const signal = {
    aborted: false, reason: undefined,
    addEventListener(type, fn) { listeners.push(fn); },
    removeEventListener() {},
  };
  return { signal, abort(reason) { signal.aborted = true; signal.reason = reason; for (const fn of [...listeners]) fn(); } };
}

async function runService(harnessOptions = {}) {
  const source = renderPrefetchService();
  const calls = [];
  const logs = [];
  const staticSeen = [];
  const dynamicSeen = [];
  const handlers = [];
  let constructions = 0;
  let outcomeIndex = 0;
  let startedRunSnapshot = null;
  let releaseError = null;

  const sharedRate = harnessOptions.sharedRate === undefined ? sharedConfig() : harnessOptions.sharedRate;
  const cfg = {
    idleSeconds: 45, dailyBookLimit: 20, taskWatchdogMs: 340 * 60_000,
    errorBackoffSeconds: 60, dbQuotaBackoffSeconds: 1800,
    stateDir: '/synthetic/state',
    rateMinIntervalMs: sharedRate ? sharedRate.minIntervalMs : 1000,
    rateDailyLimit: 20_000, sharedRate,
  };
  const limiter = {
    async acquire(host, signal) { calls.push(['acquire', host, signal]); return {}; },
    async recordSuccess(host, permit) { calls.push(['recordSuccess', host, permit]); },
    async recordFailure(host, permit) { calls.push(['recordFailure', host, permit]); },
  };
  const controller = fakeSignal();
  const drainOptionsRef = {};
  const loop = {
    signal: controller.signal,
    run: () => new Promise((resolve) => {
      calls.push(['loop.run']);
      if (harnessOptions.loopMode === 'hang') {
        // 在途轮先于任何信号启动（真实顺序：runOnce 正在跑时才收到 SIGTERM）。
        const inFlight = drainOptionsRef.options.runOnce(controller.signal).then(
          (decision) => { calls.push(['decision', decision]); },
          (error) => { calls.push(['runOnce error', error]); },
        );
        inFlight.then(() => resolve(1));
        return;
      }
      (async () => {
        const rounds = harnessOptions.rounds ?? 4;
        for (let i = 0; i < rounds; i++) {
          try { calls.push(['decision', await drainOptionsRef.options.runOnce(controller.signal)]); }
          catch (error) { calls.push(['runOnce error', error]); }
        }
        resolve(rounds);
      })();
    }),
    stop: (reason) => controller.abort(reason),
  };

  const context = createContext({
    process: { exitCode: 0, pid: 412, on(event, handler) { handlers.push([event, handler]); } },
    console: { log: (line) => logs.push(['info', String(line)]), error: (line) => logs.push(['error', String(line)]) },
  });

  const InstanceLockHeldError = class extends Error {
    constructor(pid, lockPath) { super('单实例锁被占用'); this.pid = pid; this.lockPath = lockPath; }
  };
  const readEnvironment = () => {
    calls.push(['readEnvironment']);
    return { missing: [...(harnessOptions.missing ?? [])], config: cfg };
  };
  const installLogFilter = () => { calls.push(['installLogFilter']); return () => { calls.push(['uninstallLogFilter']); }; };
  const acquireInstanceLock = async ({ lockPath }) => {
    calls.push(['acquireInstanceLock', lockPath]);
    if (lockPath !== LOCK_PATH) throw new Error('unexpected lock path: ' + lockPath);
    if (harnessOptions.lockHeld) throw new InstanceLockHeldError(999, lockPath);
    return { pid: 412, acquiredAt: 'now', replacedStale: null };
  };
  const releaseInstanceLock = async (lockPath) => {
    calls.push(['releaseInstanceLock', lockPath]);
    if (releaseError) throw releaseError;
  };
  const createSharedRateLimiter = (options) => {
    calls.push(['createSharedRateLimiter']);
    constructions += 1;
    assert.equal(constructions, 1, 'selected limiter must be constructed exactly once');
    assert.strictEqual(options.dataRoot, sharedRate?.dataRoot);
    assert.strictEqual(options.minIntervalMs, cfg.rateMinIntervalMs);
    assert.equal(options.breakerThreshold, 5, 'breaker options must match the download service');
    assert.equal(options.breakerCooldownMs, 30 * 60_000);
    return limiter;
  };
  const verifySharedRateStartup = async (shared) => {
    calls.push(['ready', shared]);
    if (harnessOptions.startup?.hookError) throw harnessOptions.startup.hookError;
  };
  // 忠实 883 supervisor 语义：hook 异常被捕获并翻译成 denied（写 BLOCKED 记录），不上抛。
  const startSharedRateSupervisor = async (args, hooks) => {
    calls.push(['supervisor']);
    assert.strictEqual(args.sharedRate, cfg.sharedRate);
    assert.equal(args.stateDir, cfg.stateDir);
    if (harnessOptions.startup?.denied) return Object.freeze({
      allowed: false, exitCode: 78, code: 'SUPERVISOR_RECORD_BLOCKED',
      recordState: 'BLOCKED', blockPersistence: 'NOT_WRITTEN',
    });
    try {
      await hooks.verifyStartup(args.sharedRate);
      const built = await hooks.createLimiter(args.sharedRate);
      return Object.freeze({ allowed: true, exitCode: 0, recordState: 'ALLOWED', limiter: built });
    } catch (error) {
      if (harnessOptions.startup?.hookError && error !== harnessOptions.startup.hookError) throw error;
      return Object.freeze({
        allowed: false, exitCode: 78, code: 'SYNTHETIC_HOOK_FAILURE',
        recordState: 'BLOCKED', blockPersistence: 'DURABLE',
      });
    }
  };
  const createDrainLoop = (options) => {
    calls.push(['drain']);
    drainOptionsRef.options = options;
    assert.equal(typeof options.runOnce, 'function');
    assert.equal(options.idleMs, cfg.idleSeconds * 1000);
    assert.equal(options.errorBackoffMs, cfg.errorBackoffSeconds * 1000);
    assert.equal(options.dbQuotaBackoffMs, cfg.dbQuotaBackoffSeconds * 1000);
    assert.equal(options.watchdogMs, cfg.taskWatchdogMs);
    assert.equal(typeof options.onEvent, 'function');
    return loop;
  };

  const defs = {
    'node:os': [['tmpdir', () => '/tmp']],
    'node:path': [['join', (...parts) => parts.join('/')]],
    '../lib/env.mjs': [['readEnvironment', readEnvironment]],
    '../lib/log-filter.mjs': [['collectSecrets', () => []], ['installLogFilter', installLogFilter]],
    '../lib/instance-lock.mjs': [
      ['acquireInstanceLock', acquireInstanceLock], ['releaseInstanceLock', releaseInstanceLock],
      ['InstanceLockHeldError', InstanceLockHeldError],
    ],
    '../lib/shared-rate/limiter.mjs': [['createSharedRateLimiter', createSharedRateLimiter]],
    '../lib/shared-rate/startup.mjs': [['verifySharedRateStartup', verifySharedRateStartup]],
    '../lib/shared-rate/supervisor.mjs': [['startSharedRateSupervisor', startSharedRateSupervisor]],
    './drain.mjs': [['createDrainLoop', createDrainLoop], ['LoopDecision', { NO_TASK: 'no-task', TASK_DONE: 'task-done' }]],
  };
  const statics = new Map(Object.entries(defs).map(([specifier, exportDefs]) => [specifier,
    new SyntheticModule(exportDefs.map((d) => d[0]), function () {
      for (const [name, value] of exportDefs) this.setExport(name, value);
    }, { context }),
  ]));

  const executor = new SyntheticModule(['createSourcePrefetch'], function () {
    this.setExport('createSourcePrefetch', async (options) => {
      calls.push(['factory']);
      assert.strictEqual(options.rateLimiter, limiter, 'factory must receive the selected limiter instance');
      assert.equal(typeof options.log, 'function');
      return { run: (signal) => new Promise((resolve, reject) => {
        const outcome = OUTCOMES[outcomeIndex++ % OUTCOMES.length];
        // 入场记录只存当时状态；收尾另记 run-settled（listener 里 signal.aborted 已为 true）。
        calls.push(['run', signal, outcome, signal?.aborted]);
        const settle = (settled, fn, value) => {
          calls.push(['run-settled', signal?.aborted]);
          fn(value);
        };
        if (harnessOptions.runBehavior === 'awaitAbort') {
          // 在途轮挂起直到 signal 中止：证明 run 以未中止态进入、由取消收尾。
          if (signal?.aborted) { settle(true, reject, signal.reason ?? new Error('aborted')); return; }
          signal?.addEventListener('abort', () =>
            settle(true, reject, signal.reason ?? new Error('aborted')));
          return;
        }
        if (signal?.aborted) { settle(true, reject, signal.reason ?? new Error('aborted')); return; }
        if (harnessOptions.runError) { settle(false, reject, harnessOptions.runError); return; }
        settle(false, resolve, outcome);
      }) };
    });
  }, { context });
  await executor.link(() => { throw new Error('unexpected executor dependency'); });
  await executor.evaluate();

  const generatedModule = new SourceTextModule(source, { context, identifier: 'prefetch.mjs',
    async importModuleDynamically(specifier, referencingModule) {
      dynamicSeen.push(specifier);
      if (harnessOptions.importBehavior === 'reject') throw new Error('synthetic import failure');
      assert.equal(specifier, '../executor/prefetch.mjs', 'dynamic import must target the second bundle output');
      assert.equal(referencingModule.identifier, 'prefetch.mjs');
      return executor;
    },
  });
  await generatedModule.link((specifier) => {
    staticSeen.push(specifier);
    const found = statics.get(specifier);
    if (!found) throw new Error('unexpected static import (not same-package): ' + specifier);
    return found;
  });
  await generatedModule.evaluate();

  const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
  await flush(12);

  // hang 模式：在途轮此时应已开始且未见 abort；返回快照供 SIGTERM 测试断言真实顺序。
  if (harnessOptions.loopMode === 'hang') {
    const started = calls.filter(([name]) => name === 'run').at(-1);
    if (started) startedRunSnapshot = { signal: started[1], abortedAtEntry: started[3] };
  }

  return {
    calls, logs, staticSeen, dynamicSeen, controller, loop,
    constructions: () => constructions,
    startedRun: () => startedRunSnapshot,
    failRelease: (error) => { releaseError = error; },
    exitCode: () => context.process.exitCode,
    sendSignal: (name) => { for (const [event, handler] of handlers) if (event === name) handler(name); },
    flush,
  };
}

const names = (calls) => calls.map(([name]) => name);

test('shared shell source gate rejects T7/incomplete wiring and accepts the explicit contract', () => {
  const sources = {
    'lib/env.mjs': `const sharedRate = {
      dataRoot: env.DOWNLOAD_SHARED_RATE_DIR, controlFile: env.DOWNLOAD_RATE_CONTROL_FILE,
      authorityId: env.DOWNLOAD_RATE_AUTHORITY_ID, expectedEpoch: env.DOWNLOAD_RATE_EXPECTED_EPOCH,
    }; config.sharedRate = sharedRate;`,
    'service/main.mjs': `import { readEnvironment } from '../lib/env.mjs';
      const startup = await startSharedRateSupervisor({ sharedRate: config.sharedRate, stateDir }, {});
      rateLimiter = startup.limiter;`,
    'lib/shared-rate/limiter.mjs': 'export function createSharedRateLimiter() {}',
    'lib/shared-rate/startup.mjs': 'export async function verifySharedRateStartup() {}',
    'lib/shared-rate/supervisor.mjs': 'export async function startSharedRateSupervisor() {}',
  };
  assert.doesNotThrow(() => assertSharedRuntimeShell(sources));
  assert.throws(() => assertSharedRuntimeShell({ ...sources, 'lib/env.mjs': 'export function readEnvironment() {}' }),
    /RUNTIME_SHELL_SHARED_ENV_INCOMPATIBLE/);
  for (const key of ['DOWNLOAD_SHARED_RATE_DIR', 'DOWNLOAD_RATE_CONTROL_FILE', 'DOWNLOAD_RATE_AUTHORITY_ID', 'DOWNLOAD_RATE_EXPECTED_EPOCH']) {
    assert.throws(() => assertSharedRuntimeShell({ ...sources, 'lib/env.mjs': sources['lib/env.mjs'].replace(key, 'OTHER_KEY') }),
      /RUNTIME_SHELL_SHARED_ENV_INCOMPATIBLE/);
  }
  assert.throws(() => assertSharedRuntimeShell({ ...sources, 'service/main.mjs': 'const rateLimiter = null;' }),
    /RUNTIME_SHELL_SHARED_DOWNLOAD_INCOMPATIBLE/);
  assert.throws(() => assertSharedRuntimeShell({ ...sources, 'lib/shared-rate/supervisor.mjs': '' }),
    /RUNTIME_SHELL_SHARED_MODULE_INCOMPATIBLE/);
});

test('rendered source is deterministic and free of budget/legacy-limiter references', () => {
  const a = renderPrefetchService();
  assert.equal(a, renderPrefetchService());
  for (const banned of ['daily-budget', 'dailyBudget', 'createDailyBudget', 'SourceRateLimiter', 'download_tasks']) {
    assert.ok(!a.includes(banned), 'source must not reference ' + banned);
  }
  assert.ok(a.includes('prefetch.instance.lock'));
  assert.ok(a.includes("'../executor/prefetch.mjs'"));
  assert.ok(a.includes('createSourcePrefetch'));
  assert.ok(a.includes('RATE_FLOOR_MS'));
});

test('missing DATABASE_URL exits with fixed code and key names only, before any side effect', async () => {
  const h = await runService({ missing: ['DATABASE_URL', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'] });
  assert.equal(h.exitCode(), 4);
  assert.deepEqual(names(h.calls), ['readEnvironment']);
  const line = h.logs.find(([, text]) => text.includes('缺少必需环境键'));
  assert.ok(line, 'missing-key log line present');
  assert.ok(line[1].includes('"missing":["DATABASE_URL"]'), 'log carries key names only');
  assert.ok(!line[1].includes('postgres'), 'no values leak');
  assert.equal(h.dynamicSeen.length, 0);
});

test('sharedRate absent exits with fixed code: no supervisor, lock, import or DB', async () => {
  const h = await runService({ missing: ['GITHUB_TOKEN'], sharedRate: null });
  assert.equal(h.exitCode(), 2);
  assert.deepEqual(names(h.calls), ['readEnvironment']);
  assert.equal(h.constructions(), 0);
  assert.equal(h.dynamicSeen.length, 0);
});

test('minIntervalMs below floor exits with fixed code before any side effect', async () => {
  const h = await runService({ sharedRate: sharedConfig({ minIntervalMs: 500 }) });
  assert.equal(h.exitCode(), 3);
  assert.deepEqual(names(h.calls), ['readEnvironment']);
});

test('supervisor denial exits with supervisor code, zero factory, zero lock, filter uninstalled', async () => {
  const h = await runService({ startup: { denied: true } });
  assert.equal(h.exitCode(), 78);
  assert.deepEqual(names(h.calls), ['readEnvironment', 'installLogFilter', 'supervisor', 'uninstallLogFilter']);
  assert.equal(h.constructions(), 0);
  assert.equal(h.dynamicSeen.length, 0);
});

test('supervisor hook failure translated to denial: no lock, no import, filter uninstalled', async () => {
  const h = await runService({ startup: { hookError: new Error('synthetic hook failure') } });
  assert.equal(h.exitCode(), 78);
  assert.equal(names(h.calls).includes('acquireInstanceLock'), false);
  assert.equal(h.dynamicSeen.length, 0);
  assert.deepEqual(names(h.calls), ['readEnvironment', 'installLogFilter', 'supervisor', 'ready', 'uninstallLogFilter']);
});

test('allowed: limiter identity preserved, import once, run gets drain signal, outcomes map', async () => {
  const h = await runService({ rounds: 4 });
  assert.equal(h.exitCode(), 0);
  assert.equal(h.constructions(), 1);
  assert.deepEqual(h.dynamicSeen, ['../executor/prefetch.mjs']);
  const runCalls = h.calls.filter(([name]) => name === 'run');
  assert.equal(runCalls.length, 4);
  for (const [, , outcome] of runCalls) assert.ok(OUTCOMES.includes(outcome));
  for (const [, signal] of runCalls) assert.strictEqual(signal, h.loop.signal);
  assert.deepEqual(h.calls.filter(([name]) => name === 'decision').map(([, d]) => d),
    ['task-done', 'no-task', 'no-task', 'no-task']);
  assert.deepEqual(h.calls.filter(([name]) => name === 'acquireInstanceLock').map(([, p]) => p), [LOCK_PATH]);
  assert.deepEqual(names(h.calls).slice(-2), ['releaseInstanceLock', 'uninstallLogFilter']);
  assert.deepEqual([...h.staticSeen].sort(), [...SAME_PACKAGE_STATIC].sort());
  assert.equal(h.calls.filter(([name]) => name === 'factory').length, 1);
  assert.equal(h.calls.filter(([name]) => name === 'acquire').length, 0);
});

test('dynamic import failure escapes runOnce and is retried next round', async () => {
  const h = await runService({ importBehavior: 'reject', rounds: 2 });
  assert.equal(h.dynamicSeen.length, 2);
  assert.equal(h.calls.filter(([name]) => name === 'runOnce error').length, 2);
  assert.equal(h.calls.filter(([name]) => name === 'decision').length, 0);
});

test('executor run error escapes runOnce for existing drain backoff', async () => {
  const failure = new Error('prefetch boom');
  const h = await runService({ runError: failure, rounds: 2 });
  assert.deepEqual(h.dynamicSeen, ['../executor/prefetch.mjs']);
  const errors = h.calls.filter(([name]) => name === 'runOnce error');
  assert.equal(errors.length, 2);
  for (const [, error] of errors) assert.strictEqual(error, failure);
  assert.equal(h.calls.filter(([name]) => name === 'decision').length, 0);
});

test('SIGTERM cancels a running round: run starts un-aborted, settles on abort, then release/filter', async () => {
  const h = await runService({ loopMode: 'hang', runBehavior: 'awaitAbort' });
  const started = h.startedRun();
  assert.ok(started, 'in-flight run must have started before the signal');
  assert.strictEqual(started.signal, h.loop.signal);
  assert.equal(started.abortedAtEntry, false, 'run entered while signal was still live');
  assert.equal(h.calls.filter(([name]) => name === 'releaseInstanceLock').length, 0);
  h.sendSignal('SIGTERM');
  await h.flush();
  const lastRun = h.calls.filter(([name]) => name === 'run').at(-1);
  assert.ok(lastRun, 'in-flight run must be observed');
  assert.strictEqual(lastRun[1], h.loop.signal);
  assert.equal(lastRun[3], false, 'entry record keeps the pre-abort state');
  const settledIdx = h.calls.findIndex(([name]) => name === 'run-settled');
  assert.ok(settledIdx >= 0, 'settlement record must exist');
  assert.equal(h.calls[settledIdx][1], true, 'settlement observed the aborted signal');
  const releaseIdx = h.calls.findIndex(([name]) => name === 'releaseInstanceLock');
  assert.ok(releaseIdx > settledIdx, 'run settles before the lock is released');
  assert.strictEqual(h.calls.filter(([name]) => name === 'runOnce error').at(-1)[1], 'SIGTERM');
  assert.deepEqual(h.calls.filter(([name]) => name === 'releaseInstanceLock').map(([, p]) => p), [LOCK_PATH]);
  assert.deepEqual(names(h.calls).slice(-2), ['releaseInstanceLock', 'uninstallLogFilter']);
  assert.equal(h.exitCode(), 0, 'string reason (signal) is not an Error: clean stop');
  assert.ok(h.logs.some(([, text]) => text.includes('收到停机信号')));
});

test('lock release failure still uninstalls the filter and surfaces a startup failure', async () => {
  const h = await runService({ loopMode: 'hang', runBehavior: 'awaitAbort' });
  h.failRelease(new Error('release failed'));
  assert.equal(h.calls.filter(([name]) => name === 'releaseInstanceLock').length, 0);
  h.sendSignal('SIGTERM');
  await h.flush();
  const releaseIdx = h.calls.findIndex(([name]) => name === 'releaseInstanceLock');
  assert.ok(releaseIdx >= 0, 'release attempted');
  assert.equal(h.calls[releaseIdx][1], LOCK_PATH);
  assert.deepEqual(names(h.calls).slice(-1), ['uninstallLogFilter'], 'filter uninstall follows release failure');
  assert.equal(h.exitCode(), 1);
  assert.ok(h.logs.some(([, text]) => text.includes('启动失败')), 'propagates as startup failure');
});

test('instance lock held exits with fixed code, foreign lock untouched, filter uninstalled', async () => {
  const h = await runService({ lockHeld: true });
  assert.equal(h.exitCode(), 5);
  assert.equal(names(h.calls).includes('releaseInstanceLock'), false);
  assert.deepEqual(names(h.calls), ['readEnvironment', 'installLogFilter', 'supervisor', 'ready',
    'createSharedRateLimiter', 'acquireInstanceLock', 'uninstallLogFilter']);
  assert.equal(h.dynamicSeen.length, 0);
});
