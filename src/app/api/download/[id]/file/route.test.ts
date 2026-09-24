import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { stringifyVolumeManifest } from '@/lib/volume-manifest';
import type { VolumeManifest } from '@/lib/volume-manifest';

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

const ARTIFACT_ID = '7';

function gitBlobSha(value: Uint8Array | string): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return createHash('sha1').update(`blob ${buf.byteLength}\0`).update(buf).digest('hex');
}

/** 一份合法的 2 卷 v2 清单 + 其卷字节,以及 DB 里的 artifact 行。 */
function volumeFixture() {
  const vol1 = '【第1章】\n\n第一卷的正文内容。\n';
  const vol2 = '【第2章】\n\n第二卷的正文内容。\n';
  const book = vol1 + vol2;
  const v1Bytes = Buffer.from(vol1, 'utf8');
  const v2Bytes = Buffer.from(vol2, 'utf8');
  const dir = 'books/我的小说-作者';
  const manifest: VolumeManifest = {
    schema: 2, format: 'volumes',
    version: gitBlobSha(book).slice(0, 8), blob_sha: gitBlobSha(book),
    bytes: Buffer.byteLength(book), chars: 2, chapters: 2, chapters_total: 2,
    title: '我的小说', author: '作者', generated_at: '2026-09-23T00:00:00.000Z', task_id: 7,
    volumes: [
      { path: `${dir}/vol-001.txt`, snapshot_path: `books/.snapshots/x/v-${gitBlobSha(vol1).slice(0, 8)}.txt`,
        blob_sha: gitBlobSha(vol1), bytes: v1Bytes.byteLength, first_byte: 0, last_byte: v1Bytes.byteLength },
      { path: `${dir}/vol-002.txt`, snapshot_path: `books/.snapshots/x/v-${gitBlobSha(vol2).slice(0, 8)}.txt`,
        blob_sha: gitBlobSha(vol2), bytes: v2Bytes.byteLength, first_byte: v1Bytes.byteLength, last_byte: v1Bytes.byteLength + v2Bytes.byteLength },
    ],
    chapter_index: [
      { i: 0, t: '【第1章】', v: 0, s: 0, e: v1Bytes.byteLength, p: 1 },
      { i: 1, t: '【第2章】', v: 1, s: v1Bytes.byteLength, e: v1Bytes.byteLength + v2Bytes.byteLength, p: 1 },
    ],
  };
  const artifactRow = {
    owner: 'owner', repo: 'repo', branch: 'main',
    canonical_path: `${dir}/index.json`, blob_sha: gitBlobSha(book), bytes: Buffer.byteLength(book),
  };
  // 发布成功后的仓库现状:清单 + 规范卷 + 快照卷(下载端优先取快照卷,B2-01)。
  const snapshots = manifest.volumes.map((volume) => volume.snapshot_path.slice(volume.snapshot_path.lastIndexOf('/') + 1));
  const resources = new Map<string, () => Response>([
    ['index.json', () => new Response(stringifyVolumeManifest(manifest))],
    ['vol-001.txt', () => new Response(vol1)],
    ['vol-002.txt', () => new Response(vol2)],
    [snapshots[0], () => new Response(vol1)],
    [snapshots[1], () => new Response(vol2)],
  ]);
  return { manifest, artifactRow, book, vol1, resources, snapshots };
}

/** 以 URL 路径末段(百分号编码)为键的资源表;未命中作 404。 */
function resourceServer(resources: Map<string, () => Response>, hit: (name: string) => void): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    const pathname = new URL(url, 'https://api.github.com').pathname;
    const name = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    hit(name);
    const factory = resources.get(name);
    return factory ? factory() : new Response(null, { status: 404 });
  }) as typeof fetch;
}

function artifactTask() {
  return { ...task, title: '我的小说', author: '作者', artifact_id: ARTIFACT_ID };
}

/** 任务查询 → artifact 行,两步 SQL 都喂给 mock。 */
function sqlForArtifact(artifactRow: unknown) {
  sql.mockResolvedValueOnce([artifactTask()]).mockResolvedValueOnce([artifactRow]);
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
    fetchMock.mockResolvedValueOnce(Response.json([{ name }, { name: '山河-另一作者.txt' }]));
    if (name === '山河.txt') fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchMock.mockResolvedValueOnce(new Response('正确正文'));
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
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
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

  it('returns 404 for another user task before touching the file service', async () => {
    sql.mockResolvedValueOnce([]);
    const res = await download();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(sql.mock.calls[0].slice(1)).toEqual([42, 1]);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(sql.mock.calls[0].slice(1)).toEqual([2147483647, 1]);
  });

  it('reports missing upstream configuration only after checking task ownership', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const res = await download();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'file service is not configured', code: 'FILE_SERVICE_NOT_CONFIGURED' });
    expect(ensureSchema).toHaveBeenCalledOnce();
    expect(sql).toHaveBeenCalledOnce();
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
    // F03：partial（残缺）不是完成态，取文件同样 TASK_NOT_READY
    sql.mockResolvedValueOnce([{ ...task, status: 'partial' }]);
    const partial = await download();
    expect(partial.status).toBe(400);
    expect(await partial.json()).toEqual({ error: '任务尚未完成', code: 'TASK_NOT_READY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['404', 'empty', 'no match'])('reports a genuinely absent directory entry (%s) as 404', async (kind) => {
    fetchMock.mockResolvedValueOnce(kind === '404'
      ? new Response(null, { status: 404 })
      : Response.json(kind === 'empty' ? [] : [{ name: 'other.txt' }]));
    if (kind !== '404') fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const res = await download();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'file not found', code: 'FILE_NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(kind === '404' ? 1 : 2);
  });

  it('retrieves an exact file beyond the 1000-item limit without buffering the raw stream', async () => {
    const listing = Array.from({ length: 1000 }, (_, i) => ({ name: `其他${i}.txt` }));
    fetchMock.mockResolvedValueOnce(Response.json(listing))
      .mockResolvedValueOnce(Response.json({ name: bookName, type: 'file' }))
      .mockResolvedValueOnce(new Response('正确正文'));
    const response = await download();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('正确正文');
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('Accept')))
      .toEqual(['application/vnd.github+json', 'application/vnd.github.object+json', 'application/vnd.github.raw']);
    expect(new Set(fetchMock.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
  });

  it('does not return a wrong author that only looks unique in a truncated directory', async () => {
    const listing = [{ name: '长篇小说-另一作者.txt' }, ...Array.from({ length: 999 }, (_, i) => ({ name: `其他${i}.txt` }))];
    fetchMock.mockResolvedValueOnce(Response.json(listing)).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const response = await download();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain(encodeURIComponent(bookName));
  });

  it.each([
    { response: () => new Response(null, { status: 429 }), expected: 503, code: 'UPSTREAM_RATE_LIMITED' },
    { response: () => new Response('{bad'), expected: 502, code: 'UPSTREAM_ERROR' },
    { response: () => Response.json({ name: 'wrong.txt', type: 'file' }), expected: 502, code: 'UPSTREAM_ERROR' },
  ])('preserves $code from exact metadata lookup', async ({ response, expected, code }) => {
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(response());
    const result = await download();
    expect(result.status).toBe(expected);
    expect(await result.json()).toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a timeout while consuming exact metadata to 504', async () => {
    const metadata = Response.json({ type: 'file', name: bookName });
    vi.spyOn(metadata, 'json').mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(metadata);
    const response = await download();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
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

  describe('v2 分卷产物(清单 index.json)', () => {
    it('下载拼接后的整本正文,而不是清单 JSON', async () => {
      const fx = volumeFixture();
      const hits: string[] = [];
      sqlForArtifact(fx.artifactRow);
      fetchMock.mockImplementation(resourceServer(fx.resources, (name) => hits.push(name)));

      const res = await download();

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Content-Disposition')).toContain(encodeURIComponent('我的小说.txt'));
      const text = await res.text();
      expect(text).toBe(fx.book);
      expect(text).not.toContain('"schema"');
      expect(text).not.toContain('chapter_index');
      // 清单在前,卷按顺序各取一次(取内容寻址快照卷,不取规范卷)。
      expect(hits).toEqual(['index.json', ...fx.snapshots]);
    });

    it('逐卷流式下发:消费第一卷之前不拉取第二卷', async () => {
      const fx = volumeFixture();
      const hits: string[] = [];
      sqlForArtifact(fx.artifactRow);
      fetchMock.mockImplementation(resourceServer(fx.resources, (name) => hits.push(name)));

      const res = await download();
      // 响应已就绪但还没消费:第二卷绝不会被提前拉取(一次一卷的背压)。
      expect(hits).not.toContain(fx.snapshots[1]);
      const text = await res.text();
      expect(text).toBe(fx.book);
      expect(hits).toEqual(['index.json', ...fx.snapshots]);
    });

    it('卷字节 sha 与清单不符 → 下载中断,绝不下发半新半旧的书', async () => {
      const fx = volumeFixture();
      const resources = new Map(fx.resources);
      resources.set(fx.snapshots[0], () => new Response('被篡改的卷内容\n'));
      sqlForArtifact(fx.artifactRow);
      fetchMock.mockImplementation(resourceServer(resources, () => {}));

      const res = await download();

      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();
    });

    it('清单缺失 → 404 FILE_NOT_FOUND', async () => {
      const fx = volumeFixture();
      sqlForArtifact(fx.artifactRow);
      fetchMock.mockImplementation(resourceServer(new Map(), () => {}));

      const res = await download();

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('清单解析失败 → 502(与读端同一份 parseVolumeManifest 判据)', async () => {
      const fx = volumeFixture();
      const resources = new Map(fx.resources);
      resources.set('index.json', () => new Response('{not json'));
      sqlForArtifact(fx.artifactRow);
      fetchMock.mockImplementation(resourceServer(resources, () => {}));

      const res = await download();

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'UPSTREAM_ERROR' });
      expect(res.headers.get('Content-Disposition')).toBeNull();
    });

    it('非 index.json 的 artifact(旧单文件)行为不变:原样流式下发,不拼接', async () => {
      const raw = '旧版单文件正文\n';
      const artifactRow = {
        owner: 'owner', repo: 'repo', branch: 'main',
        canonical_path: 'books/旧书-作者.txt', blob_sha: gitBlobSha(raw), bytes: Buffer.byteLength(raw),
      };
      sql.mockResolvedValueOnce([{ ...task, artifact_id: '9' }]).mockResolvedValueOnce([artifactRow]);
      fetchMock.mockResolvedValueOnce(new Response(raw));

      const res = await download();

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(raw);
      // 只取这一个文件:没有清单、没有分卷。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain(encodeURIComponent('旧书-作者.txt'));
    });

    describe('跨版本发布窗口(B2-01):卷取内容寻址快照,不取跨版本共享的 vol-00N.txt', () => {
      /** 第 1 卷被新版覆盖后的字节(sha 与旧清单不符)。 */
      const NEW_VOL1 = '【第1章】\n\n第一卷修订后的正文。\n';
      /** 去掉快照卷:模拟快照缺失,只剩规范卷。 */
      function withoutSnapshots(fx: ReturnType<typeof volumeFixture>) {
        const resources = new Map(fx.resources);
        for (const name of fx.snapshots) resources.delete(name);
        return resources;
      }

      it('旧清单 + 已被新版覆盖的规范卷 → 仍下发旧版整本(不再 409 中断)', async () => {
        const fx = volumeFixture();
        const resources = new Map(fx.resources);
        resources.set('vol-001.txt', () => new Response(NEW_VOL1));
        const hits: string[] = [];
        sqlForArtifact(fx.artifactRow);
        fetchMock.mockImplementation(resourceServer(resources, (name) => hits.push(name)));

        const res = await download();

        expect(res.status).toBe(200);
        expect(await res.text()).toBe(fx.book);
        expect(hits).toEqual(['index.json', ...fx.snapshots]);
      });

      it('快照卷 404 → 回退规范卷(仍按清单 sha 校验)', async () => {
        const fx = volumeFixture();
        const hits: string[] = [];
        sqlForArtifact(fx.artifactRow);
        fetchMock.mockImplementation(resourceServer(withoutSnapshots(fx), (name) => hits.push(name)));

        const res = await download();

        expect(res.status).toBe(200);
        expect(await res.text()).toBe(fx.book);
        expect(hits).toEqual(['index.json', fx.snapshots[0], 'vol-001.txt', fx.snapshots[1], 'vol-002.txt']);
      });

      it('快照卷 404 且规范卷已是别的版本 → 下载中断(回退不放过 sha 校验)', async () => {
        const fx = volumeFixture();
        const resources = withoutSnapshots(fx);
        resources.set('vol-001.txt', () => new Response(NEW_VOL1));
        sqlForArtifact(fx.artifactRow);
        fetchMock.mockImplementation(resourceServer(resources, () => {}));

        const res = await download();

        expect(res.status).toBe(200);
        await expect(res.text()).rejects.toThrow();
      });

      it('快照卷非 404 上游错误 → 下载中断,不回退规范卷', async () => {
        const fx = volumeFixture();
        const resources = new Map(fx.resources);
        resources.set(fx.snapshots[0], () => new Response(null, { status: 500 }));
        const hits: string[] = [];
        sqlForArtifact(fx.artifactRow);
        fetchMock.mockImplementation(resourceServer(resources, (name) => hits.push(name)));

        const res = await download();

        await expect(res.text()).rejects.toThrow();
        expect(hits).not.toContain('vol-001.txt');
      });
    });
  });
});
