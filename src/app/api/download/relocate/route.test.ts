import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql, relocate, reclaim } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
  relocate: vi.fn(),
  reclaim: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
vi.mock('@/lib/download-task-reclaim', () => ({ reclaimStaleTasks: reclaim }));
vi.mock('@/lib/download-relocate', async (original) => ({
  ...await original<typeof import('@/lib/download-relocate')>(),
  resolveDownloadRelocation: relocate,
}));

import { DownloadRelocationError } from '@/lib/download-relocate';
import { SourceReaderError } from '@/lib/source-reader';
import { POST } from './route';

const book = { id: 7, title: '测试书', author: '作者' };
const resolved = {
  bookUrl: 'https://active.example/book/7',
  sourceUrl: 'https://active.example/',
  sourceId: 'opaque-source-id',
  sourceRevision: 'revision-7',
  matched: { title: book.title, author: book.author },
};

function request(body: unknown, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/download/relocate', {
    method: 'POST',
    headers: { Authorization: 'Bearer relocate-test-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function queryText(index: number) {
  return sql.mock.calls[index][0].join('?').replace(/\s+/g, ' ').trim();
}

describe('POST /api/download/relocate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'relocate-test-owner');
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    reclaim.mockResolvedValue(undefined);
    relocate.mockResolvedValue(resolved);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves from the active pool and inserts the opaque engine identity without updating labeled_books', async () => {
    sql.mockResolvedValueOnce([book]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 81 }]);

    const response = await POST(request({ bookId: book.id }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      taskId: 81,
      resolvedSource: {
        bookUrl: resolved.bookUrl,
        sourceUrl: resolved.sourceUrl,
        revision: resolved.sourceRevision,
        matched: resolved.matched,
      },
    });
    expect(relocate).toHaveBeenCalledWith({ title: book.title, author: book.author }, expect.any(AbortSignal));
    expect(queryText(0)).toBe('SELECT id, title, author FROM labeled_books WHERE id = ?');
    expect(queryText(1)).toContain("status IN ('pending', 'running')");
    expect(queryText(2)).toMatch(/^INSERT INTO download_tasks /);
    expect(sql.mock.calls[2].slice(1)).toEqual([
      1, book.id, book.title, book.author, resolved.bookUrl, resolved.sourceId, resolved.sourceRevision,
    ]);
    expect(sql.mock.calls.every((call) => !call[0].join('?').includes('UPDATE labeled_books'))).toBe(true);
  });

  it('does not resolve or insert when the book does not exist', async () => {
    sql.mockResolvedValueOnce([]);
    const response = await POST(request({ bookId: book.id }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'BOOK_NOT_FOUND' });
    expect(relocate).not.toHaveBeenCalled();
    expect(reclaim).not.toHaveBeenCalled();
  });

  it.each([
    ['RELOCATION_NO_CANDIDATES', 404, undefined],
    ['RELOCATION_IDENTITY_MISMATCH', 422, undefined],
    ['RELOCATION_AMBIGUOUS', 422, [{ title: '测试书', author: '另一作者', bookUrl: 'https://active.example/other' }]],
  ] as const)('returns %s without enqueueing', async (code, status, candidates) => {
    sql.mockResolvedValueOnce([book]);
    relocate.mockRejectedValueOnce(new DownloadRelocationError('cannot relocate', code, status, candidates));
    const response = await POST(request({ bookId: book.id }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: 'cannot relocate', code,
      ...(code === 'RELOCATION_AMBIGUOUS' ? { candidates } : {}),
    });
    expect(reclaim).not.toHaveBeenCalled();
    expect(sql).toHaveBeenCalledOnce();
  });

  it('passes through availability failures with their original status and code', async () => {
    sql.mockResolvedValueOnce([book]);
    relocate.mockRejectedValueOnce(new SourceReaderError('pool unavailable', 'SOURCE_UNAVAILABLE', 503));
    const response = await POST(request({ bookId: book.id }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'pool unavailable', code: 'SOURCE_UNAVAILABLE' });
    expect(reclaim).not.toHaveBeenCalled();
  });

  it('maps an aborted relocation to 504 REQUEST_ABORTED, not a 500 db error', async () => {
    sql.mockResolvedValueOnce([book]);
    relocate.mockImplementationOnce((_book, signal) => Promise.reject(signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError')));
    const response = await POST(request({ bookId: book.id }));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'relocation aborted or timed out', code: 'REQUEST_ABORTED' });
    expect(reclaim).not.toHaveBeenCalled();
  });

  it('maps a client-aborted request to 504 REQUEST_ABORTED, not a 500 db error', async () => {
    sql.mockResolvedValueOnce([book]);
    const controller = new AbortController();
    relocate.mockImplementationOnce((_book, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')));
      controller.abort(new Error('client aborted'));
    }));
    const response = await POST(request({ bookId: book.id }, controller.signal));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'relocation aborted or timed out', code: 'REQUEST_ABORTED' });
    expect(reclaim).not.toHaveBeenCalled();
  });

  it('returns the active task and never inserts a duplicate', async () => {
    sql.mockResolvedValueOnce([book]).mockResolvedValueOnce([{ id: 55, status: 'running' }]);
    const response = await POST(request({ bookId: book.id }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TASK_CONFLICT', taskId: 55, status: 'running' });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('recovers a unique-index race by returning the winning active task', async () => {
    sql.mockResolvedValueOnce([book])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
      .mockResolvedValueOnce([{ id: 56, status: 'pending' }]);
    const response = await POST(request({ bookId: book.id }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TASK_CONFLICT', taskId: 56, status: 'pending' });
  });
});
