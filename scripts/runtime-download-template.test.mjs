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
    await verifySharedRateStartup(config.sharedRate);
    rateLimiter = createSharedRateLimiter({ ...config.sharedRate });
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

async function harness(mode, { dummy = false, failAt, readyError } = {}) {
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
  let memoryOptions;
  const context = createContext({
    config: { sharedRate: mode === 'shared' ? { synthetic: true } : null,
      rateMinIntervalMs: 713, rateDailyLimit: 29, dailyBookLimit: 2 },
    async verifySharedRateStartup() {
      calls.push(['ready']);
      if (readyError) throw readyError;
    },
    createSharedRateLimiter() { calls.push(['shared']); return limiter; },
    SourceRateLimiter: function (options) {
      constructions += 1;
      assert.equal(constructions, 1, 'must not reconstruct the selected limiter');
      assert.ok(options, 'must preserve main configuration');
      memoryOptions = options;
      return limiter;
    },
    dummy,
    budget: { async consume() { return { allowed: true, used: 1, limit: 2 }; } },
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
  await generatedModule.link(() => { throw new Error('unexpected static import'); });
  await generatedModule.evaluate();
  return { start: () => generatedModule.namespace.main(), calls, failure,
    counts: () => ({ constructions, executorCalls }), options: () => memoryOptions };
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
    if (mode === 'shared') assert.deepEqual(h.calls.slice(0, 2), [['ready'], ['shared']]);
    else {
      assert.equal(h.options().minIntervalMs, 713);
      assert.equal(h.options().dailyRequestLimit, 29);
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

test('READY rejection prevents backend construction and executor consumption', async () => {
  const readyError = new Error('synthetic not ready');
  const h = await harness('shared', { readyError });
  await assert.rejects(h.start(), (error) => error === readyError);
  assert.deepEqual(h.calls, [['ready']]);
  assert.deepEqual(h.counts(), { constructions: 0, executorCalls: 0 });
});

test('dummy keeps two-task path without importing executor', async () => {
  const h = await harness('memory', { dummy: true });
  const loop = await h.start();
  assert.equal(await loop.runOnce(), 'done');
  assert.equal(await loop.runOnce(), 'done');
  assert.equal(await loop.runOnce(), 'none');
  assert.equal(h.counts().executorCalls, 0);
});

test('only the seam changes; missing, duplicate or incompatible anchors throw', () => {
  const start = '  // ---- 执行器接缝（T3 交付后替换）----';
  const end = '\n  const loop = createDrainLoop({';
  const generated = wireDownloadExecutor(template);
  assert.equal(generated.slice(0, generated.indexOf(start)), template.slice(0, template.indexOf(start)));
  assert.equal(generated.slice(generated.indexOf(end)), template.slice(template.indexOf(end)));
  for (const invalid of [template.replace(start, ''), template.replace(end, ''),
    template + start, template + end,
    template.replace('let rateLimiter = null;', 'let other = null;'),
    template.replace('await verifySharedRateStartup(config.sharedRate);', '')]) {
    assert.throws(() => wireDownloadExecutor(invalid), /锚点/);
  }
});
