import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cooldownTable, getEngineSources, probeCooldownSlots, resolveSourceBook, validateSourceUrl } = vi.hoisted(() => ({
  cooldownTable: new Map<string, number>(),
  getEngineSources: vi.fn(),
  probeCooldownSlots: vi.fn(),
  resolveSourceBook: vi.fn(),
  validateSourceUrl: vi.fn((value: string) => new URL(value)),
}));

vi.mock('./shuyuan', () => ({ getEngineSources }));
vi.mock('./source-policy', () => {
  class SourcePolicyError extends Error {}
  return { SourcePolicyError, validateSourceUrl };
});
const contextOptions: Array<Record<string, unknown> | undefined> = [];
vi.mock('./source-reader', () => {
  class SourceReaderError extends Error {
    constructor(message: string, readonly code: string, readonly status = 500) {
      super(message);
    }
  }
  class SourceRequestContext {
    constructor(readonly signal: AbortSignal, _limit?: unknown, options?: Record<string, unknown>) {
      contextOptions.push(options);
    }
  }
  return { SourceReaderError, SourceRequestContext, probeCooldownSlots, resolveSourceBook };
});

import { SourcePolicyError } from './source-policy';
import { SourceReaderError } from './source-reader';
import { DownloadRelocationError, resolveDownloadRelocation } from './download-relocate';

const pool = [{ url: 'https://active.example/', name: 'active', searchUrl: '/search', rules: {}, tier: 'M1' }];
const catalog = {
  title: '测试书', author: '作者', bookUrl: 'https://active.example/book/7', sourceUrl: pool[0].url,
  sourceId: 'opaque-id', sourceRevision: 'revision-7',
};

describe('resolveDownloadRelocation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    contextOptions.length = 0;
    getEngineSources.mockResolvedValue(pool);
    resolveSourceBook.mockResolvedValue(catalog);
    // 46-revfix 断言哨兵：probeCooldownSlots 由被测实现调用（真实现读 env 决定 undefined 退回）。
    probeCooldownSlots.mockReturnValue(cooldownTable);
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

  it('maps SOURCE_SIMILAR to RELOCATION_IDENTITY_MISMATCH without candidates', async () => {
    resolveSourceBook.mockRejectedValueOnce(new SourceReaderError('similar only', 'SOURCE_SIMILAR', 422));
    const rejection = resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, new AbortController().signal);
    await expect(rejection).rejects.toBeInstanceOf(DownloadRelocationError);
    await expect(rejection).rejects.toMatchObject({ code: 'RELOCATION_IDENTITY_MISMATCH', status: 422 });
    // TS 参数属性把省略的第四参固化成自有属性 `candidates: undefined`；「不带候选」
    // 的实际口径是值为 undefined（路由层也仅在 AMBIGUOUS 才读它）。
    await expect(rejection).rejects.toMatchObject({ candidates: undefined });
  });

  it('maps a SourcePolicyError whitelist rejection to RELOCATION_IDENTITY_MISMATCH without candidates', async () => {
    resolveSourceBook.mockResolvedValueOnce({ ...catalog, bookUrl: 'https://blocked.example/book/7' });
    validateSourceUrl.mockImplementationOnce(() => { throw new SourcePolicyError('host not whitelisted'); });
    const rejection = resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, new AbortController().signal);
    await expect(rejection).rejects.toBeInstanceOf(DownloadRelocationError);
    await expect(rejection).rejects.toMatchObject({ code: 'RELOCATION_IDENTITY_MISMATCH', status: 422 });
    await expect(rejection).rejects.toMatchObject({ candidates: undefined });
  });

  it('46-revfix:搬迁 context 挂进程级共享冷却表（probe 的 429 对本腿可见）', async () => {
    await resolveDownloadRelocation({ title: catalog.title, author: catalog.author }, new AbortController().signal);
    expect(probeCooldownSlots).toHaveBeenCalledOnce();
    expect(contextOptions).toEqual([{ cooldownSlots: cooldownTable }]);
  });
});
