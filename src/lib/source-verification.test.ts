import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeadline } from './deadline';
import type { VerifiedCandidate } from './types';
import { sanitizeVerified } from './sanitize';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), sources: vi.fn() }));
vi.mock('./shuyuan', () => ({ getReadingSources: mocks.sources }));
vi.mock('./source-reader', async (original) => ({ ...await original<typeof import('./source-reader')>(), resolveSourceBook: mocks.resolve }));
import { supplementSourceEvidence, SOURCE_VERIFY_BUDGET_MS, SOURCE_VERIFY_REQUEST_LIMIT } from './source-verification';
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
    const deadline = createDeadline(285_000);
    try {
      const result = supplementSourceEvidence([candidate, { ...candidate, title: '第二书' }], deadline, deadline.signal);
      await vi.advanceTimersByTimeAsync(SOURCE_VERIFY_BUDGET_MS + 1);
      expect((await result).every((item) => item.sourceEvidence?.status === 'unavailable')).toBe(true);
      expect(mocks.resolve).toHaveBeenCalledOnce();
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
});
