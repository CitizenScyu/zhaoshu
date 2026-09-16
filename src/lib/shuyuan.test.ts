import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Query = { text: string; values: unknown[] };
type TransactionOptions = { readOnly?: boolean; fetchOptions?: { signal: AbortSignal } };

const { ensureSchema, getSql, sql, execute, transaction, readTransaction } = vi.hoisted(() => {
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
    transaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
    readTransaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
  };
});

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

import {
  disableShuyuanSource, getShuyuanCounts, getShuyuanStats, getReadingSources, refreshShuyuan,
  REFRESH_BUDGET_MS, RESPONSE_TIMEOUT_MS,
} from './shuyuan';
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
const zeroCounts = { total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 };

function setCollection(id: number, value: unknown) {
  responses.set(collectionUrl(id), { body: JSON.stringify(value) });
}

const unknownSource = { bookSourceUrl: 'https://unknown.invalid', bookSourceName: '未知源', ruleSearch: { name: 'h1' } };
const knownSource = { ...unknownSource, bookSourceUrl: 'https://book15.net', bookSourceName: '支持的来源' };
const oldDisabledAt = '2026-09-14T00:00:00Z';
function oldSource(item: typeof unknownSource) {
  return { source_url: item.bookSourceUrl, source: item, last_error: '历史连接超时', disabled_at: oldDisabledAt };
}
function seedPrevious(rows: unknown[], entries: unknown[] = []) {
  execute.mockResolvedValueOnce(rows).mockResolvedValueOnce([{
    collections: [{ id: 10, title: '旧合集', count: rows.length, probeSnapshot: { version: 1, entries } }],
    refreshed_at: '2026-09-14T00:00:00Z',
  }]);
}
function savedRows() {
  return transaction.mock.calls[0][0].filter((query) => query.text.startsWith('INSERT INTO shuyuan_sources'))
    .flatMap((query) => JSON.parse(query.values[0] as string) as {
      url: string; disabled_at: string | null; err: string; source: unknown;
    }[]);
}
function savedStates() {
  const meta = transaction.mock.calls[0][0].at(-1)!;
  const collections = JSON.parse(meta.values[0] as string) as {
    probeSnapshot?: { entries: { url: string; status: string; checked_at: string | null; error: string | null }[] };
  }[];
  return collections[0].probeSnapshot!.entries;
}

describe('refreshShuyuan atomic refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockReset().mockImplementation(async (query) => query.text.startsWith('SELECT count(*)') ? [zeroCounts] : []);
    transaction.mockReset().mockResolvedValue([]);
    readTransaction.mockReset().mockImplementation(async (queries, options) => {
      expect(options?.fetchOptions?.signal).toBeInstanceOf(AbortSignal);
      return Promise.all(queries.map((query) => execute(query)));
    });
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(Object.assign(sql, { transaction: (queries: Query[], options?: TransactionOptions) =>
      options?.readOnly ? readTransaction(queries, options) : transaction(queries, options),
    }));
    vi.stubEnv('APP_OWNER_TOKEN', 'shuyuan-test-owner');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    responses.clear();
    responses.set(indexUrl, {
      body: [11, 12, 13].map((id) => `<a href="/yuedu/shuyuans/content/id/${id}.html">合集 ${id}</a>`).join(''),
    });
    setCollection(11, [source]);
    setCollection(12, []);
    setCollection(13, []);
    fetchMock.mockReset().mockImplementation(async (input, options) => {
      expect(options?.redirect).toBe('error');
      const fixture = responses.get(String(input));
      if (!fixture) throw new Error(`Unexpected network request: ${String(input)}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0][0].text).toMatch(/^SELECT .* FROM shuyuan_sources$/);
      expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
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
      .mockResolvedValueOnce([{ collections: [], refreshed_at: null }])
      .mockResolvedValueOnce([{ collections, refreshed_at: refreshedAt }])
      .mockResolvedValueOnce([{ ...zeroCounts, total: 101, enabled: 101, unprobed: 101 }])
      .mockResolvedValueOnce([]);

    await expect(refreshShuyuan()).resolves.toEqual({
      ...zeroCounts, total: 101, enabled: 101, unprobed: 101, collections, refreshedAt,
      sources: [], sourcesLimit: 100,
    });

    expect(transaction).toHaveBeenCalledOnce();
    const queries = transaction.mock.calls[0][0];
    expect(queries).toHaveLength(8);
    expect(queries[0].text).toBe("SET LOCAL lock_timeout = '5s'");
    expect(queries[1].text).toBe("SET LOCAL statement_timeout = '10s'");
    expect(queries[2].text).toBe('LOCK TABLE shuyuan_sources IN SHARE ROW EXCLUSIVE MODE');
    expect(queries[3].text).toContain('AS snapshot_matches');
    expect(queries[4].text).toBe('DELETE FROM shuyuan_sources');
    const inserts = queries.slice(5, -1);
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
    expect(JSON.parse(meta.values[0] as string)).toEqual(collections.map((collection, i) =>
      i === 0 ? { ...collection, probeSnapshot: { version: 1, entries: [] } } : collection));
    expect(execute).toHaveBeenCalledTimes(5);
    expect(transaction.mock.calls[0][1]?.fetchOptions?.signal).toBeInstanceOf(AbortSignal);
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
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('曾失效的未知源只保存资料，保留原禁用时间和失败原因，零复探', async () => {
    setCollection(11, [unknownSource]);
    const old = oldSource(unknownSource);
    const original = structuredClone(old);
    seedPrevious([old]);
    await refreshShuyuan();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      indexUrl, collectionUrl(11), collectionUrl(12), collectionUrl(13),
    ]);
    expect(savedRows()).toEqual([expect.objectContaining({
      url: unknownSource.bookSourceUrl, source: unknownSource, disabled_at: oldDisabledAt, err: '历史连接超时',
    })]);
    expect(savedStates()).toEqual([]);
    expect(old).toEqual(original);
  });

  it.each([unknownSource, knownSource])('规则变化只标待核验，保留 $bookSourceName 的失效证据', async (item) => {
    const changed = { ...item, ruleSearch: { name: '.new-title' } };
    setCollection(11, [changed]);
    seedPrevious([oldSource(item)]);
    await refreshShuyuan();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(savedStates()).toEqual([{ url: item.bookSourceUrl, status: 'pending', checked_at: null, error: null }]);
    expect(savedRows()[0]).toMatchObject({ source: changed, err: '历史连接超时', disabled_at: oldDisabledAt });
  });

  it('jsonb 对象键重排不被当作规则变化', async () => {
    setCollection(11, [unknownSource]);
    seedPrevious([oldSource({
      ruleSearch: { name: 'h1' }, bookSourceName: unknownSource.bookSourceName, bookSourceUrl: unknownSource.bookSourceUrl,
    })]);
    await refreshShuyuan();
    expect(savedStates()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('待核验状态跨刷新保留，不凭相同规则或 HTTP 探测解除', async () => {
    setCollection(11, [knownSource]);
    seedPrevious([oldSource(knownSource)], [
      { url: knownSource.bookSourceUrl, status: 'pending', checked_at: null, error: null },
    ]);
    await refreshShuyuan();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(savedStates()[0].status).toBe('pending');
  });

  it('支持来源实际读完成功响应后才记可达，用户禁用和旧失败原因保持独立', async () => {
    setCollection(11, [knownSource]);
    seedPrevious([oldSource(knownSource)]);
    responses.set('https://book15.net/', { body: '离线合成响应' });
    await refreshShuyuan();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('https://book15.net/');
    expect(savedStates()).toEqual([expect.objectContaining({
      url: knownSource.bookSourceUrl, status: 'reachable', checked_at: expect.any(String), error: null,
    })]);
    expect(savedRows()[0]).toMatchObject({ disabled_at: oldDisabledAt, err: '历史连接超时' });
  });

  it('不信任未知来源的旧健康标记或上游自报探测状态', async () => {
    setCollection(11, [{
      ...unknownSource, probeSnapshot: { version: 1, status: 'reachable' },
    }]);
    seedPrevious([], [{ url: unknownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-14T00:00:00Z' }]);
    await refreshShuyuan();
    expect(savedStates()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('快照守卫冲突受控失败，所有写语句仍在同一事务内', async () => {
    setCollection(11, [unknownSource]);
    seedPrevious([oldSource(unknownSource)]);
    transaction.mockRejectedValueOnce(Object.assign(new Error('division by zero'), { code: '22012' }));
    await expect(refreshShuyuan()).rejects.toThrow('书源在刷新期间发生变化');
    const guard = transaction.mock.calls[0][0][3];
    expect(guard.text).toContain('current.disabled_at IS DISTINCT FROM old.disabled_at');
    expect(guard.text).toContain('current.last_error IS DISTINCT FROM old.last_error');
    expect(JSON.parse(guard.values[1] as string)).toEqual([{
      url: unknownSource.bookSourceUrl, disabled_at: oldDisabledAt, last_error: '历史连接超时',
    }]);
    expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
  });

  it('固定入口的未知跳转不跟随，响应体释放且原数据不写入', async () => {
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { location: 'https://unknown.invalid/collection' },
    }));
    await expect(refreshShuyuan()).rejects.toThrow('302');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
    expect(cancelled).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('合集 body 挂起会超时并取消，不能替换为剩余合集子集', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const ordinary = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input) === collectionUrl(12)
      ? Promise.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })))
      : ordinary(input, init));
    const failure = expect(refreshShuyuan()).rejects.toThrow('仅拉到 2/3');
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS + 1);
    await failure;
    expect(cancelled).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('允许来源 body 未读完不能记为恢复，原失败证据仍保留', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    setCollection(11, [knownSource]);
    seedPrevious([oldSource(knownSource)]);
    const ordinary = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input) === 'https://book15.net/'
      ? Promise.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })))
      : ordinary(input, init));
    const pending = refreshShuyuan();
    await vi.advanceTimersByTimeAsync(8_001);
    await pending;
    expect(cancelled).toBe(true);
    expect(savedStates()[0]).toMatchObject({ status: 'failed', checked_at: expect.any(String) });
    expect(savedRows()[0].err).toBe('历史连接超时');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('请求取消停止 body 读取，不落集合或状态写入', async () => {
    const controller = new AbortController();
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const failure = expect(refreshShuyuan(controller.signal)).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('测试取消'));
    await failure;
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('总预算耗尽时不等待挂起的只读 SQL，也不启动探测或写入', async () => {
    vi.useFakeTimers();
    readTransaction.mockImplementationOnce(() => new Promise(() => {}));
    const failure = expect(refreshShuyuan()).rejects.toThrow('请求预算');
    await vi.advanceTimersByTimeAsync(REFRESH_BUDGET_MS + 1);
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(transaction).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('剩余预算不足以探测时保留未探测状态和失效信息', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    setCollection(11, [knownSource]);
    seedPrevious([oldSource(knownSource)]);
    readTransaction.mockImplementation(async (queries) => {
      const result = await Promise.all(queries.map((query) => execute(query)));
      if (queries[0].text.includes('FROM shuyuan_meta') && transaction.mock.calls.length === 0) {
        vi.setSystemTime(started + REFRESH_BUDGET_MS - 10_000);
      }
      return result;
    });
    await refreshShuyuan();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(savedStates()).toEqual([]);
    expect(savedRows()[0]).toMatchObject({ disabled_at: oldDisabledAt, err: '历史连接超时' });
  });

  it('即使定时器尚未触发，实际耗尽预算也不会提交替换', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    readTransaction.mockImplementation(async (queries) => {
      const result = await Promise.all(queries.map((query) => execute(query)));
      if (queries[0].text.includes('FROM shuyuan_meta')) vi.setSystemTime(started + REFRESH_BUDGET_MS + 1);
      return result;
    });
    await expect(refreshShuyuan()).rejects.toThrow('请求预算');
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('统计拒绝未知来源健康声明，未禁用数量不能替代探测可达数量', async () => {
    execute.mockResolvedValueOnce([{ collections: [{
      id: 11, title: '合集', count: 3, probeSnapshot: { version: 1, entries: [
        { url: unknownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-14T00:00:00Z' },
        { url: knownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-14T00:00:00Z' },
        { url: 'https://pending.invalid', status: 'pending', checked_at: null },
      ] },
    }], refreshed_at: null }]).mockResolvedValueOnce([{
      ...zeroCounts, total: 3, enabled: 3, active: 1, reachable: 1, unprobed: 1, pending: 1,
    }]);
    expect(await getShuyuanCounts()).toMatchObject({ total: 3, enabled: 3, active: 1, unprobed: 1 });
    const query = execute.mock.calls[1][0];
    expect(query.text).toContain("disabled_at IS NULL AND p.status = 'reachable'");
    expect(JSON.parse(query.values[0] as string).map((entry: { url: string }) => entry.url))
      .toEqual([knownSource.bookSourceUrl, 'https://pending.invalid']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('旧元数据默认为未探测，API 明细同时表达失败信息与独立禁用状态', async () => {
    const collections = [{ id: 11, title: '旧格式', count: 1 }];
    execute.mockResolvedValueOnce([{ collections, refreshed_at: null }])
      .mockResolvedValueOnce([{ ...zeroCounts, total: 1, disabled: 1, unprobed: 1 }])
      .mockResolvedValueOnce([{
        url: unknownSource.bookSourceUrl, name: '未知源', disabled: true, availability: 'unprobed',
        last_error: '历史连接超时', checked_at: null, probe_error: null,
      }]);
    expect(await getShuyuanStats()).toEqual({
      ...zeroCounts, total: 1, disabled: 1, unprobed: 1, collections, refreshedAt: null, sourcesLimit: 100,
      sources: [{ url: unknownSource.bookSourceUrl, name: '未知源', disabled: true, availability: 'unprobed',
        lastError: '历史连接超时', checkedAt: null, probeError: null }],
    });
    expect(execute.mock.calls[2][0].text).toContain('LIMIT ?');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('禁用未知来源只更新禁用标记，空原因不抹掉已有失败信息', async () => {
    execute.mockResolvedValueOnce([{ id: 1 }]);
    expect(await disableShuyuanSource(unknownSource.bookSourceUrl + '/', '')).toBe(true);
    const query = execute.mock.calls[0][0];
    expect(query.text).toContain("last_error = COALESCE(NULLIF(?, ''), last_error)");
    expect(query.values).toEqual(['', unknownSource.bookSourceUrl]);
    expect(query.text).not.toContain('probeSnapshot');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('在线阅读只选择支持且启用的来源，失败或禁用记录不能被内置源绕过', async () => {
    execute.mockResolvedValueOnce([{ collections: [{ id: 1, title: '合集', count: 2,
      probeSnapshot: { version: 1, entries: [{ url: knownSource.bookSourceUrl, status: 'failed', checked_at: '2026-09-16T00:00:00Z' }] },
    }] }]).mockResolvedValueOnce([{ ...oldSource(knownSource), disabled_at: null, name: '失败源' }]);
    expect(await getReadingSources(new AbortController().signal)).toEqual([]);
    execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([{ ...oldSource(knownSource), name: '禁用源' }]);
    expect(await getReadingSources(new AbortController().signal)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('在线阅读按需核验未探测来源，不篡改它的健康状态', async () => {
    execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([
      { ...oldSource(unknownSource), disabled_at: null, name: '未知域名' },
      { ...oldSource(knownSource), disabled_at: null, name: '支持的来源' },
    ]);
    expect(await getReadingSources(new AbortController().signal)).toMatchObject([{ url: 'https://book15.net/', name: '支持的来源' }]);
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('合集没有已支持域名时复用 worker 的内置 book15 适配器', async () => {
    execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]);
    expect(await getReadingSources(new AbortController().signal)).toMatchObject([
      { url: 'https://book15.net/', searchUrl: 'https://book15.net/books/search.html?kw={{key}}' },
    ]);
  });
});
