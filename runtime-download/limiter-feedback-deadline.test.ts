// Tests the real adapter with synthetic backends and an injected clock; no engine/runtime import.
import { describe, expect, it, vi } from 'vitest';
import type { RateLimiterLike } from './engine';
import { createFeedbackDeadlineLimiter, FeedbackDeadlineError, FeedbackHostStateError } from './limiter-feedback-deadline';

const HOST = 'source.test';
const OTHER = 'other.test';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controlledClock() {
  let time = 0;
  const scheduled: { id: number; callback: () => void; delay: number }[] = [];
  const live = new Set<number>();
  const now = vi.fn(() => time);
  const setTimer = vi.fn((callback: () => void, delay: number) => {
    const id = scheduled.length + 1;
    scheduled.push({ id, callback, delay });
    live.add(id);
    return id;
  });
  const drop = (handle: unknown) => { live.delete(handle as number); };
  const clearTimer = vi.fn(drop);
  return {
    now, setTimer, clearTimer, scheduled, live, drop,
    set(value: number) { time = value; },
    // Also permits delivery of an already-cancelled callback to model an event already queued.
    fire(id: number) {
      const timer = scheduled.find(entry => entry.id === id);
      if (!timer) throw new Error('Unknown synthetic timer');
      live.delete(id);
      timer.callback();
    },
  };
}

function backend() {
  return {
    acquire: vi.fn<RateLimiterLike['acquire']>(async () => undefined),
    recordSuccess: vi.fn<NonNullable<RateLimiterLike['recordSuccess']>>(),
    recordFailure: vi.fn<NonNullable<RateLimiterLike['recordFailure']>>(),
  };
}

function setup(timeout = 100) {
  const base = backend();
  const clock = controlledClock();
  const wrapped = createFeedbackDeadlineLimiter(base, { feedbackTimeoutMs: timeout, ...clock });
  return { base, clock, wrapped };
}

// One event-loop turn only for observing late Promise rejection; it never advances the injected clock.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('feedback deadline adapter synthetic contract', () => {
  it.each([0, -1, Infinity, NaN])('rejects invalid timeout %s without calling the backend', timeout => {
    const base = backend();
    expect(() => createFeedbackDeadlineLimiter(base, { feedbackTimeoutMs: timeout })).toThrow(RangeError);
    expect(base.acquire).not.toHaveBeenCalled();
    expect(base.recordSuccess).not.toHaveBeenCalled();
  });

  it('requires paired timer hooks and disallows a second wrapper for the same backend or wrapper', () => {
    const base = backend();
    expect(() => createFeedbackDeadlineLimiter(base, { feedbackTimeoutMs: 100, setTimer: () => 1 })).toThrow(TypeError);
    const first = createFeedbackDeadlineLimiter(base, { feedbackTimeoutMs: 100 });
    expect(() => createFeedbackDeadlineLimiter(base, { feedbackTimeoutMs: 100 })).toThrow('already wrapped');
    expect(() => createFeedbackDeadlineLimiter(first, { feedbackTimeoutMs: 100 })).toThrow('already wrapped');
  });

  it.each(['sync', 'async'] as const)('%s feedback preserves this/options references and returns the host to OPEN', async mode => {
    const { base, wrapped, clock } = setup();
    const permit = Object.freeze({ token: 'synthetic permit' });
    const successOptions = Object.freeze({ permit });
    const failureOptions = Object.freeze({ permit, retryAfterMs: 5000 });
    base.recordSuccess.mockImplementation(function (this: RateLimiterLike) {
      expect(this).toBe(base);
      return mode === 'async' ? Promise.resolve() : undefined;
    });
    base.recordFailure.mockImplementation(function (this: RateLimiterLike) {
      expect(this).toBe(base);
      return mode === 'async' ? Promise.resolve() : undefined;
    });
    const success = wrapped.recordSuccess(HOST, successOptions);
    expect(wrapped.getHostStatus(HOST)).toBe('DRAINING');
    await success;
    expect(base.recordSuccess.mock.calls[0]?.[1]).toBe(successOptions);
    expect(wrapped.getHostStatus(HOST)).toBe('OPEN');
    await wrapped.recordFailure(HOST, failureOptions);
    expect(base.recordFailure.mock.calls[0]?.[1]).toBe(failureOptions);
    await wrapped.recordSuccess(HOST);
    await wrapped.recordFailure(HOST, undefined);
    expect(base.recordSuccess.mock.calls[1]).toEqual([HOST]);
    expect(base.recordFailure.mock.calls[1]).toEqual([HOST, undefined]);
    expect(wrapped.getOperations()).toHaveLength(4);
    expect(wrapped.getOperations().every(op => op.publicState === 'FULFILLED'
      && op.ioState === 'RESOLVED' && op.resources === 'RELEASED')).toBe(true);
    expect(clock.live.size).toBe(0);
    clock.set(100);
    clock.fire(1);
    expect(wrapped.getHostStatus(HOST)).toBe('OPEN');
    expect(wrapped.getOperations(HOST)[0]?.publicState).toBe('FULFILLED');
  });

  it.each([undefined, null, Object.freeze({ token: 'opaque' })])('acquire preserves opaque value %j, receiver and exact options', async permit => {
    const { base, wrapped } = setup();
    const acquireOptions = { signal: new AbortController().signal };
    base.acquire.mockImplementation(async function (this: RateLimiterLike) {
      expect(this).toBe(base);
      return permit;
    });
    await expect(wrapped.acquire(HOST, acquireOptions)).resolves.toBe(permit);
    expect(base.acquire.mock.calls[0]?.[1]).toBe(acquireOptions);
    await wrapped.acquire(HOST);
    expect(base.acquire.mock.calls[1]).toEqual([HOST]);
  });

  it('serializes same-host feedback while another host remains independent', async () => {
    const { base, wrapped } = setup();
    const a = deferred();
    const b = deferred();
    base.recordSuccess.mockImplementation(host => host === HOST ? a.promise : undefined);
    base.recordFailure.mockReturnValue(b.promise);
    const first = wrapped.recordSuccess(HOST);
    const second = wrapped.recordFailure(HOST, { retryAfterMs: 12 });
    expect(base.recordFailure).not.toHaveBeenCalled();
    await wrapped.recordSuccess(OTHER);
    expect(wrapped.getHostStatus(OTHER)).toBe('OPEN');
    expect(wrapped.getHostStatus(HOST)).toBe('DRAINING');
    a.resolve(undefined);
    await first;
    expect(base.recordFailure).toHaveBeenCalledOnce();
    expect(wrapped.getHostStatus(HOST)).toBe('DRAINING');
    b.resolve(undefined);
    await second;
    expect(wrapped.getHostStatus(HOST)).toBe('OPEN');
  });

  it('814: dequeue resamples after synchronous completion work crosses the queued deadline', async () => {
    const { base, wrapped, clock } = setup(1000);
    const io = deferred();
    base.recordSuccess.mockReturnValue(io.promise);
    const a = wrapped.recordSuccess(HOST);
    clock.set(400);
    const b = wrapped.recordFailure(HOST).catch((error: unknown) => error);
    clock.set(900);
    clock.clearTimer.mockImplementationOnce(handle => { clock.drop(handle); clock.set(1450); });
    io.resolve(undefined);
    await a;
    const error = await b;
    expect(error).toBeInstanceOf(FeedbackDeadlineError);
    expect(error).toMatchObject({ t0: 400, deadline: 1400, phase: 'failure' });
    expect(base.recordFailure).not.toHaveBeenCalled();
    expect(wrapped.getOperations(HOST)[1]).toMatchObject({
      publicState: 'REJECTED_TIMEOUT', ioState: 'NOT_STARTED', resources: 'NOT_STARTED',
    });
    expect(wrapped.getHostStatus(HOST)).toBe('QUARANTINED');
  });

  it.each(['timer-install', 'pre-start'] as const)('%s exhaustion rejects without starting initial I/O', async boundary => {
    const { base, wrapped, clock } = setup();
    clock.now.mockReturnValueOnce(0);
    if (boundary === 'pre-start') clock.now.mockReturnValueOnce(0);
    clock.now.mockReturnValue(100);
    await expect(wrapped.recordSuccess(HOST)).rejects.toBeInstanceOf(FeedbackDeadlineError);
    expect(base.recordSuccess).not.toHaveBeenCalled();
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ publicState: 'REJECTED_TIMEOUT', ioState: 'NOT_STARTED' });
  });

  it('a queued public timeout never starts later; other queued operations reject as quarantined', async () => {
    const { base, wrapped, clock } = setup();
    const io = deferred();
    base.recordSuccess.mockReturnValue(io.promise);
    const a = wrapped.recordSuccess(HOST).catch((error: unknown) => error);
    clock.set(10);
    const b = wrapped.recordFailure(HOST).catch((error: unknown) => error);
    const c = wrapped.recordSuccess(HOST).catch((error: unknown) => error);
    clock.set(110);
    clock.fire(2); // Controlled delivery order; the older timer has not yet run.
    expect(await b).toBeInstanceOf(FeedbackDeadlineError);
    expect(await c).toMatchObject({ code: 'LIMITER_FEEDBACK_HOST_QUARANTINED' });
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ publicState: 'PENDING', ioState: 'PENDING', resources: 'UNKNOWN' });
    io.resolve(undefined);
    expect(await a).toBeInstanceOf(FeedbackDeadlineError);
    expect(base.recordSuccess).toHaveBeenCalledOnce();
    expect(base.recordFailure).not.toHaveBeenCalled();
    expect(wrapped.getOperations(HOST)[1]?.ioState).toBe('NOT_STARTED');
    expect(wrapped.getHostStatus(HOST)).toBe('QUARANTINED');
  });

  it('an early timer rearms only the remaining interval', async () => {
    const { base, wrapped, clock } = setup();
    const io = deferred();
    base.recordSuccess.mockReturnValue(io.promise);
    const pending = wrapped.recordSuccess(HOST).catch((error: unknown) => error);
    clock.set(40);
    clock.fire(1);
    expect(clock.scheduled.map(timer => timer.delay)).toEqual([100, 60]);
    expect(wrapped.getOperations(HOST)[0]?.publicState).toBe('PENDING');
    clock.set(100);
    clock.fire(2);
    expect(await pending).toBeInstanceOf(FeedbackDeadlineError);
    io.resolve(undefined);
    await turn();
    expect(wrapped.getHostStatus(HOST)).toBe('QUARANTINED');
  });

  it.each(['io-first', 'timer-first'] as const)('at exactly deadline, timeout wins in %s order with immutable error metadata', async order => {
    const { base, wrapped, clock } = setup();
    const io = deferred();
    base.recordSuccess.mockReturnValue(io.promise);
    const pending = wrapped.recordSuccess(HOST).catch((error: unknown) => error);
    clock.set(100);
    if (order === 'timer-first') clock.fire(1);
    io.resolve(undefined);
    const error = await pending;
    if (order === 'io-first') clock.fire(1);
    expect(error).toBeInstanceOf(FeedbackDeadlineError);
    expect(error).toMatchObject({
      name: 'FeedbackDeadlineError', message: 'Limiter feedback deadline exceeded',
      code: 'LIMITER_FEEDBACK_DEADLINE', origin: 'limiter-feedback',
      opId: 1, host: HOST, phase: 'success', t0: 0, deadline: 100,
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(error).not.toHaveProperty('status');
    await turn();
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ publicState: 'REJECTED_TIMEOUT', ioState: 'RESOLVED' });
  });

  it.each(['resolve', 'reject'] as const)('late %s is observed once without reopening or leaking rejection', async outcome => {
    const { base, wrapped, clock } = setup();
    const io = deferred();
    const failure = new Error('synthetic private backend error');
    const unhandled = vi.fn();
    const settlements = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      base.recordSuccess.mockReturnValue(io.promise);
      const pending = wrapped.recordSuccess(HOST).then(settlements, error => { settlements(error); return error; });
      clock.set(100);
      clock.fire(1);
      const timeout = await pending;
      expect(timeout).toBeInstanceOf(FeedbackDeadlineError);
      expect(wrapped.getOperations(HOST)[0]).toMatchObject({ ioState: 'PENDING', resources: 'UNKNOWN' });
      if (outcome === 'resolve') io.resolve(undefined); else io.reject(failure);
      await turn();
      expect(settlements).toHaveBeenCalledOnce();
      expect(settlements).toHaveBeenCalledWith(timeout);
      expect(unhandled).not.toHaveBeenCalled();
      expect(base.recordSuccess).toHaveBeenCalledOnce();
      expect(base.recordFailure).not.toHaveBeenCalled();
      expect(wrapped.getHostStatus(HOST)).toBe('QUARANTINED');
      const diagnostic = wrapped.getOperations(HOST)[0];
      expect(diagnostic).toMatchObject({ publicState: 'REJECTED_TIMEOUT',
        ioState: outcome === 'resolve' ? 'RESOLVED' : 'REJECTED', resources: 'RELEASED' });
      expect(diagnostic).not.toHaveProperty('ioError');
      expect(JSON.stringify(wrapped.getOperations())).not.toContain(failure.message);
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(Object.isFrozen(wrapped.getOperations())).toBe(true);
    } finally {
      io.resolve(undefined);
      await turn();
      process.off('unhandledRejection', unhandled);
    }
  });

  it('timeout never releases resources or shortens actual cleanup; parent abort does not reset the deadline', async () => {
    const { base, wrapped, clock } = setup();
    const write = deferred();
    const cleanup = deferred();
    const controller = new AbortController();
    let held = true;
    base.recordFailure.mockReturnValue(write.promise.then(() => cleanup.promise).finally(() => { held = false; }));
    await wrapped.acquire(HOST, { signal: controller.signal });
    const pending = wrapped.recordFailure(HOST, { retryAfterMs: 50 }).catch((error: unknown) => error);
    clock.set(60);
    controller.abort(new Error('synthetic parent abort'));
    write.resolve(undefined);
    await turn();
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ t0: 0, deadline: 100, ioState: 'PENDING' });
    clock.set(100);
    clock.fire(1);
    expect(await pending).toBeInstanceOf(FeedbackDeadlineError);
    expect(held).toBe(true);
    expect(wrapped.getOperations(HOST)[0]?.resources).toBe('UNKNOWN');
    cleanup.resolve(undefined);
    await turn();
    expect(held).toBe(false);
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ ioState: 'RESOLVED', resources: 'RELEASED', publicState: 'REJECTED_TIMEOUT' });
    expect(wrapped.getHostStatus(HOST)).toBe('QUARANTINED');
  });

  it.each(['throw', 'reject'] as const)('early backend %s preserves the original error and quarantines the host', async mode => {
    const { base, wrapped } = setup();
    const failure = Object.assign(new Error('synthetic I/O failure'), { status: 503 });
    base.recordFailure.mockImplementation(() => {
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    });
    await expect(wrapped.recordFailure(HOST)).rejects.toBe(failure);
    expect(wrapped.getHostStatus(HOST)).toBe('QUARANTINED');
    await expect(wrapped.recordSuccess(HOST)).rejects.toMatchObject({ code: 'LIMITER_FEEDBACK_HOST_QUARANTINED' });
    expect(base.recordSuccess).not.toHaveBeenCalled();
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ publicState: 'REJECTED_IO', ioState: 'REJECTED', resources: 'RELEASED' });
  });

  it.each(['throw', 'reject'] as const)('backend %s observed at the deadline yields timeout rather than the I/O error', async mode => {
    const { base, wrapped, clock } = setup();
    const failure = new Error('synthetic completion failure');
    base.recordFailure.mockImplementation(() => {
      clock.set(100);
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    });
    const error = await wrapped.recordFailure(HOST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeedbackDeadlineError);
    expect(error).not.toBe(failure);
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ publicState: 'REJECTED_TIMEOUT', ioState: 'REJECTED', resources: 'RELEASED' });
  });

  it('new acquire is blocked in DRAINING and QUARANTINED without a backend call or HTTP status', async () => {
    const { base, wrapped, clock } = setup();
    const io = deferred();
    base.recordSuccess.mockReturnValue(io.promise);
    const pending = wrapped.recordSuccess(HOST).catch((error: unknown) => error);
    const draining = await wrapped.acquire(HOST).catch((error: unknown) => error);
    expect(draining).toBeInstanceOf(FeedbackHostStateError);
    expect(draining).toMatchObject({ code: 'LIMITER_FEEDBACK_PENDING' });
    expect(draining).not.toHaveProperty('status');
    clock.set(100);
    clock.fire(1);
    expect(await pending).toBeInstanceOf(FeedbackDeadlineError);
    const quarantined = await wrapped.acquire(HOST).catch((error: unknown) => error);
    expect(quarantined).toMatchObject({ code: 'LIMITER_FEEDBACK_HOST_QUARANTINED' });
    expect(quarantined).not.toHaveProperty('status');
    expect(base.acquire).not.toHaveBeenCalled();
    // Never-settling I/O remains pending/unknown; only the synthetic timer was cleared.
    expect(wrapped.getOperations(HOST)[0]).toMatchObject({ ioState: 'PENDING', resources: 'UNKNOWN' });
  });

  it.each(['DRAINING', 'QUARANTINED'] as const)('acquire waiting across transition to %s never hands out the permit', async state => {
    const { base, wrapped, clock } = setup();
    const acquisition = deferred<unknown>();
    const io = deferred();
    const permit = Object.freeze({ token: 'already consumed budget' });
    base.acquire.mockReturnValue(acquisition.promise);
    base.recordSuccess.mockReturnValue(io.promise);
    const pendingAcquire = wrapped.acquire(HOST).catch((error: unknown) => error);
    const pendingFeedback = wrapped.recordSuccess(HOST).catch((error: unknown) => error);
    if (state === 'QUARANTINED') { clock.set(100); clock.fire(1); }
    acquisition.resolve(permit);
    const error = await pendingAcquire;
    expect(error).not.toBe(permit);
    expect(error).toMatchObject({ code: state === 'DRAINING' ? 'LIMITER_FEEDBACK_PENDING' : 'LIMITER_FEEDBACK_HOST_QUARANTINED' });
    expect(base.acquire).toHaveBeenCalledOnce();
    io.resolve(undefined);
    await pendingFeedback;
  });

  it('backend acquire cancellation keeps the original reason and does not create feedback', async () => {
    const { base, wrapped } = setup();
    const controller = new AbortController();
    const reason = new Error('synthetic acquisition cancel');
    controller.abort(reason);
    base.acquire.mockRejectedValue(reason);
    await expect(wrapped.acquire(HOST, { signal: controller.signal })).rejects.toBe(reason);
    expect(base.recordSuccess).not.toHaveBeenCalled();
    expect(base.recordFailure).not.toHaveBeenCalled();
    expect(wrapped.getOperations()).toEqual([]);
  });
});
