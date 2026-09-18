import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureSchema, getSql, sql, fetchMock } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn(),
  fetchMock: vi.fn<typeof fetch>(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

let GET: typeof import('./route').GET;

const task = { id: 42, title: '长篇/小说', author: '测试作者', status: 'done', user_id: 1 };
const firstChapter = '第一章 初见\n仅属于第一章的正文。\n\n';
const secondChapter = '第二章 远行\n仅属于第二章的正文。\n';
const bookText = firstChapter + secondChapter;
const bytes = Buffer.from(bookText);
const version = createHash('sha1').update('blob ' + bytes.byteLength + '\0').update(bytes).digest('hex');
const file = { type: 'file', name: '长篇小说-测试作者.txt', sha: version, size: bytes.byteLength };

function request(options: {
  id?: string;
  resource?: string;
  query?: string;
  token?: string | null;
  header?: 'Authorization' | 'X-Owner-Token';
} = {}) {
  const { id = '42', resource = 'index', query = '', token = 'reader-test-owner', header = 'Authorization' } = options;
  return GET(new NextRequest('http://localhost/api/read/' + encodeURIComponent(id) + '/' + resource + '?' + query, {
    headers: token === null ? {} : { [header]: header === 'Authorization' ? 'Bearer ' + token : token },
  }), { params: Promise.resolve({ id, resource }) });
}

function mockBook(response = new Response(bookText)) {
  fetchMock.mockResolvedValueOnce(Response.json([file])).mockResolvedValueOnce(response);
}

function expectPrivate(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

describe('GET /api/read/[id]/[resource]', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'reader-test-owner');
    vi.stubEnv('GITHUB_TOKEN', 'reader-test-github');
    vi.stubEnv('ZHAOSHU_BOOKS_REPO', 'test-owner/test-books');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() => { throw new Error('Unexpected network request'); });
    getSql.mockReturnValue(sql);
    sql.mockResolvedValue([task]);
    GET = (await import('./route')).GET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([null, 'wrong-owner'])('rejects %s credentials before database or GitHub access', async (token) => {
    const response = await request({ token, id: 'invalid' });
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(getSql).not.toHaveBeenCalled();
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an uncached 503 without data access when owner authentication is not configured', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const response = await request();
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(getSql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.2', '1e2', '01', '2147483648', '9007199254740992', '../42'])(
    'rejects invalid task id %j without data access', async (id) => {
      const response = await request({ id });
      expect(response.status).toBe(400);
      expectPrivate(response);
      expect(getSql).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown resources without data access', async () => {
    const response = await request({ resource: 'raw' });
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(getSql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'chapter=-1&version=' + version,
    'chapter=01&version=' + version,
    'chapter=0&part=1.2&version=' + version,
    'chapter=0&part=9007199254740992&version=' + version,
    'chapter=0&version=latest',
    'chapter=0&version=' + version.toUpperCase(),
  ])('rejects malformed chapter parameters %j before data access', async (query) => {
    const response = await request({ resource: 'chapter', query });
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(getSql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns only an index, then a requested chapter slice, using private authenticated raw requests', async () => {
    mockBook();
    const indexResponse = await request({ header: 'X-Owner-Token' });
    expect(indexResponse.status).toBe(200);
    expectPrivate(indexResponse);
    const index = await indexResponse.json();
    expect(index).toMatchObject({ taskId: 42, title: task.title, author: task.author, version, totalBytes: bytes.byteLength });
    expect(index.chapters).toHaveLength(2);
    expect(index.chapters[1]).toMatchObject({ index: 1, startByte: Buffer.byteLength(firstChapter), endByte: bytes.byteLength, partCount: 1 });
    expect(JSON.stringify(index)).not.toContain('仅属于');

    const partResponse = await request({ resource: 'chapter', query: 'chapter=1&version=' + version });
    expect(partResponse.status).toBe(200);
    expectPrivate(partResponse);
    expect(await partResponse.json()).toMatchObject({
      taskId: 42, version, chapterIndex: 1, partIndex: 0, partCount: 1,
      startByte: Buffer.byteLength(firstChapter), endByte: bytes.byteLength, text: secondChapter,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/test-owner/test-books/contents/books/' + encodeURIComponent(file.name),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer reader-test-github', Accept: 'application/vnd.github.raw+json' }),
        cache: 'no-store', signal: expect.any(AbortSignal),
      }),
    );
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[0][0].join(' ')).toMatch(/SELECT id, title, author, status, user_id FROM download_tasks WHERE id =/);
    expect(sql.mock.calls[0][1]).toBe(42);
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('rechecks owner authentication and task status before using a warm book cache', async () => {
    mockBook();
    expect((await request()).status).toBe(200);
    vi.stubEnv('APP_OWNER_TOKEN', 'rotated-test-owner');
    expect((await request()).status).toBe(401);
    expect(sql).toHaveBeenCalledTimes(1);
    sql.mockResolvedValueOnce([{ ...task, status: 'running' }]);
    expect((await request({ token: 'rotated-test-owner' })).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('checks availability from metadata without downloading book text', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([file]));
    const response = await request({ resource: 'availability' });
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for a missing task before GitHub access', async () => {
    sql.mockResolvedValueOnce([]);
    const response = await request();
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running', 'failed', 'cancelled', 'partial'])('rejects a %s task before GitHub access', async (status) => {
    sql.mockResolvedValueOnce([{ ...task, status }]);
    const response = await request();
    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running', 'failed', 'partial'])("hides another user's %s task behind the same 404 as a missing task", async (status) => {
    sql.mockResolvedValueOnce([{ ...task, status, user_id: 2 }]);
    const response = await request();
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reads another user's completed TXT because finished files are shared", async () => {
    sql.mockResolvedValueOnce([{ ...task, user_id: 2 }]);
    mockBook();
    const response = await request();
    expect(response.status).toBe(200);
    expectPrivate(response);
  });

  it.each([['GITHUB_TOKEN', ''], ['ZHAOSHU_BOOKS_REPO', '../../invalid']])(
    'returns 503 for invalid %s configuration', async (name, value) => {
      vi.stubEnv(name, value);
      const response = await request();
      expect(response.status).toBe(503);
      expectPrivate(response);
      expect(response.headers.get('Retry-After')).toBe('5');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when neither an exact file nor a title fallback exists', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const response = await request();
    expect(response.status).toBe(404);
    expectPrivate(response);
  });

  it('rejects oversized metadata before downloading the TXT', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([{ ...file, size: 16 * 1024 * 1024 + 1 }]));
    const response = await request();
    expect(response.status).toBe(413);
    expectPrivate(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'invalid UTF-8', 'whitespace'])('returns 422 for %s text', async (kind) => {
    const response = kind === 'invalid UTF-8'
      ? new Response(new Uint8Array([0xff])) : new Response(kind === 'empty' ? '' : '\ufeff \n\r\t');
    mockBook(response);
    const result = await request();
    expect(result.status).toBe(422);
    expectPrivate(result);
  });

  it.each([[404, 404], [403, 503], [429, 503], [500, 502]])(
    'maps upstream HTTP %s to a private %s response', async (upstream, expected) => {
      fetchMock.mockResolvedValueOnce(new Response('upstream details', { status: upstream }));
      const response = await request();
      expect(response.status).toBe(expected);
      expectPrivate(response);
      expect(await response.text()).not.toContain('upstream details');
    },
  );

  it.each(['fetch', 'metadata body'])('returns 504 when the %s times out', async (stage) => {
    const error = new DOMException('simulated timeout', 'TimeoutError');
    if (stage === 'fetch') fetchMock.mockRejectedValueOnce(error);
    else {
      const upstream = Response.json([file]);
      vi.spyOn(upstream, 'json').mockRejectedValueOnce(error);
      fetchMock.mockResolvedValueOnce(upstream);
    }
    const response = await request();
    expect(response.status).toBe(504);
    expectPrivate(response);
  });

  it('returns 409 instead of mixing a chapter with an outdated index version', async () => {
    mockBook();
    const response = await request({ resource: 'chapter', query: 'chapter=0&version=' + '0'.repeat(40) });
    expect(response.status).toBe(409);
    expectPrivate(response);
  });

  it.each(['chapter=2', 'chapter=0&part=1'])('returns 400 for an out-of-range chapter or part: %s', async (query) => {
    mockBook();
    const response = await request({ resource: 'chapter', query: query + '&version=' + version });
    expect(response.status).toBe(400);
    expectPrivate(response);
  });

  it('redacts unexpected internal failures from both the response and server logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    sql.mockRejectedValueOnce(new Error('sensitive simulated connection details'));
    const response = await request();
    expect(response.status).toBe(500);
    expectPrivate(response);
    expect(await response.text()).not.toContain('sensitive');
    expect(log).toHaveBeenCalledExactlyOnceWith('Reader request failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
