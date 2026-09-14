import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Query = { text: string; values: unknown[] };

const { ensureSchema, getSql, sql, execute, transaction } = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
    // Neon 的标签模板返回惰性查询；只有独立 await 才会绕过 transaction 执行。
    return {
      ...query,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected: (error: unknown) => unknown) {
        return execute(query).then(onFulfilled, onRejected);
      },
    };
  });
  return {
    ensureSchema: vi.fn(),
    getSql: vi.fn(),
    sql,
    execute,
    transaction: vi.fn<(queries: Query[]) => Promise<unknown[][]>>(),
  };
});

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

import { refreshShuyuan } from './shuyuan';
import { POST } from '@/app/api/shuyuan/route';

const indexUrl = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const collectionUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
const source = {
  bookSourceUrl: 'https://sources.example/0/',
  bookSourceName: '书源\u0000\ud800',
  bookSourceGroup: '分组',
  ruleSearch: { name: '书\u0000名', author: ['\udc00', '作者🚀'] },
};
const responses = new Map<string, { body: string; status?: number }>();
const fetchMock = vi.fn<typeof fetch>();

function setCollection(id: number, value: unknown) {
  responses.set(collectionUrl(id), { body: JSON.stringify(value) });
}

describe('refreshShuyuan atomic refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockReset().mockResolvedValue([]);
    transaction.mockReset().mockResolvedValue([]);
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(Object.assign(sql, { transaction }));
    vi.stubEnv('APP_OWNER_TOKEN', 'shuyuan-test-owner');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    responses.clear();
    responses.set(indexUrl, {
      body: [11, 12, 13].map((id) => `<a href="/yuedu/shuyuans/content/id/${id}.html">合集 ${id}</a>`).join(''),
    });
    setCollection(11, [source]);
    setCollection(12, []);
    setCollection(13, []);
    fetchMock.mockReset().mockImplementation(async (input) => {
      const fixture = responses.get(String(input));
      if (!fixture) throw new Error(`Unexpected network request: ${String(input)}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['invalid jsonb input', 'database unavailable'])(
    'propagates %s without independently deleting, inserting or updating metadata',
    async (message) => {
      const error = new Error(message);
      transaction.mockRejectedValueOnce(error);

      await expect(refreshShuyuan()).rejects.toBe(error);

      expect(transaction).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0].text).toMatch(/^SELECT .* FROM shuyuan_sources WHERE disabled_at IS NOT NULL$/);
    },
  );

  it('replaces all chunks and metadata in one transaction after deduplicating and cleaning input', async () => {
    const sources = Array.from({ length: 101 }, (_, index) => ({
      ...source, bookSourceUrl: `https://sources.example/${index}/`,
    }));
    setCollection(11, sources);
    setCollection(12, [{ ...source, bookSourceUrl: ' https://sources.example/0 ', bookSourceName: '旧版' }]);
    const collections = [
      { id: 11, title: '合集 11', count: 101 },
      { id: 12, title: '合集 12', count: 1 },
      { id: 13, title: '合集 13', count: 0 },
    ];
    const refreshedAt = '2026-09-14T01:00:00Z';
    execute.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ collections, refreshed_at: refreshedAt }])
      .mockResolvedValueOnce([{ total: 101, active: 101 }]);

    await expect(refreshShuyuan()).resolves.toEqual({
      total: 101, active: 101, disabled: 0, collections, refreshedAt,
    });

    expect(transaction).toHaveBeenCalledOnce();
    const queries = transaction.mock.calls[0][0];
    expect(queries).toHaveLength(4);
    expect(queries[0].text).toBe('DELETE FROM shuyuan_sources');
    const inserts = queries.slice(1, -1);
    expect(inserts.every((query) => query.text.startsWith('INSERT INTO shuyuan_sources '))).toBe(true);
    const chunks = inserts.map((query) => JSON.parse(query.values[0] as string) as unknown[]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 1]);
    expect(chunks[0][0]).toMatchObject({
      url: 'https://sources.example/0',
      name: '书源�',
      grp: '分组',
      source: { ruleSearch: { name: '书名', author: ['�', '作者🚀'] } },
    });
    const meta = queries[queries.length - 1];
    expect(meta.text).toMatch(/^UPDATE shuyuan_meta SET collections = \?::jsonb, refreshed_at = now\(\) WHERE id = 1$/);
    expect(JSON.parse(meta.values[0] as string)).toEqual(collections);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
  });

  it.each([
    { name: 'HTTP failure', body: 'unavailable', status: 503 },
    { name: 'malformed JSON', body: '{', status: 200 },
    { name: 'non-array JSON', body: '{}', status: 200 },
  ])('aborts before database access when a collection has $name', async ({ body, status }) => {
    responses.set(collectionUrl(12), { body, status });

    await expect(refreshShuyuan()).rejects.toThrow('仅拉到 2/3 个书源合集，本次刷新中止，保留既有数据');

    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not replace existing sources with an empty collection result', async () => {
    setCollection(11, []);

    await expect(refreshShuyuan()).rejects.toThrow('所有书源合集下载失败');

    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns the transaction error to the refresh API instead of announcing success', async () => {
    transaction.mockRejectedValueOnce(new Error('书源事务写入失败'));
    const req = new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST',
      headers: { Authorization: 'Bearer shuyuan-test-owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: '书源事务写入失败' });
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
