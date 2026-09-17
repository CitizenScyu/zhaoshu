import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeadline } from './deadline';
import type { VerifiedCandidate } from './types';
import { sanitizeVerified } from './sanitize';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), sources: vi.fn() }));
vi.mock('./shuyuan', () => ({ getReadingSources: mocks.sources }));
vi.mock('./source-reader', async (original) => ({ ...await original<typeof import('./source-reader')>(), resolveSourceBook: mocks.resolve }));
import { supplementSourceEvidence, SOURCE_VERIFY_BUDGET_MS, SOURCE_VERIFY_CONCURRENCY, SOURCE_VERIFY_REQUEST_LIMIT } from './source-verification';
import { SourceReaderError } from './source-reader';

const candidate: VerifiedCandidate = { title: '测试书', author: '作者', category: '', wordCount: '', why: '', source: 'llm', douban: { status: 'not_found', found: false } };
const match = { sourceName: '测试来源', bookUrl: 'https://book15.net/books/details42.html' };
beforeEach(() => { vi.resetAllMocks(); mocks.sources.mockResolvedValue([]); mocks.resolve.mockResolvedValue(match); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('source existence supplement inside verify', () => {
  it('does not query sources for a Douban-verified work', async () => {
    const deadline = createDeadline(285_000);
    try {
      const verified = { ...candidate, douban: { status: 'verified' as const, found: true } };
      expect(await supplementSourceEvidence([verified], deadline, deadline.signal)).toEqual([verified]);
      expect(mocks.sources).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    } finally { deadline.dispose(); }
  });

  it('keeps source evidence separate, never inventing Douban ratings or status', async () => {
    const deadline = createDeadline(285_000);
    try {
      const result = await supplementSourceEvidence([candidate], deadline, deadline.signal);
      expect(result[0].douban).toEqual({ status: 'not_found', found: false });
      expect(result[0].sourceEvidence).toMatchObject({ status: 'matched', sourceName: match.sourceName, url: match.bookUrl });
      expect(result[0].sourceEvidence?.note).toContain('不代表豆瓣');
    } finally { deadline.dispose(); }
  });

  it('shares one request cap and source list across candidates, preserving verify progress', async () => {
    const deadline = createDeadline(285_000);
    const progress = vi.fn();
    try {
      await supplementSourceEvidence([candidate, { ...candidate, title: '第二书' }], deadline, deadline.signal, progress);
      expect(mocks.resolve.mock.calls[0][1]).toBe(mocks.resolve.mock.calls[1][1]);
      expect(mocks.resolve.mock.calls[0][1].limit).toBe(SOURCE_VERIFY_REQUEST_LIMIT);
      expect(mocks.sources).toHaveBeenCalledOnce();
      expect(progress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
    } finally { deadline.dispose(); }
  });

  it('preserves earlier evidence when one source cannot be searched', async () => {
    mocks.resolve.mockRejectedValueOnce(new SourceReaderError('not found', 'SOURCE_NOT_FOUND'));
    const deadline = createDeadline(285_000);
    try {
      const result = await supplementSourceEvidence([candidate, { ...candidate, title: '第二书' }], deadline, deadline.signal);
      expect(result.map((item) => item.sourceEvidence?.status)).toEqual(['not_found', 'matched']);
      expect(result.every((item) => item.douban.status === 'not_found')).toBe(true);
    } finally { deadline.dispose(); }
  });

  it('does no source work when only the write reserve remains', async () => {
    const deadline = createDeadline(12_000);
    try {
      expect((await supplementSourceEvidence([candidate], deadline, deadline.signal))[0].sourceEvidence?.status).toBe('unavailable');
      expect(mocks.sources).not.toHaveBeenCalled();
    } finally { deadline.dispose(); }
  });

  it('times out the entire supplement without gaining another per-candidate budget', async () => {
    vi.useFakeTimers();
    mocks.resolve.mockImplementation((_book, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    }));
    const books = Array.from({ length: 5 }, (_, index) => ({ ...candidate, title: `书${index}` }));
    const deadline = createDeadline(285_000);
    try {
      const result = supplementSourceEvidence(books, deadline, deadline.signal);
      await vi.advanceTimersByTimeAsync(SOURCE_VERIFY_BUDGET_MS + 1);
      const settled = await result;
      expect(settled.every((item) => item.sourceEvidence?.status === 'unavailable')).toBe(true);
      // 共享预算到期时并行在飞的候选一起被终止；剩下的候选从未启动，也不会获得新预算。
      expect(settled.filter((item) => item.sourceEvidence?.code === 'SOURCE_VERIFY_TIMEOUT'))
        .toHaveLength(SOURCE_VERIFY_CONCURRENCY);
      expect(settled.filter((item) => item.sourceEvidence?.code === 'SOURCE_VERIFY_SKIPPED'))
        .toHaveLength(books.length - SOURCE_VERIFY_CONCURRENCY);
      expect(mocks.resolve).toHaveBeenCalledTimes(SOURCE_VERIFY_CONCURRENCY);
      expect(deadline.remainingMs).toBeLessThan(285_000);
    } finally { deadline.dispose(); }
  });

  it('stops starting candidates after the shared HTTP request cap is consumed', async () => {
    mocks.resolve.mockImplementation(async (_book, context) => { context.requests = context.limit; return match; });
    const deadline = createDeadline(285_000);
    try {
      const result = await supplementSourceEvidence([candidate, { ...candidate, title: '第二书' }], deadline, deadline.signal);
      expect(result.map((item) => item.sourceEvidence?.status)).toEqual(['matched', 'unavailable']);
      expect(mocks.resolve).toHaveBeenCalledOnce();
    } finally { deadline.dispose(); }
  });

  it('preserves cancellation instead of treating it as a negative existence result', async () => {
    const deadline = createDeadline(285_000);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    try {
      await expect(supplementSourceEvidence([candidate], deadline, controller.signal)).rejects.toThrow('cancelled');
      expect(mocks.sources).not.toHaveBeenCalled();
    } finally { deadline.dispose(); }
  });

  it('sanitizes source evidence while leaving Douban not_found intact', () => {
    const evidence = { status: 'matched', sourceName: '书源', url: match.bookUrl, checkedAt: '2026-09-16T00:00:00Z', note: '仅目录' };
    const clean = sanitizeVerified([{ ...candidate, sourceEvidence: evidence }]);
    expect(clean[0].sourceEvidence).toEqual(evidence);
    expect(clean[0].douban.status).toBe('not_found');
    for (const url of ['javascript:alert(1)', 'https://evil.invalid/books/details42.html', 'https://book15.net/chapter/index42-1.html']) {
      expect(sanitizeVerified([{ ...candidate, sourceEvidence: { ...evidence, url } }])[0].sourceEvidence?.status).toBe('unavailable');
    }
  });

  it('keeps distinct failure codes instead of collapsing every miss into one unavailable', async () => {
    const notes = new Map<string, string>();
    const record = async (error: unknown) => {
      mocks.resolve.mockRejectedValueOnce(error);
      const deadline = createDeadline(285_000);
      try {
        const [entry] = await supplementSourceEvidence([{ ...candidate }], deadline, deadline.signal);
        notes.set(entry.sourceEvidence!.code!, entry.sourceEvidence!.note);
        return entry.sourceEvidence!;
      } finally { deadline.dispose(); }
    };
    expect(await record(new SourceReaderError('missing', 'SOURCE_NOT_FOUND')))
      .toMatchObject({ status: 'not_found', code: 'SOURCE_NOT_FOUND' });
    expect(await record(new SourceReaderError('duplicate', 'SOURCE_AMBIGUOUS')))
      .toMatchObject({ status: 'unavailable', code: 'SOURCE_AMBIGUOUS' });
    expect(await record(new SourceReaderError('site down', 'SOURCE_UNAVAILABLE')))
      .toMatchObject({ status: 'unavailable', code: 'SOURCE_UNAVAILABLE' });
    expect(await record(new SourceReaderError('quota', 'SOURCE_BUDGET_EXCEEDED')))
      .toMatchObject({ status: 'unavailable', code: 'SOURCE_BUDGET_EXCEEDED' });
    expect(await record(new Error('socket hang up')))
      .toMatchObject({ status: 'unavailable', code: 'SOURCE_VERIFY_ERROR' });
    // 每条失败的 note 必须互不相同，否则前端仍然分不清「站点没有」和「站点挂了」。
    expect(new Set(notes.values()).size).toBe(notes.size);
  });

  it('overlaps candidate lookups instead of running them one after another', async () => {
    vi.useFakeTimers();
    const DELAY = 1_000;
    mocks.resolve.mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve(match), DELAY); }));
    const progress = vi.fn();
    const books = Array.from({ length: 6 }, (_, index) => ({ ...candidate, title: `书${index}` }));
    const deadline = createDeadline(285_000);
    try {
      const completed = supplementSourceEvidence(books, deadline, deadline.signal, progress);
      await vi.advanceTimersByTimeAsync(DELAY + 1);
      // 并发下第一轮同时完成 SOURCE_VERIFY_CONCURRENCY 本；串行实现此时只会完成 1 本。
      expect(progress).toHaveBeenLastCalledWith(SOURCE_VERIFY_CONCURRENCY, books.length);
      await vi.advanceTimersByTimeAsync(DELAY + 1);
      expect(progress).toHaveBeenLastCalledWith(books.length, books.length);
      await expect(completed).resolves.toHaveLength(books.length);
    } finally { deadline.dispose(); }
  });

  it('never runs more source lookups concurrently than the cap', async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.resolve.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inFlight -= 1;
      return match;
    });
    const books = Array.from({ length: 9 }, (_, index) => ({ ...candidate, title: `书${index}` }));
    const deadline = createDeadline(285_000);
    try {
      const result = await supplementSourceEvidence(books, deadline, deadline.signal);
      expect(result.every((item) => item.sourceEvidence?.status === 'matched')).toBe(true);
    } finally { deadline.dispose(); }
    expect(peak).toBe(SOURCE_VERIFY_CONCURRENCY);
  });

  it('logs and explains a wholesale source-list failure instead of swallowing it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sources.mockRejectedValue(new Error('source list down'));
    const deadline = createDeadline(285_000);
    try {
      const result = await supplementSourceEvidence([candidate], deadline, deadline.signal);
      expect(result[0].sourceEvidence).toMatchObject({ status: 'unavailable', code: 'SOURCE_VERIFY_ERROR' });
      expect(logged).toHaveBeenCalled();
    } finally { deadline.dispose(); }
  });

  it('carries the failure code through sanitize for the rerank round-trip', () => {
    const evidence = { status: 'unavailable' as const, code: 'SOURCE_AMBIGUOUS' as const, note: '同名多部' };
    expect(sanitizeVerified([{ ...candidate, sourceEvidence: evidence }])[0].sourceEvidence).toEqual(evidence);
    // 未知 code 一律丢弃，不把客户端传来的任意字符串透传下去。
    const forged = { status: 'unavailable' as const, code: 'evil<script>' as never, note: '注' };
    expect(sanitizeVerified([{ ...candidate, sourceEvidence: forged }])[0].sourceEvidence)
      .toEqual({ status: 'unavailable', note: '注' });
  });
});
