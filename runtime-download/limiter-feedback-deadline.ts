import { performance } from 'node:perf_hooks';
import type { RateLimiterLike } from './engine';

export type FeedbackPhase = 'success' | 'failure';
export type FeedbackHostStatus = 'OPEN' | 'DRAINING' | 'QUARANTINED';
export type FeedbackPublicState = 'PENDING' | 'FULFILLED' | 'REJECTED_IO' | 'REJECTED_TIMEOUT' | 'REJECTED_QUARANTINE';
export type FeedbackIOState = 'NOT_STARTED' | 'PENDING' | 'RESOLVED' | 'REJECTED';

export interface FeedbackDeadlineOptions {
  feedbackTimeoutMs: number;
  /** Trusted, finite monotonic clock; timer hooks must schedule deferred callbacks. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FeedbackDiagnostic {
  readonly opId: number;
  readonly host: string;
  readonly phase: FeedbackPhase;
  readonly t0: number;
  readonly deadline: number;
  readonly publicState: FeedbackPublicState;
  readonly ioState: FeedbackIOState;
  /** Only settlement of the backend's full I/O-and-cleanup promise confirms RELEASED. */
  readonly resources: 'NOT_STARTED' | 'UNKNOWN' | 'RELEASED';
}

export interface FeedbackDeadlineLimiter extends RateLimiterLike {
  recordSuccess(...args: Parameters<NonNullable<RateLimiterLike['recordSuccess']>>): Promise<void>;
  recordFailure(...args: Parameters<NonNullable<RateLimiterLike['recordFailure']>>): Promise<void>;
  getHostStatus(host: string): FeedbackHostStatus;
  getOperations(host?: string): readonly FeedbackDiagnostic[];
}

export class FeedbackDeadlineError extends Error {
  readonly name = 'FeedbackDeadlineError';
  readonly code = 'LIMITER_FEEDBACK_DEADLINE';
  readonly origin = 'limiter-feedback';

  constructor(
    readonly opId: number,
    readonly host: string,
    readonly phase: FeedbackPhase,
    readonly t0: number,
    readonly deadline: number,
  ) {
    super('Limiter feedback deadline exceeded');
    Object.freeze(this);
  }
}

export class FeedbackHostStateError extends Error {
  readonly name = 'FeedbackHostStateError';
  readonly origin = 'limiter-feedback';
  readonly code: 'LIMITER_FEEDBACK_PENDING' | 'LIMITER_FEEDBACK_HOST_QUARANTINED';

  constructor(readonly host: string, readonly state: 'DRAINING' | 'QUARANTINED') {
    super(state === 'DRAINING' ? 'Limiter feedback pending' : 'Limiter feedback host quarantined');
    this.code = state === 'DRAINING' ? 'LIMITER_FEEDBACK_PENDING' : 'LIMITER_FEEDBACK_HOST_QUARANTINED';
    Object.freeze(this);
  }
}

interface Operation {
  opId: number;
  host: string;
  phase: FeedbackPhase;
  t0: number;
  deadline: number;
  publicState: FeedbackPublicState;
  ioState: FeedbackIOState;
  resources: FeedbackDiagnostic['resources'];
  startIO: () => void | Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  ioPromise?: Promise<void>;
  ioError?: unknown;
  timer?: unknown;
  timerArmed: boolean;
  timerVersion: number;
}

interface Host {
  status: FeedbackHostStatus;
  queue: Operation[];
  active?: Operation;
}

const wrappedBackends = new WeakSet<RateLimiterLike>();

/** One wrapper per backend in this process. No reset, cross-process fence, or resource cancellation. */
export function createFeedbackDeadlineLimiter(
  limiter: RateLimiterLike,
  options: FeedbackDeadlineOptions,
): FeedbackDeadlineLimiter {
  const timeout = options.feedbackTimeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('feedbackTimeoutMs must be finite and positive');
  if ((options.setTimer === undefined) !== (options.clearTimer === undefined)) {
    throw new TypeError('setTimer and clearTimer must be supplied together');
  }
  if (wrappedBackends.has(limiter)) throw new TypeError('Feedback deadline limiter already wrapped');
  const now = options.now ?? (() => performance.now());
  const setTimer: NonNullable<FeedbackDeadlineOptions['setTimer']> = options.setTimer
    ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer: NonNullable<FeedbackDeadlineOptions['clearTimer']> = options.clearTimer
    ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // Capture methods before any operation's final admission check; preserve the backend receiver.
  const acquire = limiter.acquire;
  const success = limiter.recordSuccess;
  const failure = limiter.recordFailure;
  const hosts = new Map<string, Host>();
  const operations: Operation[] = [];
  let nextId = 0;

  function hostFor(host: string): Host {
    let state = hosts.get(host);
    if (!state) { state = { status: 'OPEN', queue: [] }; hosts.set(host, state); }
    return state;
  }

  function assertOpen(host: string) {
    const state = hostFor(host).status;
    if (state !== 'OPEN') throw new FeedbackHostStateError(host, state);
  }

  function settle(op: Operation, state: Exclude<FeedbackPublicState, 'PENDING'>, error?: unknown) {
    if (op.publicState !== 'PENDING') return false;
    op.publicState = state;
    if (state === 'FULFILLED') op.resolve(); else op.reject(error);
    return true;
  }

  function cancelTimer(op: Operation) {
    op.timerVersion++;
    const armed = op.timerArmed;
    op.timerArmed = false;
    if (armed) clearTimer(op.timer);
  }

  function quarantineQueued(host: Host) {
    host.status = 'QUARANTINED';
    for (const queued of [...host.queue]) {
      if (queued.ioState === 'NOT_STARTED' && settle(queued, 'REJECTED_QUARANTINE',
        new FeedbackHostStateError(queued.host, 'QUARANTINED'))) cancelTimer(queued);
    }
    host.queue = host.queue.filter(op => op.ioState !== 'NOT_STARTED');
  }

  // Last-resort closure for clock/scheduler faults. No user callbacks, resource release, or new I/O.
  function controlFailure(op: Operation, error: unknown) {
    const host = hostFor(op.host);
    host.status = 'QUARANTINED';
    settle(op, 'REJECTED_IO', error);
    op.timerVersion++;
    for (const queued of host.queue) {
      if (queued.ioState === 'NOT_STARTED') {
        settle(queued, 'REJECTED_QUARANTINE', new FeedbackHostStateError(queued.host, 'QUARANTINED'));
        queued.timerVersion++;
      }
    }
  }

  function expire(op: Operation) {
    if (op.publicState !== 'PENDING') return;
    const host = hostFor(op.host);
    host.status = 'QUARANTINED';
    settle(op, 'REJECTED_TIMEOUT', new FeedbackDeadlineError(op.opId, op.host, op.phase, op.t0, op.deadline));
    cancelTimer(op);
    quarantineQueued(host);
  }

  function armTimer(op: Operation) {
    const sampled = now();
    if (op.publicState !== 'PENDING') return;
    if (sampled >= op.deadline) { expire(op); return; }
    const version = ++op.timerVersion;
    op.timerArmed = true;
    op.timer = setTimer(() => {
      try {
        const observed = now();
        if (op.publicState !== 'PENDING' || version !== op.timerVersion) return;
        op.timerArmed = false;
        if (observed >= op.deadline) expire(op);
        else armTimer(op);
      } catch (error) { controlFailure(op, error); }
    }, Math.min(op.deadline - sampled, 2_147_483_647));
  }

  function observe(op: Operation, state: 'RESOLVED' | 'REJECTED', error?: unknown) {
    const observed = now();
    op.ioState = state;
    op.resources = 'RELEASED';
    if (state === 'REJECTED') op.ioError = error;
    const host = hostFor(op.host);
    if (op.publicState === 'PENDING') {
      if (observed >= op.deadline) expire(op);
      else if (state === 'REJECTED') {
        host.status = 'QUARANTINED';
        settle(op, 'REJECTED_IO', error);
        cancelTimer(op);
        quarantineQueued(host);
      } else {
        settle(op, 'FULFILLED');
        cancelTimer(op);
      }
    }
    if (host.active === op) host.active = undefined;
    host.queue = host.queue.filter(queued => queued !== op);
    pump(host);
  }

  function pump(host: Host) {
    if (host.status === 'QUARANTINED' || host.active) return;
    const op = host.queue[0];
    if (!op) { host.status = 'OPEN'; return; }
    if (op.publicState !== 'PENDING' || op.ioState !== 'NOT_STARTED') return;
    const sampled = now();
    // Recheck after the injected clock as well. Only internal assignments precede the actual call.
    if (op.publicState !== 'PENDING' || op.ioState !== 'NOT_STARTED'
      || hostFor(op.host).status === 'QUARANTINED' || host.active || host.queue[0] !== op) return;
    if (sampled >= op.deadline) { expire(op); return; }
    host.active = op;
    op.ioState = 'PENDING';
    op.resources = 'UNKNOWN';
    try {
      op.ioPromise = Promise.resolve(op.startIO());
    } catch (error) {
      observe(op, 'REJECTED', error);
      return;
    }
    // Observe both outcomes immediately, including late rejection after public timeout.
    void op.ioPromise.then(() => observe(op, 'RESOLVED'), error => observe(op, 'REJECTED', error))
      .catch(error => controlFailure(op, error));
  }

  function enqueue(hostName: string, phase: FeedbackPhase, startIO: () => void | Promise<void>): Promise<void> {
    const t0 = now();
    const deadline = t0 + timeout;
    if (!Number.isFinite(t0) || !Number.isFinite(deadline)) return Promise.reject(new RangeError('Invalid feedback deadline'));
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const op: Operation = {
      opId: ++nextId, host: hostName, phase, t0, deadline,
      publicState: 'PENDING', ioState: 'NOT_STARTED', resources: 'NOT_STARTED',
      startIO, resolve, reject, timerArmed: false, timerVersion: 0,
    };
    operations.push(op);
    const host = hostFor(hostName);
    if (host.status === 'QUARANTINED') {
      settle(op, 'REJECTED_QUARANTINE', new FeedbackHostStateError(hostName, 'QUARANTINED'));
      return result;
    }
    host.status = 'DRAINING';
    host.queue.push(op);
    try { armTimer(op); pump(host); }
    catch (error) { controlFailure(op, error); }
    return result;
  }

  const wrapper: FeedbackDeadlineLimiter = Object.freeze({
    async acquire(...args: Parameters<RateLimiterLike['acquire']>) {
      assertOpen(args[0]);
      const permit = await acquire.apply(limiter, args);
      assertOpen(args[0]);
      return permit;
    },
    recordSuccess(...args: Parameters<NonNullable<RateLimiterLike['recordSuccess']>>) {
      return enqueue(args[0], 'success', () => success?.apply(limiter, args));
    },
    recordFailure(...args: Parameters<NonNullable<RateLimiterLike['recordFailure']>>) {
      return enqueue(args[0], 'failure', () => failure?.apply(limiter, args));
    },
    getHostStatus(host: string): FeedbackHostStatus { return hosts.get(host)?.status ?? 'OPEN'; },
    getOperations(host?: string): readonly FeedbackDiagnostic[] {
      return Object.freeze(operations.filter(op => host === undefined || op.host === host).map(op => Object.freeze({
        opId: op.opId, host: op.host, phase: op.phase, t0: op.t0, deadline: op.deadline,
        publicState: op.publicState, ioState: op.ioState, resources: op.resources,
      })));
    },
  });
  wrappedBackends.add(limiter);
  wrappedBackends.add(wrapper);
  return wrapper;
}
