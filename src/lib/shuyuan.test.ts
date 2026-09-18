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
  disableShuyuanSource, enableShuyuanSource, getEngineSources, getReadingPool, getShuyuanCounts,
  getShuyuanPoolHealth, getShuyuanStats, getReadingSources, refreshShuyuan,
  REFRESH_BUDGET_MS, RESPONSE_TIMEOUT_MS,
} from './shuyuan';
import { sourceRevision } from './source-revision';
import { rulesHash } from './rule-engine/admission';
import { refreshSupportedHosts } from './source-policy';
import { SOURCE_PAGE_SIZE, pageCount } from './shuyuan-view';
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

    // 合集 JSON 都拉到了、只是没有任何源：同样不写库，但走降级返回而不是抛错。
    await expect(refreshShuyuan()).resolves.toMatchObject({ collections: [], refreshedAt: null });

    expect(transaction).not.toHaveBeenCalled();
    expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
  });

  it('上游合集整体不可达时降级：不抛错、不写库、返回库中既有统计并响亮告警', async () => {
    // 判别性构造：传输层对索引页之外的合集请求一律抛 undici 网络错误形态（ECONNRESET 那一类），
    // 三个合集全部拉不到 ⇒ merged.size === 0，正是生产 09-15 之后每轮 cron 走到的分支。
    fetchMock.mockImplementation(async (input, options) => {
      expect(options?.redirect).toBe('error');
      const url = String(input);
      if (url === indexUrl) return new Response(responses.get(indexUrl)!.body, { status: 200 });
      throw new TypeError('fetch failed');
    });
    const staleMeta = {
      collections: [{ id: 10, title: '旧合集', count: 1 }],
      refreshed_at: '2026-09-15T20:27:18Z',
    };
    execute.mockImplementation(async (query) => {
      if (query.text.includes('FROM shuyuan_meta')) return [staleMeta];
      if (query.text.startsWith('SELECT count(*)')) return [{ ...zeroCounts, total: 1, enabled: 1, unprobed: 1 }];
      return [];
    });

    const stats = await refreshShuyuan();

    // ②返回的是库里既有数据：refreshed_at 停留旧值，绝不被写成「刚刷新过」。
    expect(stats.refreshedAt).toBe(staleMeta.refreshed_at);
    expect(stats.collections).toEqual(staleMeta.collections);
    expect(stats.total).toBe(1);
    // ①不抛错（resolves）+ 未执行任何写库：没有事务，所有 SQL 都是 SELECT。
    expect(transaction).not.toHaveBeenCalled();
    expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
    // ③响亮告警带失败合集与原因归类。
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('shuyuan refresh degraded'),
      expect.objectContaining({
        collections: [11, 12, 13],
        failures: [
          { id: 11, reason: 'fetch failed' },
          { id: 12, reason: 'fetch failed' },
          { id: 13, reason: 'fetch failed' },
        ],
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns the transaction error to the refresh API instead of announcing success', async () => {
    transaction.mockRejectedValueOnce(new Error('书源事务写入失败'));
    const req = new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST',
      headers: { Authorization: 'Bearer shuyuan-test-owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    });

    const res = await POST(req);

    // P2-5：对外文案固定（错误消息可能含上游 URL，不再回显），状态码与失败语义不变。
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: '刷新失败' });
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
    // 单次挂起只累加连续失败计数（1 < 阈值 3），不写 failed、不把源踢出可用集；
    // 没有历史结论的源记为 unprobed，对展示与取书判据都等价于「没有条目」。
    expect(savedStates()[0]).toMatchObject({ status: 'unprobed', checked_at: null, consecutive_failures: 1 });
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

  // M1 任务 3：准入批次挂在全量替换事务之后（设计 §4.2 v3 E2）。候选源 = 通过 survey 初筛者。
  const admissionCandidate = {
    bookSourceUrl: 'https://new.example/', bookSourceName: '新源',
    searchUrl: 'https://new.example/s?q={{key}}',
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
    ruleContent: { content: '.c' },
  };
  const admissionSearchUrl = `https://new.example/s?q=${encodeURIComponent('斗破苍穹')}`;

  it('准入批次写 source_admission，且写库排在替换事务提交之后', async () => {
    setCollection(11, [admissionCandidate]);
    fetchMock.mockImplementation(async (input, options) => {
      const url = String(input);
      if (url === admissionSearchUrl) {
        expect(options?.redirect).toBe('manual'); // 准入通道独立于 fetchSourceText 的 redirect:'error'
        return new Response('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>', { status: 200 });
      }
      expect(options?.redirect).toBe('error');
      const fixture = responses.get(url);
      if (!fixture) throw new Error(`Unexpected network request: ${url}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });

    await refreshShuyuan();

    const insertIndex = execute.mock.calls.findIndex(([query]) => query.text.startsWith('INSERT INTO source_admission'));
    expect(insertIndex).toBeGreaterThan(-1);
    const payload = JSON.parse(execute.mock.calls[insertIndex][0].values[0] as string) as { source_url: string; search_verdict: string }[];
    expect(payload).toEqual([expect.objectContaining({ source_url: 'https://new.example', search_verdict: 'ok' })]);
    // 时序：替换事务在前，准入写库在后（事务提交后才探测/写库）。
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[insertIndex]);
  });

  it('剩余预算不足时整批跳过准入：不读不写 source_admission、不发搜索请求', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    setCollection(11, [admissionCandidate]);
    readTransaction.mockImplementation(async (queries) => {
      const result = await Promise.all(queries.map((query) => execute(query)));
      if (queries[0].text.includes('FROM shuyuan_meta')) vi.setSystemTime(started + REFRESH_BUDGET_MS - 5_000);
      return result;
    });
    fetchMock.mockImplementation(async (input, options) => {
      expect(options?.redirect).toBe('error');
      const fixture = responses.get(String(input));
      if (!fixture) throw new Error(`Unexpected network request: ${String(input)}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });

    await refreshShuyuan();

    // 预算剩余 5s < ADMISSION_MIN_BUDGET_MS(10s)：整批跳过，零准入 DB 往返、零搜索请求。
    expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      indexUrl, collectionUrl(11), collectionUrl(12), collectionUrl(13),
    ]);
    expect(transaction).toHaveBeenCalledOnce();
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

  it('重新启用只清禁用标记，保留上一次探测失败信息', async () => {
    execute.mockResolvedValueOnce([{ id: 1 }]);
    expect(await enableShuyuanSource(unknownSource.bookSourceUrl + '/')).toBe(true);
    const query = execute.mock.calls[0][0];
    expect(query.text).toContain('SET disabled_at = NULL');
    // 计划明确要求 enable 不动 last_error：清掉它，界面上「上一次为什么失败」的证据就没了。
    expect(query.text).not.toContain('last_error');
    expect(query.text).toContain('RETURNING id');
    expect(query.values).toEqual([unknownSource.bookSourceUrl]);
    expect(query.text).not.toContain('probeSnapshot');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('重新启用不在库里的 URL 返回 false，既不新增行也不探测', async () => {
    execute.mockResolvedValueOnce([]);
    expect(await enableShuyuanSource('https://gone.invalid/')).toBe(false);
    const query = execute.mock.calls[0][0];
    expect(query.text).not.toContain('INSERT');
    expect(query.values).toEqual(['https://gone.invalid']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('手动启用后刷新照抄当前禁用标记，不会把启用动作打回禁用', async () => {
    // 启用后的库内状态：disabled_at 为 NULL、last_error 仍是上一轮探测失败原因。
    setCollection(11, [unknownSource]);
    seedPrevious([{ source_url: unknownSource.bookSourceUrl, source: unknownSource, last_error: '历史连接超时', disabled_at: null }]);
    await refreshShuyuan();
    expect(savedRows()).toEqual([expect.objectContaining({
      url: unknownSource.bookSourceUrl, disabled_at: null, err: '历史连接超时',
    })]);
  });

  it('筛选分支把谓词、总数和页偏移绑定成同一组参数', async () => {
    const counts = { ...zeroCounts, total: 995, enabled: 900, disabled: 95, unprobed: 300, pending: 4, reachable: 402, failed: 289 };
    execute.mockResolvedValueOnce([{ collections: [], refreshed_at: null }])
      .mockResolvedValueOnce([counts])
      .mockResolvedValueOnce([]);
    const filter = 'disabled';
    const query = { filter, page: 3 } satisfies Parameters<typeof getShuyuanStats>[1];

    const stats = await getShuyuanStats(undefined, query);

    // 7 个谓词参数都是同一个白名单 id，不由调用方提供 SQL 片段。
    expect(execute.mock.calls[2][0].text).toContain("(? = 'disabled' AND disabled_at IS NOT NULL)");
    const values = execute.mock.calls[2][0].values;
    expect(values.slice(1, 8)).toEqual(Array(7).fill('disabled'));
    expect(values[8]).toBe(SOURCE_PAGE_SIZE);
    expect(values[9]).toBe(2 * SOURCE_PAGE_SIZE);
    // 总数取该筛选自己的计数，明细条数与卡片数字同源。
    expect(stats).toMatchObject({
      filter, page: 3, pageSize: SOURCE_PAGE_SIZE, total: counts.disabled,
      totalPages: pageCount(counts.disabled, SOURCE_PAGE_SIZE), sourcesLimit: SOURCE_PAGE_SIZE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['all', 'total'], ['enabled', 'enabled'], ['disabled', 'disabled'],
    ['unprobed', 'unprobed'], ['pending', 'pending'], ['reachable', 'reachable'], ['failed', 'failed'],
  ] as const)('筛选 %s 的谓词与其统计计数取自同一维度', async (filter, countKey) => {
    const counts = { ...zeroCounts, total: 995, enabled: 900, disabled: 95, unprobed: 300, pending: 4, reachable: 402, failed: 289 };
    execute.mockResolvedValueOnce([{ collections: [], refreshed_at: null }])
      .mockResolvedValueOnce([counts])
      .mockResolvedValueOnce([]);

    const stats = await getShuyuanStats(undefined, { filter, page: 1 });

    expect(stats.total).toBe(counts[countKey]);
    expect(stats.filter).toBe(filter);
    expect(stats.totalPages).toBe(pageCount(counts[countKey], SOURCE_PAGE_SIZE));
    expect(execute.mock.calls[2][0].values[1]).toBe(filter);
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

  // M1 任务 4 §5.2/§[M2]6.1：注册表合成视图。builtin 恒在前；引擎源并入**受 kill switch 约束**
  // （READING_ENGINE_SOURCES 默认关，提前落地 M2-3 开关）；启用后 = admission ok ∧ 非 disabled
  // ∧ probe 非 failed，且 host 必须已在运行时门集合内（冷启动 fail-closed，不 500）。
  describe('注册表合成视图（M1 任务 4 + M2-3 kill switch）', () => {
    const engineItem = {
      bookSourceUrl: 'https://engine.example/', bookSourceName: '引擎源',
      searchUrl: 'https://engine.example/s?q={{key}}',
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleContent: { content: '.c' },
    };
    const engineRow = (over: Record<string, unknown> = {}) => ({
      source_url: 'https://engine.example', source: engineItem, name: '引擎源',
      disabled_at: null, last_error: '', tier: 'M1', ...over,
    });
    afterEach(() => refreshSupportedHosts([])); // 复位运行时 host 集合

    it('默认（无 READING_ENGINE_SOURCES）不并入引擎源：池 = builtin only，且不查准入表', async () => {
      refreshSupportedHosts(['engine.example']); // 即使 host 与准入数据都就绪
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin']);
      expect(sources[0].url).toBe('https://book15.net/');
      // 开关默认关 ⇒ 连准入表都不查（省 DB 往返，也不暴露引擎源失败面）。
      expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(false);
    });

    it('READING_ENGINE_SOURCES=0 显式关闭：同默认（不并入引擎源）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '0');
      refreshSupportedHosts(['engine.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]);
      expect((await getReadingSources(new AbortController().signal)).map((source) => source.tier)).toEqual(['builtin']);
    });

    it('READING_ENGINE_SOURCES=1 且 host 未就绪（冷启动）时引擎源仍不出池，不 500', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin']);
      expect(sources[0].url).toBe('https://book15.net/');
    });

    it('READING_ENGINE_SOURCES=1 + host 就绪：builtin 在前、引擎源在后，rules 原对象透传', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts(['engine.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin', 'M1']);
      expect(sources[1]).toMatchObject({
        url: 'https://engine.example/', searchUrl: 'https://engine.example/s?q={{key}}', tier: 'M1',
      });
      // m2-scaleout §5.2 第 1 条：rules 必须与 shuyuan_sources.source 同一对象（不裁剪）。
      expect(sources[1].rules).toBe(engineItem);
    });

    it('READING_POOL_LIMIT 约束池大小（波次开关，默认 4）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '1');
      refreshSupportedHosts(['engine.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([engineRow()]);
      // 上限 1 ⇒ 只剩 builtin 首源（builtin 恒在前，引擎源被截断）。
      expect((await getReadingSources(new AbortController().signal)).map((source) => source.tier)).toEqual(['builtin']);
    });

    it('引擎源查询失败时降级为 builtin 单源，不 500（零回归）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('relation "source_admission" does not exist'));
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin']);
    });

    it('getEngineSources 不受 kill switch 影响，仍返回 admission ok 的引擎源', async () => {
      refreshSupportedHosts(['engine.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([engineRow()]);
      expect(await getEngineSources(new AbortController().signal)).toMatchObject([
        { url: 'https://engine.example/', tier: 'M1' },
      ]);
    });

    it('/api/stats 的 readingPoolSize 在默认开关下为 1', async () => {
      const refreshedAt = '2026-09-19T00:00:00Z';
      execute.mockResolvedValueOnce([{ collections: [], refreshed_at: refreshedAt }])
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]);
      const health = await getShuyuanPoolHealth(new AbortController().signal);
      expect(health.readingPoolSize).toBe(1);
      expect(health.refreshedAtAgeHours).toBeGreaterThanOrEqual(0);
    });

    // ---------------------------------------------------------------- M2-3 §2.4 排序全序 / §2.3 池上限 / §6.3 观测
    const engineItemAt = (host: string) => ({
      bookSourceUrl: `https://${host}/`, bookSourceName: host,
      searchUrl: `https://${host}/s?q={{key}}`,
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleContent: { content: '.c' }, enabled: true,
    });
    const engineRowAt = (host: string, over: Record<string, unknown> = {}) => ({
      source_url: `https://${host}`, source: engineItemAt(host), name: host,
      disabled_at: null, last_error: '', tier: 'M1', search_checked_at: null, ...over,
    });
    const reachableMeta = (url: string) => ({
      collections: [{ id: 1, title: '合集', count: 1, probeSnapshot: { version: 1, entries: [
        { url, status: 'reachable', checked_at: '2026-09-18T00:00:00Z' },
      ] } }],
    });

    it('排序全序：probe reachable DESC → tier 升序 → search_checked_at DESC → url 升序', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '10');
      refreshSupportedHosts(['a.example', 'b.example', 'c.example', 'd.example', 't7.example']);
      execute.mockResolvedValueOnce([reachableMeta('https://b.example')]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          engineRowAt('a.example', { search_checked_at: '2026-09-01T00:00:00Z' }),
          engineRowAt('b.example', { search_checked_at: '2026-09-01T00:00:00Z' }), // reachable，应最先
          engineRowAt('c.example', { search_checked_at: '2026-09-20T00:00:00Z' }),
          engineRowAt('d.example', { search_checked_at: '2026-09-20T00:00:00Z' }), // 与 c 同刻，url 靠后
          engineRowAt('t7.example', { tier: 'T7', search_checked_at: '2026-09-30T00:00:00Z' }), // tier 最晚
        ]);
      const { sources } = await getReadingPool(new AbortController().signal);
      expect(sources.map((source) => source.url)).toEqual([
        'https://book15.net/', // builtin 恒 index 0
        'https://b.example/',  // 唯一 reachable
        'https://c.example/',  // M1 新结论优先，同刻 url 升序
        'https://d.example/',
        'https://a.example/',  // M1 旧结论
        'https://t7.example/', // T7 排在全部 M1 之后
      ]);
    });

    it('排序对抗用例：builtin probe=failed 时引擎源递补 index 0；builtin 在场时恒 index 0', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts(['engine.example']);
      const builtinRow = { source_url: 'https://book15.net', source: { bookSourceUrl: 'https://book15.net', searchUrl: 'https://book15.net/s?kw={{key}}', enabled: true }, name: 'book15', disabled_at: null, last_error: '' };
      // ① builtin probe=failed ⇒ 被剔除，reachable 的引擎源递补到 index 0。
      const failedMeta = { collections: [{ id: 1, title: '合集', count: 1, probeSnapshot: { version: 1, entries: [
        { url: 'https://book15.net', status: 'failed', checked_at: '2026-09-18T00:00:00Z' },
      ] } }] };
      execute.mockResolvedValueOnce([failedMeta]).mockResolvedValueOnce([builtinRow])
        .mockResolvedValueOnce([engineRow({ search_checked_at: '2026-09-18T00:00:00Z' })]);
      const absent = await getReadingSources(new AbortController().signal);
      expect(absent.map((source) => source.tier)).toEqual(['M1']);
      expect(absent[0].url).toBe('https://engine.example/');
      // ② builtin 在场（即使引擎源 reachable）⇒ builtin 恒 index 0，引擎源靠后。
      execute.mockResolvedValueOnce([reachableMeta('https://engine.example')]).mockResolvedValueOnce([builtinRow])
        .mockResolvedValueOnce([engineRow({ search_checked_at: '2026-09-18T00:00:00Z' })]);
      const present = await getReadingSources(new AbortController().signal);
      expect(present.map((source) => source.tier)).toEqual(['builtin', 'M1']);
      expect(present[0].url).toBe('https://book15.net/');
    });

    it('READING_POOL_LIMIT 生效且 poolCandidates 计数正确（§2.3 放行判据）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts(['a.example', 'b.example', 'c.example', 'd.example']);
      const engineRows = ['a.example', 'b.example', 'c.example', 'd.example'].map((host) => engineRowAt(host));
      // 候选 = builtin(1) + 引擎(4) = 5。上限 3 ⇒ 池 3、截断 2、其中引擎 2。
      vi.stubEnv('READING_POOL_LIMIT', '3');
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]).mockResolvedValueOnce(engineRows);
      await expect(getReadingPool(new AbortController().signal)).resolves.toMatchObject({
        enginePoolSize: 2, poolCandidates: 2,
      });
      // 上限 6 ≥ 候选 5 ⇒ 放量空间为 0（W1：1 builtin + 4 引擎正好填不满 6）。
      vi.stubEnv('READING_POOL_LIMIT', '6');
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]).mockResolvedValueOnce(engineRows);
      await expect(getReadingPool(new AbortController().signal)).resolves.toMatchObject({
        enginePoolSize: 4, poolCandidates: 0,
      });
    });

    it('合成条目的 rules 与 shuyuan_sources.source 深相等；sourceRevision 与 rules_hash 同源（§5.2）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts(['engine.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      const engine = sources.find((source) => source.tier === 'M1')!;
      // 硬约束 1：不做字段裁剪/重排/包装——同一对象、深相等、键集完全一致。
      expect(engine.rules).toBe(engineItem);
      expect(engine.rules).toEqual(engineItem);
      expect(Object.keys(engine.rules).sort()).toEqual(Object.keys(engineItem).sort());
      // 硬约束 2：池里合成的源算出的 revision 与准入 rules_hash 是同一函数、同一值。
      const pooled = sourceRevision({ url: engine.url, searchUrl: engine.searchUrl, rules: engine.rules });
      expect(pooled).toBe(rulesHash(engineItem));
      // 判别力：任何一个键被裁掉都会改变 revision（防裁剪断言不是恒真）。
      const trimmed = { ...engineItem } as Record<string, unknown>;
      delete trimmed.ruleContent;
      expect(sourceRevision({ url: engine.url, searchUrl: engine.searchUrl, rules: trimmed })).not.toBe(pooled);
    });

    it('disableShuyuanSource 后源即时出池，且刷新照抄禁用标记不打回', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts(['engine.example']);
      // ① 即时出池：库内该源 disabled_at 非空 ⇒ engineReadingSources 直接剔除。
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([engineRow({ disabled_at: '2026-09-10T00:00:00Z' })]);
      const disabledPool = await getReadingPool(new AbortController().signal);
      expect(disabledPool).toMatchObject({ enginePoolSize: 0 });
      expect(disabledPool.sources).toHaveLength(1); // 只剩 builtin
      // ② 下一次刷新原样照抄 disabled_at（refreshShuyuan 无重置分支），不打回启用态。
      setCollection(11, [unknownSource]);
      seedPrevious([{ source_url: unknownSource.bookSourceUrl, source: unknownSource, last_error: '', disabled_at: '2026-09-10T00:00:00Z' }]);
      await refreshShuyuan();
      expect(savedRows()).toEqual([expect.objectContaining({ disabled_at: '2026-09-10T00:00:00Z' })]);
    });

    it('getShuyuanPoolHealth 带出 enginePoolSize/poolCandidates/admission 漏斗（§6.3）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '6');
      refreshSupportedHosts(['engine.example']);
      // getShuyuanPoolHealth 内部 Promise.all 并发取池与漏斗，靠 SQL 文本分派而非调用顺序。
      execute.mockImplementation(async (query) => {
        const text = query.text;
        if (text.includes('FROM source_admission')) return [{ ok: 12, deferred: 5, rejected: 3 }];
        if (text.includes('JOIN source_admission')) return [engineRow()];
        if (text.includes('FROM shuyuan_sources')) return [];
        if (text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
        return [];
      });
      const health = await getShuyuanPoolHealth(new AbortController().signal);
      expect(health).toMatchObject({
        readingPoolSize: 2, enginePoolSize: 1, poolCandidates: 0,
        admission: { ok: 12, deferred: 5, rejected: 3 },
      });
      // 漏斗谓词与入池判据同口径：ok 必须含 compile_ok ∧ search_ok IS TRUE。
      const funnel = execute.mock.calls.find(([query]) => query.text.includes('FROM source_admission'))![0];
      expect(funnel.text).toContain('compile_ok AND search_ok IS TRUE');
      expect(funnel.text).toContain("search_verdict IN ('challenge', 'conn_fail', 'shell')");
    });
  });

  // 归纳：last_error 的自动写点、连续失败阈值、失败计数的持久化与解析等价。
  describe('源健康探测：连续失败计数', () => {
    const storedKnown = (lastError: string, disabledAt: string | null = null) => ({
      source_url: knownSource.bookSourceUrl, source: knownSource, last_error: lastError, disabled_at: disabledAt,
    });
    const entry = (over: Record<string, unknown> = {}) => ({
      url: knownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-16T00:00:00Z', error: null, ...over,
    });
    const probedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

    it('没有任何失败记录的启用源也会被自动探测，失败后留下证据（不再恒为 unprobed）', async () => {
      // 生产现状：库内 last_error 全空、无快照 ⇒ 旧门控永远不入队，探测链断电。
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('')]);
      responses.set('https://book15.net/', { body: 'unavailable', status: 503 });

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://book15.net/');
      expect(savedStates()).toEqual([{
        url: knownSource.bookSourceUrl, status: 'unprobed', checked_at: null, error: null, consecutive_failures: 1,
      }]);
      // last_error 的自动写点：此前只有人工 POST {action:disable} 会写它。
      expect(savedRows()[0].err).toBe('503 https://book15.net/');
    });

    it('单次探测失败不降级：保留上一次可达结论，只把计数加到 1', async () => {
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry()]);

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://book15.net/');
      expect(savedStates()).toEqual([{
        url: knownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-16T00:00:00Z', error: null,
        consecutive_failures: 1,
      }]);
      expect(savedRows()[0].err).toBe('历史连接超时');
    });

    it('连续第三次探测失败才写 failed，并带出这次探测的错误原文', async () => {
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry({ status: 'unprobed', checked_at: null, consecutive_failures: 2 })]);

      await refreshShuyuan();

      expect(savedStates()).toEqual([{
        url: knownSource.bookSourceUrl, status: 'failed', checked_at: expect.any(String),
        error: expect.stringContaining('https://book15.net/'), consecutive_failures: 3,
      }]);
    });

    it('阈值差一次时探测失败仍不判死：第二次失败只把计数加到 2，第三次才写 failed', async () => {
      setCollection(11, [knownSource]);
      responses.set('https://book15.net/', { body: 'unavailable', status: 503 });
      seedPrevious([storedKnown('历史连接超时')], [entry({ status: 'unprobed', checked_at: null, consecutive_failures: 1 })]);

      await refreshShuyuan();

      const afterSecond = savedStates()[0];
      expect(afterSecond).toEqual({
        url: knownSource.bookSourceUrl, status: 'unprobed', checked_at: null, error: null, consecutive_failures: 2,
      });
      // 差一次就到阈值时最容易提前判死：status 必须仍是 unprobed。
      expect(afterSecond.status).not.toBe('failed');

      // 第三轮：把上一轮写出的快照原样喂回去，只有这一次才允许判死。
      transaction.mockClear();
      seedPrevious([storedKnown('历史连接超时')], [afterSecond]);
      await refreshShuyuan();

      expect(savedStates()).toEqual([{
        url: knownSource.bookSourceUrl, status: 'failed', checked_at: expect.any(String),
        error: expect.stringContaining('https://book15.net/'), consecutive_failures: 3,
      }]);
    });

    it('已知失败源排在补探的未探测源之前', async () => {
      const freshSource = { ...knownSource, bookSourceUrl: 'https://book15.net/fresh', bookSourceName: '全新源' };
      setCollection(11, [knownSource, freshSource]);
      seedPrevious([storedKnown('历史连接超时')]);
      responses.set('https://book15.net/', { body: 'unavailable', status: 503 });
      responses.set('https://book15.net/fresh', { body: 'unavailable', status: 503 });

      await refreshShuyuan();

      // 前 4 次是 index + 3 个合集。探测按 probes 数组顺序下发（并发窗口内也保序），
      // 带 last_error 的已知失败源必须先于「没有任何结论」的补探源，补探不能插到队首。
      expect(probedUrls()).toEqual([
        indexUrl, collectionUrl(11), collectionUrl(12), collectionUrl(13),
        'https://book15.net/', 'https://book15.net/fresh',
      ]);
    });

    it('探测成功把连续失败计数清零并回到可达', async () => {
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry({ status: 'unprobed', checked_at: null, consecutive_failures: 2 })]);
      responses.set('https://book15.net/', { body: '离线合成响应' });

      await refreshShuyuan();

      expect(savedStates()).toEqual([{
        url: knownSource.bookSourceUrl, status: 'reachable', checked_at: expect.any(String), error: null,
        consecutive_failures: 0,
      }]);
    });

    it('未达阈值的失败记录仍在取书可用集里，只有 failed 才被剔除', async () => {
      execute.mockResolvedValueOnce([{ collections: [{ id: 1, title: '合集', count: 1,
        probeSnapshot: { version: 1, entries: [entry({ status: 'unprobed', checked_at: null, consecutive_failures: 2 })] },
      }] }]).mockResolvedValueOnce([{ ...oldSource(knownSource), disabled_at: null, name: '抖动源' }]);

      expect(await getReadingSources(new AbortController().signal))
        .toMatchObject([{ url: 'https://book15.net/', name: '抖动源' }]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('探测期间调用方中止不算源失败：不写状态、不累加计数、不提交事务', async () => {
      const controller = new AbortController();
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry({ consecutive_failures: 1 })]);
      const ordinary = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) => {
        if (String(input) === 'https://book15.net/') {
          controller.abort(new Error('测试取消'));
          return Promise.reject(new Error('测试取消'));
        }
        return ordinary(input, init);
      });

      await expect(refreshShuyuan(controller.signal)).rejects.toThrow('测试取消');
      expect(transaction).not.toHaveBeenCalled();
      expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
    });

    it('旧快照缺 consecutive_failures 时，喂给 SQL 的绑定值与加字段前逐字节相同', async () => {
      const legacy = { url: knownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-16T00:00:00Z', error: null };
      execute.mockResolvedValueOnce([{ collections: [{ id: 11, title: '旧合集', count: 1,
        probeSnapshot: { version: 1, entries: [legacy] },
      }], refreshed_at: null }])
        .mockResolvedValueOnce([{ ...zeroCounts, total: 1, enabled: 1, reachable: 1 }])
        .mockResolvedValueOnce([]);

      await getShuyuanStats();

      expect(execute.mock.calls[1][0].values[0]).toBe(JSON.stringify([legacy]));
    });
  });
});
