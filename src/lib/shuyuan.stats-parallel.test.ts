import { afterEach, beforeEach, expect, it, vi } from 'vitest';
type Query = { text: string; values: unknown[] };
const mock = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  const transaction = vi.fn();
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
    return { ...query, then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => execute(query).then(resolve, reject) };
  }, { transaction });
  return { execute, transaction, sql };
});
vi.mock('./db', () => ({ getSql: () => mock.sql }));
import { getShuyuanStats } from './shuyuan';

function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const counts = { total: 3, active: 1, enabled: 2, disabled: 1, unprobed: 1, pending: 0, reachable: 1, failed: 1 };
let meta: ReturnType<typeof gate<unknown[]>>;
let aggregate: ReturnType<typeof gate<unknown[]>>;
let rows: ReturnType<typeof gate<unknown[]>>;
beforeEach(() => {
  meta = gate(); aggregate = gate(); rows = gate();
  mock.execute.mockReset().mockImplementation(query => query.text.includes('FROM shuyuan_meta') ? meta.promise
    : query.text.startsWith('SELECT count(*)') ? aggregate.promise : rows.promise);
  mock.transaction.mockReset().mockImplementation((queries: Query[]) => Promise.all(queries.map(mock.execute)));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('real network forbidden'); }));
});
afterEach(() => vi.unstubAllGlobals());
async function releaseMeta() {
  await vi.waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1));
  meta.resolve([{ collections: [], refreshed_at: null }]);
  await vi.waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(3));
}

it.each([false, true])('starts both reads only after meta, preserves result and read-only signal=%s', async withSignal => {
  const signal = withSignal ? new AbortController().signal : undefined;
  const pending = getShuyuanStats(signal, { filter: 'disabled', page: 2 });
  await releaseMeta();
  rows.resolve([]); aggregate.resolve([counts]);
  expect(await pending).toMatchObject({ total: 1, enabled: 2, disabled: 1, filter: 'disabled', page: 2, sources: [], collections: [], refreshedAt: null });
  const query = mock.execute.mock.calls[2][0];
  expect(query.values.slice(1, 8)).toEqual(Array(7).fill('disabled'));
  expect(query.values[9]).toBe(query.values[8]);
  if (signal) {
    expect(mock.transaction).toHaveBeenCalledTimes(3);
    for (const [batch, options] of mock.transaction.mock.calls) {
      expect(batch).toHaveLength(1);
      expect(options).toEqual({ readOnly: true, fetchOptions: { signal } });
    }
  } else expect(mock.transaction).not.toHaveBeenCalled();
});

it('meta failure never starts dependent reads', async () => {
  const failure = new Error('synthetic meta');
  const pending = getShuyuanStats(); const rejected = expect(pending).rejects.toBe(failure);
  meta.reject(failure); await rejected;
  expect(mock.execute).toHaveBeenCalledTimes(1);
});

it('counts failure returns without waiting for rows and safely handles a later rows rejection', async () => {
  const failure = new Error('synthetic counts');
  const pending = getShuyuanStats(); const rejected = expect(pending).rejects.toBe(failure);
  await releaseMeta(); aggregate.reject(failure); await rejected;
  rows.reject(new Error('synthetic late rows'));
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('early rows failure is handled immediately but counts error still wins', async () => {
  const failure = new Error('synthetic counts');
  const pending = getShuyuanStats(); const rejected = expect(pending).rejects.toBe(failure);
  await releaseMeta(); rows.reject(new Error('synthetic early rows'));
  await new Promise<void>(resolve => setImmediate(resolve));
  aggregate.reject(failure); await rejected;
});

it('throws rows error after successful counts rather than returning a partial list', async () => {
  const failure = new Error('synthetic rows');
  const pending = getShuyuanStats(); const rejected = expect(pending).rejects.toBe(failure);
  await releaseMeta(); rows.reject(failure); aggregate.resolve([counts]); await rejected;
});

it('keeps the legacy shape without pagination fields', async () => {
  const pending = getShuyuanStats(); await releaseMeta(); aggregate.resolve([counts]); rows.resolve([]);
  const result = await pending;
  expect(result).toMatchObject({ ...counts, sources: [], collections: [], refreshedAt: null });
  expect(result).not.toHaveProperty('page'); expect(result).not.toHaveProperty('filter');
});

it('pre-aborted signal starts no transaction', async () => {
  const controller = new AbortController(); controller.abort(new Error('synthetic abort'));
  await expect(getShuyuanStats(controller.signal)).rejects.toThrow();
  expect(mock.execute).not.toHaveBeenCalled(); expect(mock.transaction).not.toHaveBeenCalled();
});

it('cancels waiting for both outstanding reads with the original signal', async () => {
  const controller = new AbortController();
  const pending = getShuyuanStats(controller.signal); const rejected = expect(pending).rejects.toThrow();
  await releaseMeta(); controller.abort(); await rejected;
  aggregate.resolve([counts]); rows.reject(new Error('synthetic late rows'));
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const [, options] of mock.transaction.mock.calls) expect(options.fetchOptions.signal).toBe(controller.signal);
});
