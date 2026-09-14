import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql, fetchMock } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn(),
  fetchMock: vi.fn<typeof fetch>(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

import { GET } from './route';

const task = { id: 42, title: '长篇/小说', author: '测试作者', status: 'done' };
const bookName = '长篇小说-测试作者.txt';

function download(token: string | null = 'file-test-owner') {
  return GET(new NextRequest('http://localhost/api/download/42/file', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), { params: Promise.resolve({ id: '42' }) });
}

function mockFile(response: Response) {
  fetchMock.mockResolvedValueOnce(Response.json([{ name: bookName }]))
    .mockResolvedValueOnce(response);
}

describe('GET /api/download/[id]/file', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'file-test-owner');
    vi.stubEnv('GITHUB_TOKEN', 'file-test-github');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() => { throw new Error('Unexpected network request'); });
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    sql.mockResolvedValue([task]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([null, 'wrong-owner'])('rejects %s credentials before accessing data', async (token) => {
    expect((await download(token)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(getSql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns headers and the first chunk before the upstream file finishes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    mockFile(new Response(new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController; },
    })));

    const res = await download();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="novel.txt"; filename*=UTF-8''${encodeURIComponent('长篇小说.txt')}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining(`/contents/books/${encodeURIComponent(bookName)}`),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github.raw',
          Authorization: 'Bearer file-test-github',
        }),
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );

    const reader = res.body!.getReader();
    const first = new TextEncoder().encode('第一章：开篇\n');
    controller.enqueue(first);
    await expect(reader.read()).resolves.toEqual({ value: first, done: false });

    const last = new TextEncoder().encode('终章：完结\n');
    controller.enqueue(last);
    controller.close();
    await expect(reader.read()).resolves.toEqual({ value: last, done: false });
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
  });

  it('transfers a 17 MiB file in order without waiting for all chunks before returning', async () => {
    const chunkSize = 64 * 1024;
    const chunkCount = 272;
    let produced = 0;
    mockFile(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkSize).fill(produced % 256));
        produced++;
      },
    })));

    const res = await download();

    expect(res.status).toBe(200);
    expect(produced).toBeLessThan(chunkCount);
    const reader = res.body!.getReader();
    let received = 0;
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBe(chunkSize);
      expect(value[0]).toBe(received % 256);
      expect(value[value.length - 1]).toBe(received % 256);
      bytes += value.byteLength;
      received++;
    }
    expect(received).toBe(chunkCount);
    expect(bytes).toBe(17 * 1024 * 1024);
  });

  it('propagates client cancellation to the upstream stream', async () => {
    const cancel = vi.fn();
    mockFile(new Response(new ReadableStream<Uint8Array>({ cancel })));

    const res = await download();
    await res.body!.cancel('client disconnected');

    expect(cancel).toHaveBeenCalledWith('client disconnected');
  });

  it('propagates an upstream failure after streaming starts', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    mockFile(new Response(new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController; },
    })));

    const res = await download();
    const reader = res.body!.getReader();
    const first = new TextEncoder().encode('第一章\n');
    controller.enqueue(first);
    await expect(reader.read()).resolves.toEqual({ value: first, done: false });

    const error = new Error('upstream connection closed');
    controller.error(error);
    await expect(reader.read()).rejects.toBe(error);
  });

  it.each([404, 204])('does not create an attachment for upstream HTTP %s without a body', async (status) => {
    mockFile(new Response(null, { status }));

    const res = await download();

    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: 'file not found' });
  });

  it.each(['directory', 'file'])('applies a 60-second timeout to a stalled %s request', async (stage) => {
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    const error = new DOMException('GitHub request timed out', 'TimeoutError');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (stage === 'file') {
      fetchMock.mockResolvedValueOnce(Response.json([{ name: bookName }]));
    }
    fetchMock.mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('Missing timeout signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      queueMicrotask(() => abort.abort(error));
    }));

    const res = await download();

    expect(timeout).toHaveBeenCalledTimes(stage === 'file' ? 2 : 1);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(abort.signal.aborted).toBe(true);
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: 'file not found' });
    expect(log).toHaveBeenCalledWith(error);
  });
});
