import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadBook, downloadOptions } from './engine-download.mjs';

const ROOT = 'https://reader.test/';
const SEARCH = `${ROOT}search`;
const BOOK = `${ROOT}book`;
const TITLE = '合成测试书';
const AUTHOR = '合成作者';
const CHAPTERS = [
  { title: '第一章', url: `${ROOT}chapter/1` },
  { title: '第二章', url: `${ROOT}chapter/2` },
] as const;
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const dirs: string[] = [];
const originalListeners = new Map<(typeof SIGNALS)[number], ReturnType<typeof process.listeners>>();
type Fault = { at: 'search' | 'toc' | 'content'; error: Error };
type RequestOptions = { signal: AbortSignal; beforeRequest?: (signal: AbortSignal) => Promise<void> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected_network'); }));
  for (const signal of SIGNALS) originalListeners.set(signal, process.listeners(signal));
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    for (const signal of SIGNALS) expect(process.listeners(signal)).toEqual(originalListeners.get(signal));
  } finally {
    for (const signal of SIGNALS) {
      const saved = originalListeners.get(signal) ?? [];
      for (const listener of process.listeners(signal)) {
        if (!saved.includes(listener)) process.off(signal, listener as () => void);
      }
      for (const listener of saved) {
        if (!process.listeners(signal).includes(listener)) process.on(signal, listener as () => void);
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

function feedbackError() {
  return Object.assign(new Error('synthetic_feedback_wrapper'), {
    code: 'LIMITER_FEEDBACK_UNAVAILABLE',
    origin: 'limiter-feedback',
    requestError: Object.assign(new Error('synthetic_request_detail'), { status: 429 }),
    cause: new Error('synthetic_feedback_detail'),
  });
}

function setup(fault: Fault, cleanupError?: Error) {
  const out = mkdtempSync(join(tmpdir(), 'engine-feedback-'));
  dirs.push(out);
  const source = { url: ROOT, name: 'synthetic', searchUrl: '/search' };
  const options = downloadOptions({
    source: ROOT, title: TITLE, author: AUTHOR, out,
    'rate-ms': 0, 'timeout-ms': 1000, 'budget-ms': 5000,
  });
  // Only parser inputs are synthetic; the imported downloadBook owns the real control flow.
  const modules = { parser: {
    sourceSearchUrl: () => SEARCH,
    parseSourceSearch: () => [BOOK],
    parseSourceIdentity: () => ({ title: TITLE, author: AUTHOR }),
    parseSourceChapters: () => CHAPTERS.map(chapter => ({ ...chapter })),
    parseSourceChapterText: (text: string) => text,
  } };
  const calls: string[] = [];
  let bookReads = 0;
  const transport = async (url: string, request: RequestOptions) => {
    calls.push(url);
    await request.beforeRequest?.(request.signal);
    request.signal.throwIfAborted();
    if (url === BOOK) bookReads++;
    const stage = url === SEARCH ? 'search'
      : url === BOOK && bookReads === 2 ? 'toc'
        : url === CHAPTERS[0].url ? 'content' : null;
    if (stage === fault.at) throw fault.error;
    if (url !== SEARCH && url !== BOOK && !CHAPTERS.some(chapter => chapter.url === url)) {
      throw new Error('unexpected_synthetic_url');
    }
    return { url, text: '合成章节正文。' };
  };
  const progress = vi.fn(async () => { if (cleanupError) throw cleanupError; });
  const run = () => downloadBook(modules, options, async () => ({ source, builtin: true }), transport, { onProgress: progress });
  const checkpoint = () => {
    const entries = readdirSync(out);
    expect(entries).toHaveLength(1);
    const dir = join(out, entries[0]!);
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
    expect(existsSync(join(dir, 'download.lock'))).toBe(false);
    expect(existsSync(join(dir, 'book.txt'))).toBe(false);
    const manifest = JSON.parse(raw);
    expect(manifest.status).toBe('partial');
    expect(manifest).not.toHaveProperty('artifact');
    return { raw, manifest };
  };
  return { run, calls, checkpoint, progress };
}

function expectFeedbackCheckpoint(fixture: ReturnType<typeof setup>, error: ReturnType<typeof feedbackError>) {
  const saved = fixture.checkpoint();
  expect(saved.manifest.errors).toEqual(['limiter_feedback_unavailable']);
  for (const message of [error.message, error.requestError.message, error.cause.message]) {
    expect(saved.raw).not.toContain(message);
  }
  for (const key of ['"cause"', '"requestError"', '"origin"', '"code"']) expect(saved.raw).not.toContain(key);
  return saved.manifest;
}

describe('downloadBook limiter feedback propagation', () => {
  it('stops at the first content feedback failure and rejects with the original error', async () => {
    const error = feedbackError();
    const fixture = setup({ at: 'content', error });
    await expect(fixture.run()).rejects.toBe(error);
    expect(fixture.calls).toEqual([SEARCH, BOOK, BOOK, CHAPTERS[0].url]);
    const manifest = expectFeedbackCheckpoint(fixture, error);
    expect(manifest.chapters.map((chapter: { status: string }) => chapter.status)).toEqual(['pending', 'pending']);
    expect(manifest.chapters[0]).not.toHaveProperty('error');
    expect(manifest.chapters_done).toBe(0);
  });

  it.each(['search', 'toc'] as const)('propagates %s feedback failure instead of returning a normal code', async at => {
    const error = feedbackError();
    const fixture = setup({ at, error });
    await expect(fixture.run()).rejects.toBe(error);
    expect(fixture.calls).toEqual(at === 'search' ? [SEARCH] : [SEARCH, BOOK, BOOK]);
    expectFeedbackCheckpoint(fixture, error);
  });

  it('keeps ordinary chapter failure, subsequent chapter fetch and missing_chapters behavior', async () => {
    const fixture = setup({ at: 'content', error: new Error('synthetic_ordinary_failure') });
    const result = await fixture.run();
    expect(result.code).toBe(1);
    expect(fixture.calls).toEqual([SEARCH, BOOK, BOOK, CHAPTERS[0].url, CHAPTERS[1].url, BOOK]);
    const { manifest } = fixture.checkpoint();
    expect(manifest.errors).toEqual(['missing_chapters']);
    expect(manifest.chapters[0]).toMatchObject({ status: 'failed', error: 'chapter_failed' });
    expect(manifest.chapters[1].status).toBe('done');
    expect(manifest.chapters_done).toBe(1);
  });

  const nonFeedback = [
    ['code only', Object.assign(new Error('limiter_feedback_unavailable'), { code: 'LIMITER_FEEDBACK_UNAVAILABLE' })],
    ['origin only', Object.assign(new Error('limiter_feedback_unavailable'), { origin: 'limiter-feedback' })],
    ['status/message/name only', Object.assign(new Error('limiter_feedback_unavailable'), { status: 503, name: 'LimiterFeedbackError' })],
    ['nested fields only', Object.assign(new Error('limiter_feedback_unavailable'), { cause: feedbackError(), requestError: feedbackError() })],
  ] as const;
  it.each(nonFeedback)('does not propagate %s as a feedback protocol match', async (_name, error) => {
    const fixture = setup({ at: 'content', error });
    const result = await fixture.run();
    expect(result.code).toBe(1);
    expect(fixture.calls).toEqual([SEARCH, BOOK, BOOK, CHAPTERS[0].url, CHAPTERS[1].url, BOOK]);
    const { manifest } = fixture.checkpoint();
    expect(manifest.errors).toEqual(['missing_chapters']);
    expect(manifest.chapters[0]).toMatchObject({ status: 'failed', error: 'chapter_failed' });
    expect(manifest.chapters[1].status).toBe('done');
  });

  it('retains frozen feedback and final checkpoint errors in a structured aggregate', async () => {
    const error = Object.freeze(feedbackError());
    const cleanupError = new Error('synthetic_cleanup_failure');
    // Search fails before any earlier checkpoint, so this callback is reached only in finally.
    const fixture = setup({ at: 'search', error }, cleanupError);
    const rejected = await fixture.run().then(
      () => { throw new Error('expected_feedback_cleanup_rejection'); },
      failure => failure,
    );
    expect(rejected).toBeInstanceOf(AggregateError);
    expect(rejected.message).toBe('Limiter feedback cleanup failed');
    expect(rejected.name).toBe('LimiterFeedbackCleanupError');
    expect(rejected.code).toBe('LIMITER_FEEDBACK_UNAVAILABLE');
    expect(rejected.origin).toBe('limiter-feedback');
    expect(rejected.persistenceOutcome).toBe('unknown');
    expect(rejected.cause).toBe(error);
    expect(rejected.errors).toHaveLength(2);
    expect(rejected.errors[0]).toBe(error);
    expect(rejected.errors[1]).toBe(cleanupError);
    expect(Object.getOwnPropertyDescriptor(rejected, 'cause')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(rejected, 'errors')?.enumerable).toBe(false);
    expect(Object.keys(rejected).sort()).toEqual(['code', 'name', 'origin', 'persistenceOutcome']);
    expect(Object.isFrozen(error)).toBe(true);
    expect(fixture.calls).toEqual([SEARCH]);
    expect(fixture.progress).toHaveBeenCalledTimes(1);
    const saved = expectFeedbackCheckpoint(fixture, error);
    expect(saved.chapters_done).toBe(0);
    const raw = fixture.checkpoint().raw;
    expect(raw).not.toContain(cleanupError.message);
    expect(raw).not.toContain('Limiter feedback cleanup failed');
    expect(raw).not.toContain('persistenceOutcome');
  });

  it('propagates a final checkpoint error unchanged when no feedback error was saved', async () => {
    const cleanupError = new Error('synthetic_cleanup_only_failure');
    const fixture = setup({ at: 'search', error: new Error('synthetic_ordinary_search_failure') }, cleanupError);
    await expect(fixture.run()).rejects.toBe(cleanupError);
    expect(cleanupError).not.toBeInstanceOf(AggregateError);
    expect(cleanupError).not.toHaveProperty('code');
    expect(cleanupError).not.toHaveProperty('origin');
    expect(fixture.calls).toEqual([SEARCH]);
    expect(fixture.progress).toHaveBeenCalledTimes(1);
    expect(fixture.checkpoint().manifest.errors).toEqual(['download_failed']);
  });
});
