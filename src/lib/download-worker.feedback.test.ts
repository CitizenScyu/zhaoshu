import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEngineAdapter, getWorkerFeedbackError, runDownloadTask, WORKER_HEARTBEAT_INTERVAL_MS,
  type AdapterOutcome, type EngineDownloadLike, type SourceAdapter, type SourceAdapterContext,
  type TaskRow, type WorkerOptions, type WorkerResult, type WorkerStorage,
} from './download-worker';

const PRIVATE = 'synthetic_private_detail';
const CODE = 'LIMITER_FEEDBACK_UNAVAILABLE';
const ORIGIN = 'limiter-feedback';
const lease: Parameters<typeof runDownloadTask>[1] = { id: 7, leaseOwner: 'synthetic-worker', leaseGeneration: 3, attemptCount: 1 };
const task: TaskRow = {
  id: 7, book_id: 1, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'system',
};
const complete: AdapterOutcome = { kind: 'complete', txt: '合成正文', chaptersTotal: 1, chaptersDone: 1, charsTotal: 4 };
const progress = { chaptersTotal: 1, chaptersDone: 0, charsTotal: 0 };
function feedback() {
  return Object.freeze(Object.assign(new Error('Limiter feedback persistence unavailable'), {
    name: 'LimiterFeedbackError', code: CODE, origin: ORIGIN, persistenceOutcome: 'unknown',
    cause: new Error(PRIVATE), requestError: Object.assign(new Error(PRIVATE), { status: 429 }),
  }));
}
function aggregate(error: unknown, cleanup: unknown = new Error(PRIVATE)) {
  return Object.assign(new AggregateError([error, cleanup], 'Limiter feedback cleanup failed', { cause: error }), {
    name: 'LimiterFeedbackCleanupError', code: CODE, origin: ORIGIN, persistenceOutcome: 'unknown',
  });
}
function fault(kind: 'F' | 'G') { const error = feedback(); return kind === 'F' ? error : aggregate(error); }
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function engine(downloadBook: EngineDownloadLike): SourceAdapter {
  return createEngineAdapter({ downloadBook, modules: {}, resolveSource: async () => ({}), outRoot: 'synthetic-out',
    readBookText: async () => { throw new Error('unexpected_text_read'); } });
}
function scripted(download: (context: SourceAdapterContext) => Promise<AdapterOutcome>): SourceAdapter {
  return { kind: 'engine', download: (_task, context) => download(context) };
}
function fixture(adapter: SourceAdapter, taskTimeoutMs = 600_000) {
  const storage = {
    claim: vi.fn<WorkerStorage['claim']>().mockResolvedValue(lease),
    taskRow: vi.fn<WorkerStorage['taskRow']>().mockResolvedValue(task),
    heartbeat: vi.fn<WorkerStorage['heartbeat']>().mockResolvedValue(true),
    progress: vi.fn<WorkerStorage['progress']>().mockResolvedValue(true),
    finish: vi.fn<WorkerStorage['finish']>().mockResolvedValue(true),
    defer: vi.fn<WorkerStorage['defer']>().mockResolvedValue(null),
    reserveArtifactPath: vi.fn<WorkerStorage['reserveArtifactPath']>().mockResolvedValue(1),
    findArtifactBinding: vi.fn<WorkerStorage['findArtifactBinding']>().mockResolvedValue(null),
    registerArtifact: vi.fn<WorkerStorage['registerArtifact']>().mockResolvedValue('registered'),
  };
  const github = {
    put: vi.fn<WorkerOptions['github']['put']>().mockResolvedValue(undefined),
    getBytes: vi.fn<WorkerOptions['github']['getBytes']>().mockResolvedValue(null),
  };
  const options: WorkerOptions = { storage, github, adapters: [adapter], repositoryId: 1, branch: 'synthetic', taskTimeoutMs };
  return { storage, github, run: () => runDownloadTask(options, lease) };
}
function noPublication(f: ReturnType<typeof fixture>) {
  for (const call of [f.storage.defer, f.storage.reserveArtifactPath, f.storage.registerArtifact, f.github.put, f.github.getBytes]) {
    expect(call).not.toHaveBeenCalled();
  }
}
function fixedFinish(f: ReturnType<typeof fixture>) {
  expect(f.storage.finish).toHaveBeenCalledTimes(1);
  expect(f.storage.finish).toHaveBeenCalledWith(lease, { status: 'failed', error: 'limiter_feedback_unavailable' });
}
function checkFeedback(f: ReturnType<typeof fixture>, result: WorkerResult, error: unknown,
  settlement: 'acknowledged' | 'lost' | 'unknown', budgetExhausted = false) {
  expect(result).toEqual({
    processed: settlement !== 'lost', reason: settlement === 'lost' ? 'lease_lost' : 'limiter_feedback_unavailable',
    ...(settlement === 'acknowledged' ? { terminal: 'failed' } : {}),
    feedback: { code: CODE, origin: ORIGIN, persistenceOutcome: 'unknown', budgetExhausted, settlement },
  });
  expect(getWorkerFeedbackError(result)).toBe(error);
  expect(getWorkerFeedbackError({ ...result })).toBeUndefined();
  expect(Reflect.ownKeys(result).map(String).sort()).toEqual(
    settlement === 'acknowledged' ? ['feedback', 'processed', 'reason', 'terminal'] : ['feedback', 'processed', 'reason']);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  noPublication(f);
}
async function pausedRun(f: ReturnType<typeof fixture>, ready: Promise<void>, release: () => void, step: () => Promise<unknown>) {
  const observed = f.run().then(value => ({ value }), (error: unknown) => ({ error }));
  try {
    await Promise.race([ready, observed.then(() => { throw new Error('worker_ended_before_release'); })]);
    await step();
  } finally {
    release();
    await observed;
  }
  const settled = await observed;
  if ('error' in settled) throw settled.error;
  return settled.value;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected_network'); }));
});
afterEach(() => {
  try { expect(vi.getTimerCount()).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('W feedback reference and single settlement', () => {
  it.each(['F', 'G', 'object'] as const)('%s without cancellation preserves its original reference', async kind => {
    const error = kind === 'object' ? Object.freeze({ code: CODE, origin: ORIGIN, privateDetail: PRIVATE }) : fault(kind);
    const f = fixture(engine(async () => { throw error; }));
    checkFeedback(f, await f.run(), error, 'acknowledged');
    fixedFinish(f);
    expect(f.storage.heartbeat).toHaveBeenCalledTimes(1);
  });

  it.each([['F', 'lease'], ['G', 'lease'], ['F', 'budget-first'], ['G', 'budget-first']] as const)(
    '%s with %s retains feedback and never finishes after observed lease loss', async (kind, mode) => {
      const error = fault(kind), started = gate(), resume = gate(), pulse = gate<boolean>();
      const captured: { signal?: AbortSignal } = {};
      const f = fixture(engine(async (_m, _args, _resolve, _transport, hooks) => {
        captured.signal = hooks?.signal; started.resolve(); await resume.promise; throw error;
      }), mode === 'budget-first' ? 1 : 600_000);
      f.storage.heartbeat.mockResolvedValueOnce(true).mockImplementationOnce(() => pulse.promise);
      const result = await pausedRun(f, started.promise, () => resume.resolve(), async () => {
        try {
          await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
          if (mode === 'budget-first') {
            expect(captured.signal?.reason?.message).toBe('budget_exhausted');
            resume.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.storage.finish).not.toHaveBeenCalled(); // stop must await the pending heartbeat.
          }
        } finally { pulse.resolve(false); }
        await vi.advanceTimersByTimeAsync(0);
        if (mode === 'lease') expect(captured.signal?.reason).toMatchObject({ name: 'TaskLeaseLostError', code: 'TASK_LEASE_LOST' });
        else expect(captured.signal?.reason?.message).toBe('budget_exhausted');
      });
      checkFeedback(f, result, error, 'lost', mode === 'budget-first');
      expect(f.storage.finish).not.toHaveBeenCalled();
      expect(f.storage.heartbeat).toHaveBeenCalledTimes(2);
    });

  it('remembers progress lease loss even when G wraps that error and signal is not aborted', async () => {
    const error = feedback();
    const captured: { rejected?: ReturnType<typeof aggregate>; signal?: AbortSignal } = {};
    const f = fixture(engine(async (_m, _args, _resolve, _transport, hooks) => {
      captured.signal = hooks?.signal;
      try { await hooks?.onProgress?.(progress); }
      catch (cleanup) { captured.rejected = aggregate(error, cleanup); throw captured.rejected; }
      throw new Error('expected_progress_failure');
    }));
    f.storage.progress.mockResolvedValue(false);
    const result = await f.run();
    expect(captured.rejected).toBeInstanceOf(AggregateError);
    expect(captured.signal?.aborted).toBe(false);
    checkFeedback(f, result, captured.rejected, 'lost');
    expect(f.storage.finish).not.toHaveBeenCalled();
    expect(f.storage.progress).toHaveBeenCalledWith(lease, progress);
  });

  it.each(['F', 'G', 'budget'] as const)('budget with %s preserves feedback priority or the ordinary partial result', async kind => {
    const error = kind === 'budget' ? new Error('budget_exhausted') : fault(kind);
    const started = gate(), resume = gate();
    const f = fixture(engine(async () => { started.resolve(); await resume.promise; throw error; }), 1);
    const result = await pausedRun(f, started.promise, () => resume.resolve(), () => vi.advanceTimersByTimeAsync(1));
    if (kind === 'budget') {
      expect(result).toEqual({ processed: true, terminal: 'partial', reason: 'budget_exhausted' });
      expect(getWorkerFeedbackError(result)).toBeUndefined();
      expect(f.storage.finish).toHaveBeenCalledTimes(1);
      expect(f.storage.finish).toHaveBeenCalledWith(lease, { status: 'partial', error: expect.stringContaining('budget_exhausted') });
      noPublication(f);
    } else { checkFeedback(f, result, error, 'acknowledged', true); fixedFinish(f); }
  });

  it('keeps ordinary lease loss free of terminal writes and feedback metadata', async () => {
    const download = vi.fn<EngineDownloadLike>().mockRejectedValue(new Error('unexpected_adapter_call'));
    const f = fixture(engine(download));
    f.storage.heartbeat.mockResolvedValue(false);
    const result = await f.run();
    expect(result).toEqual({ processed: false, reason: 'lease_lost' });
    expect(getWorkerFeedbackError(result)).toBeUndefined();
    expect(f.storage.finish).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    noPublication(f);
  });

  it('keeps ordinary adapter failure unchanged without recording feedback', async () => {
    const f = fixture(engine(async () => { throw new Error('synthetic_failure'); }));
    const result = await f.run();
    expect(result).toEqual({ processed: true, terminal: 'failed', reason: 'synthetic_failure' });
    expect(getWorkerFeedbackError(result)).toBeUndefined();
    expect(f.storage.finish).toHaveBeenCalledTimes(1);
    expect(f.storage.finish).toHaveBeenCalledWith(lease, { status: 'failed', error: 'synthetic_failure' });
    noPublication(f);
  });

  it.each(['false', 'throw'] as const)('finish %s is handled once without exposing storage errors', async failure => {
    const error = feedback(), f = fixture(engine(async () => { throw error; }));
    if (failure === 'false') f.storage.finish.mockResolvedValue(false);
    else f.storage.finish.mockRejectedValue(new Error(`${PRIVATE}_repository`));
    const result = await f.run();
    checkFeedback(f, result, error, failure === 'false' ? 'lost' : 'unknown');
    expect(result).not.toHaveProperty('terminal');
    fixedFinish(f);
  });

  it('keeps the first valid callback before complete and freezes it during and after settlement', async () => {
    const error = feedback(), later = aggregate(error), finishing = gate(), finish = gate<boolean>();
    const captured: { report?: SourceAdapterContext['onFeedbackFailure'] } = {};
    const f = fixture(scripted(async context => {
      captured.report = context.onFeedbackFailure;
      for (const invalid of [null, { code: CODE }, { origin: ORIGIN }, { cause: error }, Object.assign(() => {}, { code: CODE, origin: ORIGIN })]) captured.report?.(invalid);
      captured.report?.(error); captured.report?.(later);
      return complete;
    }));
    f.storage.finish.mockImplementation(() => { finishing.resolve(); return finish.promise; });
    const result = await pausedRun(f, finishing.promise, () => finish.resolve(true), async () => { captured.report?.(later); });
    checkFeedback(f, result, error, 'acknowledged');
    const snapshot = JSON.stringify(result);
    captured.report?.(later);
    expect(getWorkerFeedbackError(result)).toBe(error);
    expect(JSON.stringify(result)).toBe(snapshot);
    fixedFinish(f);
  });

  it('prefers the final G rejection over an earlier F callback', async () => {
    const error = feedback(), final = aggregate(error);
    const f = fixture(scripted(async context => { context.onFeedbackFailure?.(error); throw final; }));
    checkFeedback(f, await f.run(), final, 'acknowledged');
    fixedFinish(f);
  });
});
