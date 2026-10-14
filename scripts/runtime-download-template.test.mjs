// Draft only: future patrol execution requires Node's VM modules support.
// No production modules, environment, filesystem or network are imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { wireDownloadExecutor } from './runtime-download-template.mjs';

const template = `
export async function main() {
  let rateLimiter = null;
  if (config.sharedRate) {
    const startup = await startSharedRateSupervisor({ sharedRate: config.sharedRate, stateDir }, {
      verifyStartup: verifySharedRateStartup,
      createLimiter: (sharedRate) => createSharedRateLimiter({ ...sharedRate }),
    });
    if (!startup.allowed) {
      process.exitCode = startup.exitCode;
      return;
    }
    rateLimiter = startup.limiter;
  } else {
    rateLimiter = new SourceRateLimiter({
      minIntervalMs: config.rateMinIntervalMs,
      dailyRequestLimit: config.rateDailyLimit,
    });
  }
  // ---- 执行器接缝（T3 交付后替换）----
  const runOnce = () => { throw new Error('unwired'); };
  const loop = createDrainLoop({ runOnce });
  return loop;
}`;

async function harness(mode, { dummy = false, failAt, readyError, limiterError } = {}) {
  const calls = [];
  const permit = {};
  const failure = new Error('synthetic failure');
  const limiter = {
    async acquire(host, signal) {
      assert.strictEqual(this, limiter);
      calls.push(['acquire', host, signal]);
      if (failAt === 'acquire') throw failure;
      return permit;
    },
    async recordSuccess(host, token) {
      assert.strictEqual(this, limiter);
      assert.strictEqual(token, permit);
      calls.push(['success', host]);
      if (failAt === 'success') throw failure;
    },
    async recordFailure(host, token) {
      assert.strictEqual(this, limiter);
      assert.strictEqual(token, permit);
      calls.push(['failure', host]);
      if (failAt === 'failure') throw failure;
    },
  };
  let constructions = 0;
  let executorCalls = 0;
  let budgetConsumed = 0;
  let memoryOptions;
  const supervisor = async (args, hooks) => {
    calls.push(['supervisor']);
    if (mode === 'denied') {
      return Object.freeze({ allowed: false, exitCode: 78,
        code: 'SUPERVISOR_RECORD_BLOCKED', recordState: 'BLOCKED', blockPersistence: 'NOT_WRITTEN' });
    }
    await hooks.verifyStartup(args.sharedRate);
    const built = await hooks.createLimiter(args.sharedRate);
    return Object.freeze({ allowed: true, exitCode: 0, recordState: 'ALLOWED', limiter: built });
  };
  const context = createContext({
    config: { sharedRate: mode === 'memory' ? null : { synthetic: true },
      rateMinIntervalMs: 713, rateDailyLimit: 29, dailyBookLimit: 2 },
    process: { exitCode: 0 },
    async verifySharedRateStartup() {
      calls.push(['ready']);
      if (readyError) throw readyError;
    },
    createSharedRateLimiter() {
      calls.push(['shared']);
      if (limiterError) throw limiterError;
      return limiter;
    },
    startSharedRateSupervisor: supervisor,
    SourceRateLimiter: function (options) {
      constructions += 1;
      assert.equal(constructions, 1, 'must not reconstruct the selected limiter');
      assert.ok(options, 'must preserve main configuration');
      memoryOptions = options;
      return limiter;
    },
    dummy,
    budget: { async consume() {
      budgetConsumed += 1;
      return { allowed: true, used: 1, limit: 2 };
    } },
    stateDir: 'synthetic-state', join: (...parts) => parts.join('/'),
    LoopDecision: { NO_TASK: 'none', TASK_DONE: 'done', BUDGET_EXHAUSTED: 'budget' },
    log() {}, createDrainLoop: (options) => options,
  });
  const executor = new SyntheticModule(['createDownloadExecutor'], function () {
    this.setExport('createDownloadExecutor', async (options) => {
      executorCalls += 1;
      assert.strictEqual(options.rateLimiter, limiter);
      assert.equal(options.budgetLimit, 2);
      assert.equal(options.budgetStatePath, 'synthetic-state/daily-budget.json');
      return { async runOnce(signal) {
        const token = await options.rateLimiter.acquire('reader.test', signal);
        await options.rateLimiter.recordSuccess('reader.test', token);
        await options.rateLimiter.recordFailure('reader.test', token);
        return 'done';
      } };
    });
  }, { context });
  await executor.link(() => { throw new Error('unexpected executor import'); });
  await executor.evaluate();
  const generated = wireDownloadExecutor(template);
  const generatedModule = new SourceTextModule(generated, { context,
    async importModuleDynamically(specifier) {
      assert.equal(specifier, '../executor/executor.mjs');
      return executor;
    },
  });
  await generatedModule.link(() => { throw new Error("unexpected static import"); });
  await generatedModule.evaluate();
  return { start: () => generatedModule.namespace.main(), calls, failure,
    counts: () => ({ constructions, executorCalls, budgetConsumed }),
    options: () => memoryOptions, exitCode: () => context.process.exitCode };
}

for (const mode of ['shared', 'memory']) {
  test(`${mode}: selected object, permit and configured memory options survive production injection`, async () => {
    const h = await harness(mode);
    const loop = await h.start();
    const signal = {};
    assert.equal(await loop.runOnce(signal), 'done');
    assert.equal(await loop.runOnce(signal), 'done');
    assert.equal(h.counts().executorCalls, 1);
    assert.equal(h.counts().constructions, mode === 'memory' ? 1 : 0);
    assert.strictEqual(h.calls.find(([event]) => event === 'acquire')[2], signal);
    assert.equal(h.calls.filter(([event]) => event === 'success').length, 2);
    assert.equal(h.calls.filter(([event]) => event === 'failure').length, 2);
    if (mode === 'shared') assert.deepEqual(h.calls.slice(0, 3), [['supervisor'], ['ready'], ['shared']]);
    else {
      assert.equal(h.options().minIntervalMs, 713);
      assert.equal(h.options().dailyRequestLimit, 29);
      assert.deepEqual(h.calls.filter(([event]) => event === 'supervisor'), []);
    }
  });
  for (const failAt of ['acquire', 'success', 'failure']) {
    test(`${mode}: ${failAt} error escapes by reference`, async () => {
      const h = await harness(mode, { failAt });
      const loop = await h.start();
      await assert.rejects(loop.runOnce({}), (error) => error === h.failure);
    });
  }
}

for (const key of ['readyError', 'limiterError']) {
  test(`supervisor hook ${key} escapes by reference with no executor construction`, async () => {
    const error = new Error('synthetic hook failure');
    const h = await harness('shared', key === 'readyError' ? { readyError: error } : { limiterError: error });
    await assert.rejects(h.start(), (thrown) => thrown === error);
    assert.deepEqual(h.counts(), { constructions: 0, executorCalls: 0, budgetConsumed: 0 });
  });
}

test('supervisor denial exits early: no limiter construction, executor or budget consumption', async () => {
  const h = await harness('denied');
  await h.start();
  assert.deepEqual(h.calls, [['supervisor']]);
  assert.equal(h.exitCode(), 78);
  assert.deepEqual(h.counts(), { constructions: 0, executorCalls: 0, budgetConsumed: 0 });
});

test('dummy keeps two-task path without importing executor', async () => {
  const h = await harness('memory', { dummy: true });
  const loop = await h.start();
  assert.equal(await loop.runOnce(), 'done');
  assert.equal(await loop.runOnce(), 'done');
  assert.equal(await loop.runOnce(), 'none');
  assert.equal(h.counts().executorCalls, 0);
  assert.equal(h.counts().budgetConsumed, 2);
});

test('supervisor shape and ordering anchors: missing, moved, duplicated or after-seam all throw', () => {
  const start = '  // ---- 执行器接缝（T3 交付后替换）----';
  const end = '\n  const loop = createDrainLoop({';
  const denyBlock = `    if (!startup.allowed) {\n      process.exitCode = startup.exitCode;\n      return;\n    }\n`;
  const moved = template
    .replace(denyBlock, '')
    .replace('    rateLimiter = startup.limiter;\n', `    rateLimiter = startup.limiter;\n${denyBlock}`);
  const afterSeam = template
    .replace('  let rateLimiter = null;\n', '')
    .replace(start, `${start}\n  let rateLimiter = null;`);
  for (const invalid of [
    template.replace(start, ''), template.replace(end, ''),
    template + start, template + end,
    template.replace('let rateLimiter = null;', 'let other = null;'),
    template.replace('await startSharedRateSupervisor({ sharedRate: config.sharedRate, stateDir }, {', 'await otherStartup({'),
    template.replace('verifyStartup: verifySharedRateStartup,', ''),
    template.replace('createLimiter: (sharedRate) => createSharedRateLimiter({ ...sharedRate }),', ''),
    template.replace('createSharedRateLimiter', 'makeSharedRateLimiter'),
    template.replace('if (!startup.allowed) {', 'if (startup.allowed !== false) {'),
    template.replace('      process.exitCode = startup.exitCode;\n      return;\n', ''),
    template.replace('    rateLimiter = startup.limiter;\n', `    rateLimiter = startup.limiter;\n    rateLimiter = startup.limiter;\n`),
    template.replace('rateLimiter = new SourceRateLimiter({', 'rateLimiter = new OtherLimiter({'),
    moved, afterSeam,
  ]) {
    assert.throws(() => wireDownloadExecutor(invalid), /锚点/);
  }
  assert.notEqual(moved, template);
  assert.notEqual(afterSeam, template);
});

test('only the seam changes: prefix and suffix bytes preserved, LF and CRLF shells', () => {
  const start = '  // ---- 执行器接缝（T3 交付后替换）----';
  const end = '\n  const loop = createDrainLoop({';
  for (const shell of [template, template.replace(/\n/g, '\r\n')]) {
    const generated = wireDownloadExecutor(shell);
    assert.equal(generated.slice(0, generated.indexOf(start)), shell.slice(0, shell.indexOf(start)));
    assert.equal(generated.slice(generated.indexOf(end)), shell.slice(shell.indexOf(end)));
    assert.ok(generated.indexOf(start) > shell.indexOf('rateLimiter = startup.limiter;'));
  }
});
