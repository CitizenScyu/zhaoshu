import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getEngineSources, resolveSourceBook, validateSourceUrl } = vi.hoisted(() => ({
  getEngineSources: vi.fn(),
  resolveSourceBook: vi.fn(),
  validateSourceUrl: vi.fn((value: string) => new URL(value)),
}));

vi.mock('./shuyuan', () => ({ getEngineSources }));
vi.mock('./source-policy', () => {
  class SourcePolicyError extends Error {}
  return { SourcePolicyError, validateSourceUrl };
});
vi.mock('./source-reader', () => {
  class SourceReaderError extends Error {
    constructor(message: string, readonly code: string, readonly status = 500) {
      super(message);
    }
  }
  class SourceRequestContext {
    constructor(readonly signal: AbortSignal) {}
  }
  return { SourceReaderError, SourceRequestContext, resolveSourceBook };
});

import { SourceReaderError } from './source-reader';
import { resolveDownloadRelocation } from './download-relocate';

const pool = [{ url: 'https://active.example/', name: 'active', searchUrl: '/search', rules: {}, tier: 'M1' }];
const catalog = {
  title: '测试书', author: '作者', bookUrl: 'https://active.example/book/7', sourceUrl: pool[0].url,
  sourceId: 'opaque-id', sourceRevision: 'revision-7',
};

describe('resolveDownloadRelocation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getEngineSources.mockResolvedValue(pool);
    resolveSourceBook.mockResolvedValue(catalog);
    validateSourceUrl.mockImplementation((value: string) => new URL(value));
  });

  it('uses only the active engine pool and returns validated download identity', async () => {
    const signal = new AbortController().signal;
    await expect(resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, signal)).resolves.toEqual({
      bookUrl: catalog.bookUrl,
      sourceUrl: catalog.sourceUrl,
      sourceId: catalog.sourceId,
      sourceRevision: catalog.sourceRevision,
      matched: { title: catalog.title, author: catalog.author },
    });
    expect(getEngineSources).toHaveBeenCalledWith(signal);
    expect(resolveSourceBook).toHaveBeenCalledWith(
      { title: catalog.title, author: catalog.author }, expect.anything(),
      { sources: pool, searchStats: [] },
    );
    expect(validateSourceUrl).toHaveBeenCalledWith(catalog.bookUrl);
  });

  it('maps a clean empty search to RELOCATION_NO_CANDIDATES', async () => {
    resolveSourceBook.mockRejectedValueOnce(new SourceReaderError('not found', 'SOURCE_NOT_FOUND', 404));
    await expect(resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RELOCATION_NO_CANDIDATES', status: 404 });
  });

  it('maps candidates rejected by identity checks to RELOCATION_IDENTITY_MISMATCH', async () => {
    resolveSourceBook.mockImplementationOnce((_book, _context, options) => {
      options.searchStats.push({ host: 'active.example', searched: true, candidates: 2, fallbackCandidates: 0, bytes: 100 });
      throw new SourceReaderError('not found', 'SOURCE_NOT_FOUND', 404);
    });
    await expect(resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RELOCATION_IDENTITY_MISMATCH', status: 422 });
  });

  it('maps ambiguity and preserves display-only candidates', async () => {
    const candidates = [{ title: '测试书', author: '另一作者', bookUrl: 'https://active.example/other' }];
    const error = Object.assign(new SourceReaderError('ambiguous', 'SOURCE_AMBIGUOUS', 422), { candidates });
    resolveSourceBook.mockRejectedValueOnce(error);
    await expect(resolveDownloadRelocation({ title: catalog.title, author: '', }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'RELOCATION_AMBIGUOUS', status: 422, candidates,
      });
  });

  it('does not rewrite an existing availability failure', async () => {
    const unavailable = new SourceReaderError('unavailable', 'SOURCE_UNAVAILABLE', 503);
    resolveSourceBook.mockRejectedValueOnce(unavailable);
    await expect(resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, new AbortController().signal))
      .rejects.toBe(unavailable);
  });
});
