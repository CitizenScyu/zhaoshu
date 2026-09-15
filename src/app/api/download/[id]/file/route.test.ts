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

function download(token: string | null = 'file-test-owner', id = '42', signal?: AbortSignal) {
  return GET(new NextRequest(`http://localhost/api/download/${encodeURIComponent(id)}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  }), { params: Promise.resolve({ id }) });
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['山河-佚名.txt', '山河.txt'])('locates anonymous authors by the exact canonical or legacy name %s', async (name) => {
    sql.mockResolvedValue([{ ...task, title: '山河', author: '' }]);
    fetchMock.mockResolvedValueOnce(Response.json([{ name }, { name: '山河-另一作者.txt' }])).mockResolvedValueOnce(new Response('正确正文'));
    const response = await download();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('正确正文');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain(encodeURIComponent(name));
  });

  it('keeps UTF-16 boundary filenames safe in both the upstream URL and download header', async () => {
    sql.mockResolvedValue([{ ...task, title: '甲'.repeat(79) + '😀', author: '作者' }]);
    const name = '甲'.repeat(79) + '.txt';
    fetchMock.mockResolvedValueOnce(Response.json([{ name }])).mockResolvedValueOnce(new Response('正文'));
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain(encodeURIComponent(name));
    expect(await response.text()).toBe('正文');
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

  it.each([
    { status: 404, expected: 404, error: 'file not found', code: 'FILE_NOT_FOUND' },
    { status: 204, expected: 502, error: '文件服务返回了空响应，请稍后重试', code: 'UPSTREAM_ERROR' },
  ])('does not create an attachment for upstream HTTP $status without a body', async ({ status, expected, error, code }) => {
    mockFile(new Response(null, { status }));

    const res = await download();

    expect(res.status).toBe(expected);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(await res.json()).toEqual({ error, code });
  });

  it.each(['directory', 'file'])('applies the shared 55-second budget to a stalled %s request', async (stage) => {
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

    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(55_000);
    if (stage === 'file') {
      expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
    }
    expect(abort.signal.aborted).toBe(true);
    expect(res.status).toBe(504);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: '文件服务响应超时，请稍后重试', code: 'UPSTREAM_TIMEOUT' });
    expect(log).toHaveBeenCalledWith(error);
  });

  it.each(['0', '-1', '1.5', 'Infinity', '1e2', '2147483648', '9007199254740992'])('rejects ID %s before data access', async (id) => {
    const res = await download('file-test-owner', id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid id', code: 'INVALID_ID' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the largest serial ID without rounding', async () => {
    mockFile(new Response('正文'));
    expect((await download('file-test-owner', '2147483647')).status).toBe(200);
    expect(sql.mock.calls[0].slice(1)).toEqual([2147483647]);
  });

  it('reports missing upstream configuration before data access', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const res = await download();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'GITHUB_TOKEN is not configured', code: 'FILE_SERVICE_NOT_CONFIGURED' });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['initialization', 'query'])('does not turn a database %s failure into file-not-found', async (stage) => {
    if (stage === 'initialization') ensureSchema.mockRejectedValue(new Error('private database details'));
    else sql.mockRejectedValue(new Error('private database details'));
    const res = await download();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'db error', code: 'DB_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('distinguishes absent and unfinished tasks before requesting files', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...task, status: 'running' }]);
    const missing = await download();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'task not found', code: 'TASK_NOT_FOUND' });
    const running = await download();
    expect(running.status).toBe(400);
    expect(await running.json()).toEqual({ error: '任务尚未完成', code: 'TASK_NOT_READY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['404', 'empty', 'no match'])('reports a genuinely absent directory entry (%s) as 404', async (kind) => {
    fetchMock.mockResolvedValueOnce(kind === '404'
      ? new Response(null, { status: 404 })
      : Response.json(kind === 'empty' ? [] : [{ name: 'other.txt' }]));
    const res = await download();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'file not found', code: 'FILE_NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['directory', 'file'].flatMap((stage) => [429, 500, 502, 503, 401, 403].map((status) => ({ stage, status }))))('keeps $stage HTTP $status distinct from 404', async ({ stage, status }) => {
    if (stage === 'file') fetchMock.mockResolvedValueOnce(Response.json([{ name: bookName }]));
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
    const res = await download();
    expect(res.status).toBe(status === 429 ? 503 : 502);
    expect(await res.json()).toEqual(status === 429
      ? { error: '文件服务请求受限，请稍后重试', code: 'UPSTREAM_RATE_LIMITED' }
      : { error: '文件服务暂不可用，请稍后重试', code: 'UPSTREAM_ERROR' });
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('recognizes GitHub rate-limit responses carried by HTTP 403', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    const res = await download();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: '文件服务请求受限，请稍后重试', code: 'UPSTREAM_RATE_LIMITED' });
  });

  it.each(['object', 'bad JSON'])('does not treat an invalid directory (%s) as an empty one', async (kind) => {
    fetchMock.mockResolvedValueOnce(kind === 'object' ? Response.json({ message: 'unexpected' }) : new Response('{broken'));
    const res = await download();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'UPSTREAM_ERROR', error: expect.any(String) });
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it.each(['directory', 'file'])('reports a %s connection failure as 502', async (stage) => {
    if (stage === 'file') fetchMock.mockResolvedValueOnce(Response.json([{ name: bookName }]));
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await download();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: '文件服务暂不可用，请稍后重试', code: 'UPSTREAM_ERROR' });
  });

  it('keeps the same deadline active after raw response headers have arrived', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    fetchMock.mockResolvedValueOnce(Response.json([{ name: bookName }]));
    fetchMock.mockImplementationOnce(async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('首章'));
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
      },
    })));
    const res = await download();
    const reader = res.body!.getReader();
    expect((await reader.read()).value).toEqual(new TextEncoder().encode('首章'));
    const timeout = new DOMException('deadline', 'TimeoutError');
    deadline.abort(timeout);
    await expect(reader.read()).rejects.toBe(timeout);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
  });

  it('propagates request cancellation during lookup separately from a timeout', async () => {
    const client = new AbortController();
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      queueMicrotask(() => client.abort());
    }));
    const res = await download('file-test-owner', '42', client.signal);
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: '请求已取消', code: 'REQUEST_ABORTED' });
  });
});
