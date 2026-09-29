import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { gitBlobSha } from './artifact-bytes';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('@/lib/db', () => ({ getSql: () => mocks.sql }));
vi.mock('@/lib/auth', () => ({ requirePermission: async () => ({ ok: true, principal: { userId: 1 } }) }));
vi.mock('@/lib/auth-http', () => ({ withAuthHeaders: (response: Response) => response }));
vi.mock('@/lib/db-quota-guard', () => ({ withDbQuotaGuard: (handler: unknown) => handler }));

const bytes = Buffer.from('第一章\n\n合成正文。\n');
const version = gitBlobSha(bytes);
let route: typeof import('@/app/api/read/[id]/[resource]/route');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function read(id: number, signal?: AbortSignal, resource = 'index') {
  return route.GET(new NextRequest(`https://synthetic.invalid/api/read/${id}/${resource}?chapter=0&version=${version}`, { signal }), {
    params: Promise.resolve({ id: String(id), resource }),
  });
}

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-only');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.sql.mockImplementation(async (parts: TemplateStringsArray, id: number) => {
    if (parts.join('?').includes('FROM download_tasks')) return [{ id, title: '合成书', author: '作者', status: 'done', artifact_id: id }];
    return [{ owner: 'synthetic', repo: 'books', branch: 'main', canonical_path: `books/book${id}.txt`, blob_sha: version, bytes: bytes.length }];
  });
  route = await import('@/app/api/read/[id]/[resource]/route');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('书库共享读取的调用者取消', () => {
  it('同书index取消不打断仍等待的chapter，共享一个fetch并保留正常缓存', async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const client = new AbortController();
    const first = read(1, client.signal);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const second = read(1, undefined, 'chapter');
    await tick();
    client.abort();
    expect((await first).status).toBe(499);
    expect(mocks.fetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
    finish(new Response(bytes));
    expect((await second).status).toBe(200);
    expect((await read(1)).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('两本书最后调用者取消使上游abort，实际结束后第三本立即可读', async () => {
    mocks.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const clients = [new AbortController(), new AbortController()];
    const pending = clients.map((client, i) => read(i + 1, client.signal));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    clients.forEach(client => client.abort());
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([499, 499]);
    expect(mocks.fetch.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
    await tick();
    mocks.fetch.mockResolvedValue(new Response(bytes));
    expect((await read(3)).status).toBe(200);
  });

  it('忽略abort的上游未结束前不提前释放名额，迟到成功不污染缓存', async () => {
    const finish: ((response: Response) => void)[] = [];
    mocks.fetch.mockImplementation(() => new Promise(resolve => { finish.push(resolve); }));
    const clients = [new AbortController(), new AbortController()];
    const pending = clients.map((client, i) => read(i + 1, client.signal));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    clients.forEach(client => client.abort());
    await Promise.all(pending);
    expect((await read(3)).status).toBe(503);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    finish.forEach(resolve => resolve(new Response(bytes)));
    await tick();
    mocks.fetch.mockImplementation(async () => new Response(bytes));
    expect((await read(1)).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('正文流最后等待者取消会调用reader.cancel，取消未完成前保留名额', async () => {
    const released: (() => void)[] = [];
    const cancel = vi.fn(() => new Promise<void>(resolve => { released.push(resolve); }));
    mocks.fetch.mockImplementation(async () => new Response(new ReadableStream({ pull() {}, cancel })));
    const clients = [new AbortController(), new AbortController()];
    const pending = clients.map((client, i) => read(i + 1, client.signal));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    await tick();
    clients.forEach(client => client.abort());
    await Promise.all(pending);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect((await read(3)).status).toBe(503);
    released.forEach(resolve => resolve());
    await tick();
    mocks.fetch.mockImplementation(async () => new Response(bytes));
    expect((await read(3)).status).toBe(200);
  });

  it('已取消的请求不读库或发上游请求', async () => {
    const client = new AbortController(); client.abort();
    expect((await read(1, client.signal)).status).toBe(499);
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
