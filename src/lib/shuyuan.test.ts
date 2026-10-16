import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Query = { text: string; values: unknown[] };
type TransactionOptions = { readOnly?: boolean; fetchOptions?: { signal: AbortSignal } };

const { ensureSchema, getSql, sql, execute, transaction, readTransaction } = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  // urlfix：neon 的 sql.unsafe(raw) 把原始 SQL 片段内联进 text（不是参数绑定），
  // 归一化表达式依赖它；其余插值照旧进 values。
  const isUnsafe = (value: unknown): value is { __unsafe: true; raw: string } =>
    typeof value === 'object' && value !== null && '__unsafe' in value;
  const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const bound: unknown[] = [];
    strings.forEach((part, index) => {
      text += part;
      if (index < values.length) {
        const value = values[index];
        if (isUnsafe(value)) { text += value.raw; } else { bound.push(value); text += '?'; }
      }
    });
    const query = { text: text.replace(/\s+/g, ' ').trim(), values: bound };
    // Neon 的标签模板返回惰性查询；只有独立 await 才会绕过 transaction 执行。
    return {
      ...query,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected: (error: unknown) => unknown) {
        return execute(query).then(onFulfilled, onRejected);
      },
    };
  });
  const sql = Object.assign(tag, { unsafe: (raw: string) => ({ __unsafe: true, raw } as unknown) });
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

// 真实注册表里 book15 已退休（识别仍在、不许发请求）。池合成用例需要「已注册的活跃内建源」：
// 这里 mock 注册表——退休 book15 原样保留，另注册一个活跃内建源 builtin.test（host 进识别集合，
// validateSourceUrl 的内建兜底才放行它的行）。全部判定走被测模块的真实实现
// （isHostActiveInSources / sourceForHostIn / 同一过滤谓词），只换注册表数据。
vi.mock('@/lib/supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supported-sources')>();
  const activeBuiltin: import('@/lib/supported-sources').SupportedSource = {
    url: 'https://builtin.test/',
    name: 'builtin.test',
    searchUrl: 'https://builtin.test/s?q={{key}}',
    rules: {},
    tier: 'builtin',
    enabled: true,
    lifecycle: 'active',
    retiredReason: null,
  };
  const sources = [...actual.BUILTIN_SOURCES, activeBuiltin];
  const active = () => sources.filter((source) => source.lifecycle === 'active' && source.enabled !== false);
  return {
    ...actual,
    BUILTIN_SOURCE_HOSTS: [...actual.BUILTIN_SOURCE_HOSTS, 'builtin.test'],
    BUILTIN_SOURCES: sources,
    activeBuiltinSources: () => active(),
    activeBuiltinSource: () => active()[0] ?? null,
    builtinUrlPrefixes: () => sources.map((source) => new URL(source.url).origin),
    builtinSourceForHost: (host: string) => actual.sourceForHostIn(host, sources),
    isActiveBuiltinHost: (host: string) => actual.isHostActiveInSources(host, sources),
  };
});

import {
  disableShuyuanSource, enableShuyuanSource, engineSourcesEnabled, getBuiltinRequestSource, getEngineSources, getFanoutPool, getReadingPool, getShuyuanCounts,
  getShuyuanPoolHealth, getShuyuanStats, getReadingSources, getSourcePools, refreshShuyuan,
  REFRESH_BUDGET_MS, PROBE_PENDING_PER_REFRESH, RESPONSE_TIMEOUT_MS, SHUYUAN_REFRESH_PARTIAL, ShuyuanRefreshPartialError,
  ADMISSION_LEASE_ROW,
} from './shuyuan';
import { resolveDownloadSource } from './download-source';
import { assembleEngineModules, createResolveSource } from '../../runtime-download/engine';
import { sourceRevision } from './source-revision';
import * as poolArtifacts from './pool-artifact';
import { ADMISSION_MIN_BUDGET_MS, rulesHash } from './rule-engine/admission';
import { refreshSupportedHosts, validateSourceUrl, SourcePolicyError } from './source-policy';
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
// 合成注册表（见顶部 vi.mock）的活跃内建源——替代「book15 当活跃默认」的旧 fixture。
const knownSource = { ...unknownSource, bookSourceUrl: 'https://builtin.test', bookSourceName: '支持的来源' };
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
    // admlfix42：刷新尾部现无条件领准入租约（与 ADMISSION_OWN_CRON 解耦）。默认让它领到（返回租约行），
    // 使准入照常跑（等价于改前开关关时直落 admitRows 的路径）；其余查询维持原样。
    execute.mockReset().mockImplementation(async (query) => {
      if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
        return [{ name: ADMISSION_LEASE_ROW, generation: '1' }];
      }
      return query.text.startsWith('SELECT count(*)') ? [zeroCounts] : [];
    });
    transaction.mockReset().mockImplementation(async (batch) => {
      if (!batch.some((query) => query.text.startsWith('SELECT name FROM cron_health'))) return [];
      const results = [];
      for (const query of batch) results.push(await execute(query));
      const writeIndex = batch.findIndex((query) => query.text.includes('INSERT INTO source_admission'));
      if (writeIndex >= 0) {
        results[writeIndex] = [{ lease_valid: true, written: JSON.parse(batch[writeIndex].values[2] as string).length }];
      }
      return results;
    });
    readTransaction.mockReset().mockImplementation(async (queries, options) => {
      expect(options?.fetchOptions?.signal).toBeInstanceOf(AbortSignal);
      return Promise.all(queries.map((query) => execute(query)));
    });
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(Object.assign(sql, { transaction: (queries: Query[], options?: TransactionOptions) =>
      options?.readOnly ? readTransaction(queries, options) : transaction(queries, options),
    }));
    vi.stubEnv('APP_OWNER_TOKEN', 'shuyuan-test-owner');
    // 不涉及引擎的旧SQL夹具明确关闭；默认开启用例自行覆盖此隔离前提。
    vi.stubEnv('READING_ENGINE_SOURCES', '0');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    responses.clear();
    responses.set(indexUrl, {
      body: [11, 12, 13].map((id) => `<a href="/yuedu/shuyuans/content/id/${id}.html">合集 ${id}</a>`).join(''),
    });
    setCollection(11, [source]);
    setCollection(12, []);
    setCollection(13, []);
    fetchMock.mockReset().mockImplementation(async (input, options) => {
      expect(options?.redirect).toBe('manual');
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
    // admlfix42：刷新尾部无条件领准入租约（多一次 INSERT INTO cron_health），按 text 分派让它领到；
    // 其余 SELECT 读按原顺序出桩（租约调用不占用序号，故读顺序与改前一致）。
    const selectResponses: unknown[][] = [
      [], // SELECT ... FROM shuyuan_sources（快照既有行）
      [{ collections: [], refreshed_at: null }], // 合并前读 shuyuan_meta
      // 41-srcfix G5：准入既有行按本轮全部源读一次（初筛不过的源也要查有没有 compile_ok 冻结行），
      // 无候选不再零 DB 往返；这里库中无准入行 ⇒ 空。
      [], // 准入读既有 source_admission
      [{ collections, refreshed_at: refreshedAt }], // 收尾读 shuyuan_meta
      [{ ...zeroCounts, total: 101, enabled: 101, unprobed: 101 }], // 计数
      [], // 收尾读
    ];
    let selectIdx = 0;
    execute.mockImplementation(async (query) => {
      if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
        return [{ name: ADMISSION_LEASE_ROW, generation: '1' }];
      }
      if (query.text.startsWith('SET LOCAL') || query.text.startsWith('LOCK TABLE') || query.text.startsWith('WITH guard')
        || query.text.startsWith('SELECT name FROM cron_health')) return [];
      return selectResponses[selectIdx++] ?? [];
    });

    await expect(refreshShuyuan()).resolves.toEqual({
      ...zeroCounts, total: 101, enabled: 101, unprobed: 101, collections, refreshedAt,
      sources: [], sourcesLimit: 100,
    });

    expect(transaction).toHaveBeenCalledTimes(2); // 刷新替换 + 空准入批次判权。
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
    // permblock42：首条 collection 的 probeSnapshot 新增 permanentDisable.hosts mirror（硬默认名单）。
    expect(JSON.parse(meta.values[0] as string)).toEqual(collections.map((collection, i) =>
      i === 0 ? {
        ...collection,
        probeSnapshot: {
          version: 1,
          entries: [],
          permanentDisable: { hosts: ['api.wnreader.com', 'wnreader.com'] },
        },
      } : collection));
    // 6 次读 + 1 次 claim + 5 句空准入批次判权事务（含源快照锁）。
    expect(execute).toHaveBeenCalledTimes(12);
    expect(transaction.mock.calls[0][1]?.fetchOptions?.signal).toBeInstanceOf(AbortSignal);
    const isLease = (query: Query) =>
      query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW;
    expect(execute.mock.calls.filter(([query]) => isLease(query))).toHaveLength(1);
    const fenceQueries = new Set(transaction.mock.calls[1][0]);
    // 排除 claim 和围栏事务，剩余只有读查询；刷新替换仍不独立执行。
    expect(execute.mock.calls.filter(([query]) => !isLease(query) && !fenceQueries.has(query))
      .every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
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

  // S3-1（静默失败审计）：半挂（只拉到部分合集）必须保持中止——写库是整表替换语义
  // （尾部事务 DELETE FROM shuyuan_sources + 整批 INSERT merged），带着 2/3 合集继续更新
  // 会把缺失合集里的源静默删掉。判据不放宽，只补可观测：结构化错误 + 响亮告警。
  it('S3-1 半挂中止带结构化错误：固定错误码 + expected/actual + 失败合集 id（原因已脱敏）', async () => {
    responses.set(collectionUrl(12), { body: 'unavailable', status: 503 });

    const error = await refreshShuyuan().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ShuyuanRefreshPartialError);
    const partial = error as ShuyuanRefreshPartialError;
    expect(partial.code).toBe(SHUYUAN_REFRESH_PARTIAL);
    expect(partial.expected).toBe(3);
    expect(partial.actual).toBe(2);
    // 失败合集只带仓内自有标识（合集 id）；reason 过 safeReason ⇒ 上游 URL 已抹除。
    expect(partial.failures).toEqual([{ id: 12, reason: '503 [redacted-url]' }]);
    expect(partial.failures[0].reason).not.toContain('yckceo');
    // 响亮告警：日志里能一眼看出是「半挂」而不是别的 502。
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('shuyuan refresh partial'),
      expect.objectContaining({
        code: SHUYUAN_REFRESH_PARTIAL, expected: 3, actual: 2,
        failures: [{ id: 12, reason: '503 [redacted-url]' }],
      }),
    );
    // 语义不变：仍然零写库。
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('S3-1 半挂经 /api/shuyuan 返回 502 + code:shuyuan_refresh_partial，文案仍固定不回显 e.message', async () => {
    responses.set(collectionUrl(12), { body: 'unavailable', status: 503 });
    const req = new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST',
      headers: { Authorization: 'Bearer shuyuan-test-owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; code?: string };
    expect(body).toEqual({ error: '刷新失败', code: 'shuyuan_refresh_partial' });
    // P2-5 不倒退：错误码是安全枚举，不是 e.message——上游 URL 与数量原文都不出现在响应体里。
    expect(JSON.stringify(body)).not.toContain('yckceo');
    expect(body.error).not.toContain('仅拉到');
  });

  it('S3-1 非半挂的刷新失败不带 code：错误码只标半挂这一种失败', async () => {
    transaction.mockRejectedValueOnce(new Error('书源事务写入失败'));
    const req = new NextRequest('http://localhost/api/shuyuan', {
      method: 'POST',
      headers: { Authorization: 'Bearer shuyuan-test-owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: '刷新失败' });
  });

  it('does not replace existing sources with an empty collection result', async () => {
    setCollection(11, []);

    // 合集 JSON 都拉到了、只是没有任何源：同样不写库，但走降级返回而不是抛错。
    await expect(refreshShuyuan()).resolves.toMatchObject({ collections: [], refreshedAt: null });

    expect(transaction).not.toHaveBeenCalled();
    expect(execute.mock.calls.every(([query]) => query.text.startsWith('SELECT '))).toBe(true);
  });

  // 41-srcinput：单条非法记录（非对象 / bookSourceUrl 非字符串 / 归一后空）不得中止整轮，
  // 也不得进入写库行集——它们在合并阶段被逐条跳过，合法记录照常入库。
  it('单条非法记录被跳过：合法源照常入库，非法形态不进 INSERT 行集', async () => {
    setCollection(11, [
      { bookSourceUrl: 'https://valid.example/1', bookSourceName: '合法一' },
      null, // 非对象
      42, // 数字
      'https://valid.example/str', // 字符串条目
      { bookSourceName: '缺 bookSourceUrl' }, // 对象但缺字段
      { bookSourceUrl: 12345, bookSourceName: 'URL 非字符串' },
      { bookSourceUrl: '   ', bookSourceName: 'URL 归一后为空' },
      { bookSourceUrl: 'https://valid.example/2/', bookSourceName: '合法二（尾斜杠）' },
    ]);

    const selectResponses: unknown[][] = [
      [], // SELECT ... FROM shuyuan_sources（快照既有行）
      [{ collections: [], refreshed_at: null }], // 合并前读 shuyuan_meta
      [], // 准入读既有 source_admission
      [{ collections: [{ id: 11, title: '合集 11', count: 8 }], refreshed_at: '2026-09-14T01:00:00Z' }], // 收尾读 shuyuan_meta
      [{ ...zeroCounts, total: 2, enabled: 2, unprobed: 2 }], // 计数
      [], // 收尾读
    ];
    let selectIdx = 0;
    execute.mockImplementation(async (query) => {
      if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
        return [{ name: ADMISSION_LEASE_ROW, generation: '1' }];
      }
      if (query.text.startsWith('SET LOCAL') || query.text.startsWith('LOCK TABLE') || query.text.startsWith('WITH guard')
        || query.text.startsWith('SELECT name FROM cron_health')) return [];
      return selectResponses[selectIdx++] ?? [];
    });

    await expect(refreshShuyuan()).resolves.toMatchObject({ total: 2, enabled: 2 });

    const inserted = savedRows().map((row) => row.url).sort();
    expect(inserted).toEqual(['https://valid.example/1', 'https://valid.example/2']);
  });

  // 41-srcinput：重复记录按归一化 URL 去重（首见优先），重复条不产生第二行、不报错。
  // 集合内重复（首尾空白/尾斜杠差异）与跨合集重复都覆盖。
  it('重复记录按归一化 URL 去重：首见优先，跨合集与同合集变形都只有一行', async () => {
    setCollection(11, [
      { bookSourceUrl: 'https://dup.example/a/', bookSourceName: '首见版本' },
      { bookSourceUrl: ' https://dup.example/a ', bookSourceName: '同合集变形（空白+无斜杠）' },
    ]);
    setCollection(12, [
      { bookSourceUrl: 'https://dup.example/a', bookSourceName: '跨合集重复' },
      { bookSourceUrl: 'https://dup.example/b', bookSourceName: '独有源' },
    ]);

    const selectResponses: unknown[][] = [
      [], // SELECT ... FROM shuyuan_sources（快照既有行）
      [{ collections: [], refreshed_at: null }], // 合并前读 shuyuan_meta
      [], // 准入读既有 source_admission
      [{
        collections: [
          { id: 11, title: '合集 11', count: 2 },
          { id: 12, title: '合集 12', count: 2 },
          { id: 13, title: '合集 13', count: 0 },
        ],
        refreshed_at: '2026-09-14T01:00:00Z',
      }], // 收尾读 shuyuan_meta
      [{ ...zeroCounts, total: 2, enabled: 2, unprobed: 2 }], // 计数
      [], // 收尾读
    ];
    let selectIdx = 0;
    execute.mockImplementation(async (query) => {
      if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
        return [{ name: ADMISSION_LEASE_ROW, generation: '1' }];
      }
      if (query.text.startsWith('SET LOCAL') || query.text.startsWith('LOCK TABLE') || query.text.startsWith('WITH guard')
        || query.text.startsWith('SELECT name FROM cron_health')) return [];
      return selectResponses[selectIdx++] ?? [];
    });

    await expect(refreshShuyuan()).resolves.toMatchObject({ total: 2, enabled: 2 });

    const inserted = savedRows();
    expect(inserted).toHaveLength(2);
    const dup = inserted.find((row) => row.url === 'https://dup.example/a');
    // srcfeed：两条 yckceo 条目都打到 position=0、双方无 lastUpdateTime ⇒ incomingWins 恒 false，
    // 「首见留表」；这两条注释钉的是 yckceo 内部反复现的第一条（合集间冲突的语义钉在
    // shuyuan.extra-feeds.test.ts：extra 后到者胜，但 yckceo 占 position=0，对 yckceo 不可翻）。
    expect(dup?.source).toMatchObject({ bookSourceName: '首见版本' });
  });

  it('上游合集整体不可达时降级：不抛错、不写库、返回库中既有统计并响亮告警', async () => {
    // 判别性构造：传输层对索引页之外的合集请求一律抛 undici 网络错误形态（ECONNRESET 那一类），
    // 三个合集全部拉不到 ⇒ merged.size === 0，正是生产 09-15 之后每轮 cron 走到的分支。
    fetchMock.mockImplementation(async (input, options) => {
      expect(options?.redirect).toBe('manual');
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

  it('srcfeed：yckceo 半挂 ⇒ extra feed 全短路（fetch 仍只有 4 条 yckceo，extraFeeds 不伸手）', async () => {
    vi.stubEnv('SHUYUAN_EXTRA_FEEDS', 'https://extra1.example/all.json');
    const extraCalled: string[] = [];
    const ordinary = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, options) => {
      const url = String(input);
      if (url === 'https://extra1.example/all.json') extraCalled.push(url);
      if (url === 'https://www.yckceo.com/yuedu/shuyuans/json/id/12.json') return Promise.resolve(new Response('unavailable', { status: 503 }));
      return ordinary(input, options);
    });

    await expect(refreshShuyuan()).rejects.toThrow('仅拉到 2/3 个书源合集，本次刷新中止，保留既有数据');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(extraCalled).toEqual([]);
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
    responses.set('https://builtin.test/', { body: '离线合成响应' });
    await refreshShuyuan();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('https://builtin.test/');
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
    await expect(refreshShuyuan()).rejects.toThrow('非受信主机');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
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
    fetchMock.mockImplementation((input, init) => String(input) === 'https://builtin.test/'
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
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
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
      expect(options?.redirect).toBe('manual');
      const fixture = responses.get(url);
      if (!fixture) throw new Error(`Unexpected network request: ${url}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });

    await refreshShuyuan();

    const insertIndex = execute.mock.calls.findIndex(([query]) => query.text.includes('INSERT INTO source_admission'));
    expect(insertIndex).toBeGreaterThan(-1);
    const payload = JSON.parse(execute.mock.calls[insertIndex][0].values[2] as string) as { source_url: string; search_verdict: string }[];
    expect(payload).toEqual([expect.objectContaining({ source_url: 'https://new.example', search_verdict: 'ok' })]);
    // 时序：替换事务在前，准入写库在后（事务提交后才探测/写库）。
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[insertIndex]);
  });

  // 准入兼容 L3 反例 17：compile 拒 ≠ 出环。候选池只由 selectCandidates（survey 初筛）
  // 决定（runAdmissionAfterRefresh），不读 source_admission、不看 compile_ok/search_ok——
  // 把「compile 拒的源每天仍进评估环」钉成机器可验的事实，防止后续「只喂 compile_ok 源」
  // 这类善意但致命的优化切断恢复回路。
  it('准入兼容 L3 反例 17：source_admission 全为 compile 拒 → 下一轮刷新仍对同批源跑准入（compile 拒 ≠ 出环）', async () => {
    setCollection(11, [admissionCandidate]);
    // 上一轮已写下 compile 拒行（readAdmissionRows 读 source_admission）。
    execute.mockImplementation(async (query) => {
      if (query.text.startsWith('SELECT count(*)')) return [zeroCounts];
      if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
        return [{ name: ADMISSION_LEASE_ROW, generation: '1' }]; // admlfix42：刷新尾部无条件领约，默认领到。
      }
      if (query.text.startsWith('SELECT source_url, tier, compile_ok')) {
        return [{
          source_url: 'https://new.example', tier: 'T7', compile_ok: false, core_field_mask: {},
          search_ok: null, search_verdict: '', search_checked_at: null,
          rules_hash: rulesHash(admissionCandidate), host: 'new.example', error: '历史拒因',
        }];
      }
      if (query.text.includes('INSERT INTO source_admission')) return [];
      if (query.text.includes('SELECT DISTINCT host FROM source_admission')) return [];
      if (query.text.startsWith('SELECT source_url, last_error')) return [];
      if (query.text.startsWith('SELECT source_url AS url, name')) return [{ ...zeroCounts }];
      if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
      return [];
    });
    fetchMock.mockImplementation(async (input, options) => {
      const url = String(input);
      if (url === admissionSearchUrl) {
        expect(options?.redirect).toBe('manual');
        return new Response('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>', { status: 200 });
      }
      expect(options?.redirect).toBe('manual');
      const fixture = responses.get(url);
      if (!fixture) throw new Error(`Unexpected network request: ${url}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });

    await refreshShuyuan();

    // 证据 1：即便库里是 compile 拒行，本轮仍读了 source_admission 既有行
    // （说明批次跑了，源没被候选池过滤掉）。
    const readExisting = execute.mock.calls.find(([query]) =>
      query.text.startsWith('SELECT source_url, tier, compile_ok'));
    expect(readExisting).toBeDefined();
    // 证据 2：本轮对该源重新探测（compile-ok 后 search_ok=null ⇒ 未测优先）——
    // 既有行 rules_hash 与候选一致（终态去抖只拦「仍然拒」，不拦「救回后待测」）。
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(admissionSearchUrl);
    // 证据 3：救回结论写库（compile_ok=true 行 upsert）。
    expect(execute.mock.calls.some(([query]) => query.text.includes('INSERT INTO source_admission'))).toBe(true);
  });

  // 41-srcfix G5：源规则改到过不了 survey 初筛（这里加 <js>）⇒ 改前 runAdmissionAfterRefresh 直接跳过它，
  // 既有 ok 行永久冻结、池 JOIN 照样命中、带 JS 的新规则以 ok 身份留池。改后送回批次改判 T7 出池。
  describe('41-srcfix G5：初筛不过的源其 compile_ok 旧行改判出池', () => {
    const frozenUrl = 'https://frozen.example';
    const frozenSource = {
      ...admissionCandidate, bookSourceUrl: `${frozenUrl}/`, bookSourceName: '改坏的源',
      searchUrl: `${frozenUrl}/s?q={{key}}`,
      ruleContent: { content: '.c<js>result</js>' },
    };
    const admissionRow = (over: Record<string, unknown>) => ({
      source_url: frozenUrl, tier: 'M1', compile_ok: true, core_field_mask: {},
      search_ok: true, search_verdict: 'ok', search_checked_at: '2026-09-20T00:00:00Z',
      rules_hash: rulesHash({ ...frozenSource, ruleContent: { content: '.c' } }), engine_semantics_version: 1,
      host: 'frozen.example', error: '', compile_diagnostics: [], ...over,
    });
    const runWith = async (existingRow: Record<string, unknown>) => {
      setCollection(11, [frozenSource]);
      execute.mockImplementation(async (query) => {
        if (query.text.startsWith('SELECT count(*)')) return [zeroCounts];
        if (query.text.startsWith('INSERT INTO cron_health') && query.values[0] === ADMISSION_LEASE_ROW) {
          return [{ name: ADMISSION_LEASE_ROW, generation: '1' }]; // admlfix42：刷新尾部无条件领约，默认领到。
        }
        if (query.text.startsWith('SELECT source_url, tier, compile_ok')) return [existingRow];
        if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
        return [];
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await refreshShuyuan();
      const insert = execute.mock.calls.find(([query]) => query.text.includes('INSERT INTO source_admission'));
      return insert ? JSON.parse(insert[0].values[2] as string) as Record<string, unknown>[] : undefined;
    };

    it('既有 ok 行 + 新规则初筛不过 ⇒ 写 T7 compile_ok=false、search_ok=null（出池、出 host 门），不发搜索', async () => {
      const payload = await runWith(admissionRow({}));
      expect(payload).toEqual([expect.objectContaining({
        source_url: frozenUrl, tier: 'T7', compile_ok: false, search_ok: null,
        rules_hash: rulesHash(frozenSource), error: expect.stringContaining('survey'),
      })]);
      // 读既有行时带上了这个非候选 URL。
      const read = execute.mock.calls.find(([query]) => query.text.startsWith('SELECT source_url, tier, compile_ok'))!;
      expect(String(read[0].values[0])).toContain(frozenUrl);
      expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.startsWith(frozenUrl))).toBe(false);
    });

    it('既有 compile_ok=true 未测僵尸行（search_ok=null）同样改判 T7', async () => {
      const payload = await runWith(admissionRow({ search_ok: null, search_verdict: '', search_checked_at: null }));
      expect(payload).toEqual([expect.objectContaining({ source_url: frozenUrl, tier: 'T7', compile_ok: false })]);
    });

    it('既有行已是 compile_ok=false ⇒ 不送批次、不重写（终态去抖，不放大写库）', async () => {
      const payload = await runWith(admissionRow({ tier: 'T7', compile_ok: false, search_ok: null, search_verdict: '' }));
      expect(payload).toEqual([]);
    });
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
      expect(options?.redirect).toBe('manual');
      const fixture = responses.get(String(input));
      if (!fixture) throw new Error(`Unexpected network request: ${String(input)}`);
      return new Response(fixture.body, { status: fixture.status ?? 200 });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await refreshShuyuan();

    // 预算剩余 5s < ADMISSION_MIN_BUDGET_MS(10s)：整批跳过，零准入 DB 往返、零搜索请求。
    expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      indexUrl, collectionUrl(11), collectionUrl(12), collectionUrl(13),
    ]);
    expect(transaction).toHaveBeenCalledOnce();
    // S3-3：跳过不再静默——沿用 admission batch log 形状记一行，带 skipped:'budget' 与剩余毫秒数。
    // 没有这行，连续几轮预算不够只会表现为「刷新 200、池健康度全绿、准入数据无限期陈旧」。
    expect(log).toHaveBeenCalledWith('shuyuan admission batch', expect.objectContaining({
      sources: 1, skipped: 'budget', remainingMs: expect.any(Number),
    }));
    expect((log.mock.calls.at(-1)![1] as { remainingMs: number }).remainingMs)
      .toBeLessThanOrEqual(ADMISSION_MIN_BUDGET_MS);
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
        classification_source: unknownSource,
        last_error: '历史连接超时', checked_at: null, probe_error: null,
      }]);
    expect(await getShuyuanStats()).toEqual({
      ...zeroCounts, total: 1, disabled: 1, unprobed: 1, collections, refreshedAt: null, sourcesLimit: 100,
      sources: [{ url: unknownSource.bookSourceUrl, name: '未知源', disabled: true, availability: 'unprobed',
        lastError: '历史连接超时', checkedAt: null, probeError: null, adultClassification: 'unmarked' }],
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

  it.each(['all', 'unprobed'] as const)('管理名册%s保留三态行，仅返回分类而不返回规则', async (filter) => {
    const raw = Object.freeze({ bookSourceName: '普通名称', bookSourceGroup: '文学🔞',
      headers: { 'X-Synthetic-Private': 'synthetic-header' }, ruleSearch: { name: 'synthetic-rule' } });
    const base = { disabled: false, availability: 'unprobed', last_error: '', checked_at: null, probe_error: null };
    const rows = [
      { ...base, url: 'https://adult.example/', name: '标记源', classification_source: raw },
      { ...base, url: 'https://invalid.example/', name: '无效源', disabled: true, classification_source: [] },
      { ...base, url: 'https://ordinary.example/', name: '普通源', classification_source: { bookSourceGroup: null } },
    ];
    const counts = { ...zeroCounts, total: 3, enabled: 2, disabled: 1, unprobed: 3 };
    execute.mockResolvedValueOnce([{ collections: [], refreshed_at: null }])
      .mockResolvedValueOnce([counts]).mockResolvedValueOnce(rows);
    const result = await getShuyuanStats(undefined, { filter, page: 1 });
    expect(result.total).toBe(3);
    expect(result.enabled).toBe(2);
    expect(result.disabled).toBe(1);
    expect(result.sources.map((source) => source.url)).toEqual(rows.map((row) => row.url));
    expect(result.sources.map((source) => source.adultClassification)).toEqual(['adult', 'invalid', 'unmarked']);
    expect(result.sources.map((source) => source.availability)).toEqual(['unprobed', 'unprobed', 'unprobed']);
    for (const source of result.sources) {
      expect(Object.keys(source).sort()).toEqual(['adultClassification', 'availability', 'checkedAt', 'disabled', 'lastError', 'name', 'probeError', 'url']);
    }
    expect(JSON.stringify(result)).not.toContain('synthetic-header');
    expect(JSON.stringify(result)).not.toContain('synthetic-rule');
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(await getReadingSources(new AbortController().signal)).toMatchObject([{ url: 'https://builtin.test/', name: '支持的来源' }]);
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('合集没有该 host 记录时不补造注册表默认源：空段是合法结论（不隐式启用）', async () => {
    execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]);
    // 删除记录不构成隐式启用信号——活跃内建源必须经显式注册/启用行进池。
    expect(await getReadingSources(new AbortController().signal)).toEqual([]);
  });

  it('已注册的活跃内建源行（零历史探测态）照常合成 builtin 池条目', async () => {
    execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([
      { ...oldSource(knownSource), disabled_at: null, name: '支持的来源' },
    ]);
    expect(await getReadingSources(new AbortController().signal)).toMatchObject([
      { url: 'https://builtin.test/', tier: 'builtin' },
    ]);
  });

  // M1 任务 4 §5.2/§[M2]6.1：注册表合成视图。builtin 恒在前；引擎源并入**受 kill switch 约束**
  // （READING_ENGINE_SOURCES 默认开，可显式关闭）；启用后 = admission ok ∧ 非 disabled
  // ∧ probe 非 failed，且 host 必须已在运行时门集合内（冷启动 fail-closed，不 500）。
  describe('注册表合成视图（M1 任务 4 + M2-3 kill switch）', () => {
    const engineItem = {
      bookSourceUrl: 'https://engine.example/', bookSourceName: '引擎源',
      searchUrl: 'https://engine.example/s?q={{key}}',
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.ch', chapterName: 'a@text' },
      ruleContent: { content: '.c' },
    };
    const engineRow = (over: Record<string, unknown> = {}) => ({
      source_url: 'https://engine.example', source: engineItem, name: '引擎源',
      disabled_at: null, last_error: '', tier: 'M1', ...over,
    });
    afterEach(() => refreshSupportedHosts([])); // 复位运行时 host 集合

    // 池合成用例共用：已注册的活跃 builtin 行（真实注册表里 book15 已退休，注册表合成
    // 只认「显式注册的活跃内建行」；这里 mock 的是合成注册表的 builtin.test 行，见顶部 vi.mock）。
    const builtinRegisteredRow = [{ ...oldSource(knownSource), disabled_at: null, name: 'builtin.test' }];

    it.each<{ raw: string | undefined; expected: boolean }>([
      { raw: undefined, expected: true }, { raw: '', expected: true }, { raw: ' \t\n', expected: true },
      { raw: '1', expected: true }, { raw: 'true', expected: true }, { raw: 'on', expected: true },
      { raw: ' TrUe ', expected: true }, { raw: ' ON ', expected: true },
      { raw: '0', expected: false }, { raw: 'false', expected: false }, { raw: 'off', expected: false },
      { raw: ' FaLsE ', expected: false }, { raw: ' OFF ', expected: false },
      { raw: '2', expected: false }, { raw: 'yes', expected: false }, { raw: 'enabled', expected: false },
      { raw: 'null', expected: false }, { raw: 'true,false', expected: false },
    ])('阅读引擎开关解析 $raw → $expected', ({ raw, expected }) => {
      vi.stubEnv('READING_ENGINE_SOURCES', raw);
      expect(engineSourcesEnabled()).toBe(expected);
      expect(execute).not.toHaveBeenCalled();
    });

    it('默认（未设 READING_ENGINE_SOURCES）并入通过准入与可用性检查的引擎源', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', undefined);
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin', 'M1']);
      expect(sources[0].url).toBe('https://builtin.test/');
      expect(sources[1].rules).toBe(engineItem);
      expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(true);
    });

    it('READING_ENGINE_SOURCES=0 显式关闭：不并入引擎源、不查准入表', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '0');
      refreshSupportedHosts(['engine.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow);
      expect((await getReadingSources(new AbortController().signal)).map((source) => source.tier)).toEqual(['builtin']);
      expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(false);
    });

    it('READING_ENGINE_SOURCES=1 且 host 未就绪（冷启动）时引擎源仍不出池，不 500', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      // 冷启动：engineHosts（池合成前先刷门，故是第一条 SQL）读到空 ⇒ 运行时门保持内建单集合；
      // 即便准入表里有该源的 ok 行（engineReadingSources 仍返回它），validateSourceUrl 也过不了门 ⇒ 出池。
      execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin']);
      expect(sources[0].url).toBe('https://builtin.test/');
    });

    it('READING_ENGINE_SOURCES=1 + host 就绪（门随池刷）：builtin 在前、引擎源在后，rules 原对象透传', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      // host 就绪来自 DB：engineHosts 读到 ok 态 host ⇒ getReadingPool 内先刷运行时门，再查引擎源。
      // 不再靠测试手动 refreshSupportedHosts——正是本改动要证明的「门随池按 DB 实况刷」。
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin', 'M1']);
      expect(sources[1]).toMatchObject({
        url: 'https://engine.example/', searchUrl: 'https://engine.example/s?q={{key}}', tier: 'M1',
      });
      // m2-scaleout §5.2 第 1 条：rules 必须与 shuyuan_sources.source 同一对象（不裁剪）。
      expect(sources[1].rules).toBe(engineItem);
      // §6.1 核心断言：池合成后运行时 host 门已含该引擎 host（validateSourceUrl 能过）。
      expect(validateSourceUrl('https://engine.example/x').href).toBe('https://engine.example/x');
    });

    it.each(['database', 'artifact'] as const)('共用引擎池在%s取行后剔除成人/损坏元数据，普通规则原样保留', async (mode) => {
      vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
      refreshSupportedHosts(['ordinary.example', 'adult.example', 'invalid.example']);
      fetchMock.mockImplementation(async () => { throw new Error('Unexpected synthetic network call'); });
      const ordinary = Object.freeze({ ...engineItem,
        bookSourceName: '普通漫画听书外文', bookSourceGroup: null,
        searchUrl: 'https://ordinary.example/s?q={{key}}',
      });
      const rows = [
        engineRow({ source_url: 'https://ordinary.example/', name: null, source: ordinary }),
        engineRow({ source_url: 'https://adult.example/group', name: '普通', source: { ...engineItem, bookSourceGroup: '文学|🔞' } }),
        engineRow({ source_url: 'https://adult.example/raw-name', name: '普通', source: { ...engineItem, bookSourceName: '🈲合集' } }),
        engineRow({ source_url: 'https://adult.example/name', name: '成人小说', source: engineItem }),
        engineRow({ source_url: 'https://invalid.example/', name: '🔞', source: { ...engineItem, bookSourceGroup: 7 } }),
        engineRow({ source_url: 'https://invalid.example/array', name: '普通', source: [] }),
        engineRow({ source_url: 'https://ordinary.example/disabled', name: '普通', source: ordinary, disabled_at: '2026-01-01' }),
      ];
      const before = JSON.stringify(rows);
      const enabled = vi.spyOn(poolArtifacts, 'poolArtifactEnabled').mockReturnValue(mode === 'artifact');
      const current = vi.spyOn(poolArtifacts, 'currentPoolArtifact').mockResolvedValue({
        engine: rows, probe: { version: 1, entries: [] }, refreshedAt: null,
      } as unknown as Awaited<ReturnType<typeof poolArtifacts.currentPoolArtifact>>);
      if (mode === 'database') {
        execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(rows);
      } else {
        execute.mockRejectedValue(new Error('Unexpected DB access with synthetic artifact'));
      }
      try {
        const sources = await getEngineSources(new AbortController().signal);
        expect(sources.map((source) => source.url)).toEqual(['https://ordinary.example/']);
        expect(sources[0].name).toBe('ordinary.example');
        expect(sources[0].rules).toBe(ordinary);
        expect(JSON.stringify(rows)).toBe(before);
        expect(enabled).toHaveBeenCalled();
        if (mode === 'artifact') {
          expect(current).toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        } else {
          expect(current).not.toHaveBeenCalled();
          expect(execute.mock.calls.some(([query]) => query.text.includes('JOIN LATERAL ('))).toBe(true);
        }
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        refreshSupportedHosts([]);
      }
    });

    it('READING_POOL_LIMIT 约束池大小（波次开关，默认 4）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '1');
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce([engineRow()]);
      // 上限 1 ⇒ 只剩 builtin 首源（builtin 恒在前，引擎源被截断）。
      expect((await getReadingSources(new AbortController().signal)).map((source) => source.tier)).toEqual(['builtin']);
    });

    it('引擎源查询失败时降级为 builtin 单源，不 500（零回归）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      // engineHosts 成功刷门（第一条 SQL）、engineReadingSources（JOIN 查询）失败 ⇒ 降级 builtin-only。
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow)
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

    it.each([
      { name: 'admitted', row: {}, failed: false, allowed: true },
      { name: 'disabled', row: { disabled_at: '2026-09-20T00:00:00Z' }, failed: false, allowed: false },
      { name: 'rule disabled', row: { source: { ...engineItem, enabled: false } }, failed: false, allowed: false },
      { name: 'failed probe', row: {}, failed: true, allowed: false },
    ])('T6 download capability follows T4 engine pool: $name', async ({ row, failed, allowed }) => {
      execute.mockResolvedValueOnce([{ host: 'engine.example' }])
        .mockResolvedValueOnce([{ collections: [{ id: 1, title: 'fixture', count: 1, probeSnapshot: { version: 1, entries: [
          { url: 'https://engine.example', status: failed ? 'failed' : 'reachable', checked_at: '2026-09-20T00:00:00Z' },
        ] } }] }])
        .mockResolvedValueOnce([engineRow(row)]);
      const result = resolveDownloadSource('https://engine.example/book/1');
      if (allowed) {
        expect(await result).toEqual({ url: 'https://engine.example/book/1', kind: 'engine', id: 'https://engine.example/',
          revision: sourceRevision({ url: 'https://engine.example/', searchUrl: engineItem.searchUrl, rules: engineItem }) });
      } else await expect(result).rejects.toThrow('不支持全书下载');
      expect(execute.mock.calls.at(-1)![0].text).toContain('ad.compile_ok AND ad.search_ok IS TRUE');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('T6 builtin download requires a registered row but no engine admission query', async () => {
      vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow);
      expect(await resolveDownloadSource('https://builtin.test/book/1')).toMatchObject({kind: 'builtin'});
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(false);
      execute.mockResolvedValueOnce([]);
      await expect(resolveDownloadSource('https://engine.example/book/1')).rejects.toThrow(SourcePolicyError);
    });

    it.each(['missing', 'disabled', 'rule-disabled', 'failed', 'pool-error', 'active'] as const)(
      '641 builtin registration gate and both real TS entrypoints: %s', async (state) => {
        vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
        refreshSupportedHosts([]);
        const registered = { ...builtinRegisteredRow[0], source: { ...knownSource, enabled: state !== 'rule-disabled' },
          disabled_at: state === 'disabled' ? oldDisabledAt : null };
        execute.mockImplementation(async (query) => {
          if (state === 'pool-error') throw new Error('synthetic pool unavailable');
          if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [{ id: 1, title: 'synthetic', count: 1,
            probeSnapshot: { version: 1, entries: [{ url: knownSource.bookSourceUrl,
              status: state === 'failed' ? 'failed' : 'reachable', checked_at: '2026-09-20T00:00:00Z' }] } }] }];
          if (query.text.includes('FROM shuyuan_sources')) return state === 'missing' ? [] : [registered];
          throw new Error('Unexpected registration query');
        });
        const signal = new AbortController().signal;
        const actual = await getBuiltinRequestSource('builtin.test', signal);
        const web = () => resolveDownloadSource('https://builtin.test/book/1');
        const runtime = () => createResolveSource(assembleEngineModules())(null, 'https://builtin.test/book/1', signal);
        if (state === 'active') {
          expect(actual).toMatchObject({ url: 'https://builtin.test/', tier: 'builtin' });
          expect(actual?.rules).toBe(registered.source);
          await expect(web()).resolves.toMatchObject({ kind: 'builtin' });
          await expect(runtime()).resolves.toMatchObject({ builtin: true, source: actual });
        } else {
          expect(actual).toBeNull();
          await expect(web()).rejects.toThrow(SourcePolicyError);
          await expect(runtime()).rejects.toMatchObject({ code: 2, reason: 'builtin_source_unavailable' });
        }
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(['builtin.test', 'www.builtin.test', 'builtin.test.', 'www.builtin.test.'])(
      '641 aliases select the actual registered source, never registry slot zero: %s', async (host) => {
        vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
        refreshSupportedHosts(['www.builtin.test']);
        execute.mockImplementation(async (query) => {
          if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [] }];
          if (query.text.includes('FROM shuyuan_sources')) return builtinRegisteredRow;
          throw new Error('Unexpected registration query');
        });
        const signal = new AbortController().signal;
        const result = await getBuiltinRequestSource(host, signal);
        expect(result).toMatchObject({ url: 'https://builtin.test/', name: 'builtin.test' });
        const runtime = await createResolveSource(assembleEngineModules())(null, `https://${host}/book/1`, signal);
        expect(runtime.source).toEqual(result);
        expect(runtime.source.url).not.toContain('book15');
        await expect(resolveDownloadSource(`https://${host}/book/1`)).resolves.toMatchObject({
          kind: 'builtin', url: `https://${host.replace(/\.$/, '')}/book/1`,
        });
        expect(await getBuiltinRequestSource('unregistered.example', signal)).toBeNull();
        expect(await getBuiltinRequestSource('book15.net', signal)).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('/api/stats 的 readingPoolSize 在默认开关下为 1', async () => {
      const refreshedAt = '2026-09-19T00:00:00Z';
      // refreshed_at（meta）→ 池（poolProbeMeta + builtinRows）→ 准入漏斗，Promise.all 并发按文本分派。
      execute.mockImplementation(async (query) => {
        if (query.text.includes('SELECT refreshed_at::text AS refreshed_at FROM shuyuan_meta')) {
          return [{ refreshed_at: refreshedAt }];
        }
        if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [] }];
        if (query.text.includes('FROM shuyuan_sources')) return builtinRegisteredRow;
        if (query.text.includes('FROM source_admission')) return [];
        return [];
      });
      const health = await getShuyuanPoolHealth(new AbortController().signal);
      expect(health.readingPoolSize).toBe(1);
      expect(health.refreshedAtAgeHours).toBeGreaterThanOrEqual(0);
    });

    // ---------------------------------------------------------------- M2-3 §2.4 排序全序 / §2.3 池上限 / §6.3 观测
    const engineItemAt = (host: string) => ({
      bookSourceUrl: `https://${host}/`, bookSourceName: host,
      searchUrl: `https://${host}/s?q={{key}}`,
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.ch', chapterName: 'a@text' },
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
      execute.mockResolvedValueOnce(['a.example', 'b.example', 'c.example', 'd.example', 't7.example'].map((host) => ({ host })))
        .mockResolvedValueOnce([reachableMeta('https://b.example')]).mockResolvedValueOnce(builtinRegisteredRow)
        .mockResolvedValueOnce([
          engineRowAt('a.example', { search_checked_at: '2026-09-01T00:00:00Z' }),
          engineRowAt('b.example', { search_checked_at: '2026-09-01T00:00:00Z' }), // reachable，应最先
          engineRowAt('c.example', { search_checked_at: '2026-09-20T00:00:00Z' }),
          engineRowAt('d.example', { search_checked_at: '2026-09-20T00:00:00Z' }), // 与 c 同刻，url 靠后
          engineRowAt('t7.example', { tier: 'T7', search_checked_at: '2026-09-30T00:00:00Z' }), // tier 最晚
        ]);
      const { sources } = await getReadingPool(new AbortController().signal);
      expect(sources.map((source) => source.url)).toEqual([
        'https://builtin.test/', // builtin 恒 index 0
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
      const builtinRow = { source_url: 'https://builtin.test', source: { bookSourceUrl: 'https://builtin.test', searchUrl: 'https://builtin.test/s?kw={{key}}', enabled: true }, name: 'builtin', disabled_at: null, last_error: '' };
      // ① builtin probe=failed ⇒ 被剔除，reachable 的引擎源递补到 index 0。
      const failedMeta = { collections: [{ id: 1, title: '合集', count: 1, probeSnapshot: { version: 1, entries: [
        { url: 'https://builtin.test', status: 'failed', checked_at: '2026-09-18T00:00:00Z' },
      ] } }] };
      execute.mockResolvedValueOnce([{ host: 'engine.example' }])
        .mockResolvedValueOnce([failedMeta]).mockResolvedValueOnce([builtinRow])
        .mockResolvedValueOnce([engineRow({ search_checked_at: '2026-09-18T00:00:00Z' })]);
      const absent = await getReadingSources(new AbortController().signal);
      expect(absent.map((source) => source.tier)).toEqual(['M1']);
      expect(absent[0].url).toBe('https://engine.example/');
      // ② builtin 在场（即使引擎源 reachable）⇒ builtin 恒 index 0，引擎源靠后。
      execute.mockResolvedValueOnce([{ host: 'engine.example' }])
        .mockResolvedValueOnce([reachableMeta('https://engine.example')]).mockResolvedValueOnce([builtinRow])
        .mockResolvedValueOnce([engineRow({ search_checked_at: '2026-09-18T00:00:00Z' })]);
      const present = await getReadingSources(new AbortController().signal);
      expect(present.map((source) => source.tier)).toEqual(['builtin', 'M1']);
      expect(present[0].url).toBe('https://builtin.test/');
    });

    it('READING_POOL_LIMIT 生效且 poolCandidates 计数正确（§2.3 放行判据）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      const hostRows = ['a.example', 'b.example', 'c.example', 'd.example'].map((host) => ({ host }));
      const engineRows = ['a.example', 'b.example', 'c.example', 'd.example'].map((host) => engineRowAt(host));
      // 已注册的活跃 builtin 行 + 引擎(4) = 候选 5。上限 3 ⇒ 池 3、截断 2、其中引擎 2。
      const builtinRegistered = () => execute.mockResolvedValueOnce(hostRows)
        .mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce([{ ...oldSource(knownSource), disabled_at: null, name: 'builtin' }])
        .mockResolvedValueOnce(engineRows);
      vi.stubEnv('READING_POOL_LIMIT', '3');
      builtinRegistered();
      await expect(getReadingPool(new AbortController().signal)).resolves.toMatchObject({
        enginePoolSize: 2, poolCandidates: 2,
      });
      // 上限 6 ≥ 候选 5 ⇒ 放量空间为 0（W1：1 builtin + 4 引擎正好填不满 6）。
      vi.stubEnv('READING_POOL_LIMIT', '6');
      builtinRegistered();
      await expect(getReadingPool(new AbortController().signal)).resolves.toMatchObject({
        enginePoolSize: 4, poolCandidates: 0,
      });
    });

    // 41-fanout：扇出候选 = 取书池同一合成与全序，只换截断上限；引擎源不受 READING_ENGINE_SOURCES 约束。
    // 41-readall：readable 不再看取书池位次（确认/章节路径改按 getSourcePools().selectable 反查），只看引擎开关。
    it('getFanoutPool：引擎开关关时仍含准入 ok 的引擎源、readable 只标 builtin；SOURCE_FANOUT_LIMIT 截断并夹上限', async () => {
      const hosts = ['a.example', 'b.example', 'c.example'];
      const arrange = () => execute.mockResolvedValueOnce(hosts.map((host) => ({ host })))
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow)
        .mockResolvedValueOnce(hosts.map((host) => engineRowAt(host)));
      arrange();
      const pool = await getFanoutPool(new AbortController().signal);
      expect(pool.map((source) => [source.url, source.tier, source.readable])).toEqual([
        ['https://builtin.test/', 'builtin', true],
        ['https://a.example/', 'M1', false],
        ['https://b.example/', 'M1', false],
        ['https://c.example/', 'M1', false],
      ]);
      // 引擎开关开 + 取书池上限 2 ⇒ 全序第 3 位（取书池外）也 readable（41-readall，改前是 [true, true, false]）；
      // fanbatch42：getFanoutPool 不再按 SOURCE_FANOUT_LIMIT 截断（「换一批」翻页由 route 按批切片），
      // 全量同站去重序 4 条全出，readable 只看引擎开关。
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '2');
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '3');
      arrange();
      expect((await getFanoutPool(new AbortController().signal)).map((source) => source.readable)).toEqual([true, true, true, true]);
      // 误配 999 ⇒ 夹到 MAX 60（每批切片口径）；全量池照旧全出。
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '999');
      arrange();
      expect(await getFanoutPool(new AbortController().signal)).toHaveLength(4);
    });

    // 41-readall：一次合成两份池。traversal（自动遍历）逐条等于 getReadingSources；selectable（用户指定源的反查范围）
    // 上限取 max(取书池, 扇出)、开关关时只剩 builtin；扇出里 readable 的源必在 selectable 内（面板可切 ⇔ 确认认得）。
    it('getSourcePools：traversal=取书池前缀、selectable=max(R,F) 截断；readable 与 selectable 同口径', async () => {
      const hosts = ['a.example', 'b.example', 'c.example', 'd.example'];
      const arrange = () => execute.mockResolvedValueOnce(hosts.map((host) => ({ host })))
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow)
        .mockResolvedValueOnce(hosts.map((host) => engineRowAt(host)));
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '2');
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '4');
      arrange();
      const pools = await getSourcePools(new AbortController().signal);
      expect(pools.traversal.map((source) => source.url)).toEqual(['https://builtin.test/', 'https://a.example/']);
      // fanbatch42：selectable 并入全量扇出序（不再只有前缀窗口 max(R,F)）——「换一批」翻得到的源都得认得。
      expect(pools.selectable.map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/',
      ]);
      arrange();
      expect((await getReadingSources(new AbortController().signal)).map((source) => source.url))
        .toEqual(pools.traversal.map((source) => source.url));
      arrange();
      const fanout = await getFanoutPool(new AbortController().signal);
      const selectableUrls = new Set(pools.selectable.map((source) => source.url));
      expect(fanout.filter((source) => source.readable).every((source) => selectableUrls.has(source.url))).toBe(true);
      expect(fanout.every((source) => source.readable)).toBe(true);
      // 取书池比扇出大（READING_POOL_LIMIT 调高）⇒ selectable 仍覆盖整个取书池：自动遍历能交付的源，确认都认得。
      vi.stubEnv('READING_POOL_LIMIT', '5');
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '2');
      arrange();
      const wide = await getSourcePools(new AbortController().signal);
      expect(wide.traversal).toHaveLength(5);
      expect(wide.selectable.map((source) => source.url)).toEqual(wide.traversal.map((source) => source.url));
      // 引擎开关关 ⇒ selectable 只剩 builtin，且不查准入表（只读 meta + builtin 两次查询）；非合格源进不来。
      vi.stubEnv('READING_ENGINE_SOURCES', '0');
      execute.mockClear();
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow);
      const off = await getSourcePools(new AbortController().signal);
      expect(off.selectable.map((source) => source.tier)).toEqual(['builtin']);
      expect(off.traversal.map((source) => source.tier)).toEqual(['builtin']);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    // 41-srcfix 同站去重：同站多副本同一轮测完、checked_at 挨着，改前会把取书池名额占成同一个站。
    it('41-srcfix 同站去重：traversal 同 host 只留全序最前一份；selectable 不去重（在读副本仍认得）；traversal ⊆ selectable', async () => {
      const rows = [
        engineRowAt('dup.example', { source_url: 'https://dup.example/a', search_checked_at: '2026-09-24T00:00:00Z' }),
        engineRowAt('dup.example', { source_url: 'https://dup.example/b', search_checked_at: '2026-09-23T00:00:00Z' }),
        engineRowAt('dup.example', { source_url: 'https://dup.example/c', search_checked_at: '2026-09-22T00:00:00Z' }),
        engineRowAt('x.example', { search_checked_at: '2026-09-20T00:00:00Z' }),
      ];
      const arrange = () => execute.mockResolvedValueOnce([{ host: 'dup.example' }, { host: 'x.example' }])
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce(rows);
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '3');
      arrange();
      const pools = await getSourcePools(new AbortController().signal);
      // 改前：[book15, dup/a, dup/b] —— 3 个名额里 2 个是同一个站，x.example 自动遍历永远轮不到。
      expect(pools.traversal.map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://dup.example/a', 'https://x.example/',
      ]);
      expect(pools.selectable.map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://dup.example/a', 'https://dup.example/b', 'https://dup.example/c', 'https://x.example/',
      ]);
      arrange();
      await expect(getReadingPool(new AbortController().signal)).resolves.toMatchObject({
        sources: pools.traversal, enginePoolSize: 2, poolCandidates: 2,
      });
      // 41-swq：扇出同站去重，与 traversal 同口径选中 dup/a（改前 = selectable 全部 5 条）。
      arrange();
      expect((await getFanoutPool(new AbortController().signal)).map((source) => source.url))
        .toEqual(['https://builtin.test/', 'https://dup.example/a', 'https://x.example/']);
      // 窗口：selectable 只到 max(R,F)=3 条 ⇒ traversal 不越窗去捞 x.example（否则首开选中的源章节路径认不回来）。
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '2');
      arrange();
      const narrow = await getSourcePools(new AbortController().signal);
      const selectableUrls = new Set(narrow.selectable.map((source) => source.url));
      expect(narrow.traversal.map((source) => source.url)).toEqual(['https://builtin.test/', 'https://dup.example/a']);
      expect(narrow.traversal.every((source) => selectableUrls.has(source.url))).toBe(true);
    });

    // 41-swq 扇出同站去重：生产快照里梧桐 4 份规则占 24 格中的 4 格（url 的 #片段被抹掉，4 行还探同一条规则），
    // 去重后同站只留全序最前一份，腾出的名额按全序补给后面的站；总数仍受 SOURCE_FANOUT_LIMIT 约束。
    it('41-swq 扇出同站去重：同 host 留全序最优一份（reachable 优先）、名额回填后续站、上限不变、越窗补位的源仍在 selectable', async () => {
      const rows = [
        engineRowAt('dup.example', { source_url: 'https://dup.example/a', search_checked_at: '2026-09-24T00:00:00Z' }),
        engineRowAt('dup.example', { source_url: 'https://dup.example/b', search_checked_at: '2026-09-23T00:00:00Z' }),
        engineRowAt('dup.example', { source_url: 'https://dup.example/c', search_checked_at: '2026-09-20T00:00:00Z' }),
        engineRowAt('dup.example', { source_url: 'https://dup.example/t7', tier: 'T7', search_checked_at: '2026-09-25T00:00:00Z' }),
        engineRowAt('y.example', { search_checked_at: '2026-09-19T00:00:00Z' }),
        engineRowAt('z.example', { search_checked_at: '2026-09-18T00:00:00Z' }),
        engineRowAt('w.example', { search_checked_at: '2026-09-17T00:00:00Z' }),
      ];
      const hosts = ['dup.example', 'y.example', 'z.example', 'w.example'];
      // dup/c 探测 reachable ⇒ 全序里排在同站其余副本之前（健康度是首键），去重应选它而不是 checked_at 最新的 a。
      const arrange = () => execute.mockResolvedValueOnce(hosts.map((host) => ({ host })))
        .mockResolvedValueOnce([reachableMeta('https://dup.example/c')]).mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce(rows);
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '2');
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '3');
      arrange();
      const fanout = await getFanoutPool(new AbortController().signal);
      // 改前：[book15, dup/c, dup/a] —— 3 格里 2 格是同一个站。fanbatch42：扇出不再截断,
      // 全量同站去重序 5 条（builtin + 4 站）全出,「换一批」翻页由 route 按 3/批切片。
      expect(fanout.map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://dup.example/c', 'https://y.example/', 'https://z.example/', 'https://w.example/',
      ]);
      expect(fanout.every((source) => source.readable)).toBe(true);
      // fanbatch42：selectable 并入全量扇出序——z/w 在窗口外且被同站去重挤掉,但「换一批」翻得到 ⇒ 必须认得。
      arrange();
      const pools = await getSourcePools(new AbortController().signal);
      expect(pools.selectable.map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://dup.example/c', 'https://dup.example/a', 'https://y.example/',
        'https://z.example/', 'https://w.example/',
      ]);
      expect(pools.traversal.map((source) => source.url)).toEqual(['https://builtin.test/', 'https://dup.example/c']);
      // 上限放宽 ⇒ 每站一格全部列出，T7 副本与其余同站副本都不出现；总数 = 1 builtin + 4 站。
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '24');
      arrange();
      expect((await getFanoutPool(new AbortController().signal)).map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://dup.example/c', 'https://y.example/', 'https://z.example/', 'https://w.example/',
      ]);
    });

    // 41-swq 审查 §2.1：apex 与 www 是同一个站（与 source-host-health hostKey 同口径），去重不能让两份各占一格。
    it('41-swq 扇出同站去重：apex ↔ www 算同站，只留全序最优一份', async () => {
      const rows = [
        engineRowAt('www.dup.example', { search_checked_at: '2026-09-24T00:00:00Z' }),
        engineRowAt('dup.example', { search_checked_at: '2026-09-23T00:00:00Z' }),
        engineRowAt('y.example', { search_checked_at: '2026-09-19T00:00:00Z' }),
        engineRowAt('www.z.example', { search_checked_at: '2026-09-18T00:00:00Z' }),
      ];
      const hosts = ['www.dup.example', 'dup.example', 'y.example', 'www.z.example'];
      execute.mockResolvedValueOnce(hosts.map((host) => ({ host })))
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce(rows);
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '2');
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '24');
      // 改前：www.dup.example 与 dup.example 各占一格。
      expect((await getFanoutPool(new AbortController().signal)).map((source) => source.url)).toEqual([
        'https://builtin.test/', 'https://www.dup.example/', 'https://y.example/', 'https://www.z.example/',
      ]);
    });

    // 41-swq：sfacg 规则的 searchUrl 指向 host 门外的 m.sfacg.com，准入却记 search_ok；去重腾出名额后补进扇出、每次
    // probe 必 compile_failed。判据与 probe 同一处（source-usability），进池前筛掉。
    it('41-swq 运行时用不了的引擎源（门外/动态搜索模板、必需字段缺失）进池前筛掉：不占扇出/取书池/窗口名额，同站后面能用的那份照样选上', async () => {
      const offGate = (url: string, over: Record<string, unknown> = {}) => engineRowAt('dup.example', {
        source_url: url, source: { ...engineItemAt('dup.example'), searchUrl: 'https://outside.example/s?q={{key}}' }, ...over,
      });
      const noContent: Record<string, unknown> = { ...engineItemAt('nocontent.example') };
      delete noContent.ruleContent;
      const rows = [
        offGate('https://dup.example/bad', { search_checked_at: '2026-09-25T00:00:00Z' }),
        engineRowAt('dup.example', { source_url: 'https://dup.example/good', search_checked_at: '2026-09-24T00:00:00Z' }),
        engineRowAt('lone.example', { source_url: 'https://lone.example/', source: { ...engineItemAt('lone.example'), searchUrl: '@js:result' }, search_checked_at: '2026-09-23T00:00:00Z' }),
        engineRowAt('nocontent.example', { source: noContent, search_checked_at: '2026-09-22T00:00:00Z' }),
        engineRowAt('y.example', { search_checked_at: '2026-09-19T00:00:00Z' }),
      ];
      const hosts = ['dup.example', 'lone.example', 'nocontent.example', 'y.example'];
      const arrange = () => execute.mockResolvedValueOnce(hosts.map((host) => ({ host })))
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow).mockResolvedValueOnce(rows);
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      vi.stubEnv('READING_POOL_LIMIT', '3');
      vi.stubEnv('SOURCE_FANOUT_LIMIT', '3');
      const expected = ['https://builtin.test/', 'https://dup.example/good', 'https://y.example/'];
      arrange();
      expect((await getFanoutPool(new AbortController().signal)).map((source) => source.url)).toEqual(expected);
      arrange();
      const pools = await getSourcePools(new AbortController().signal);
      expect(pools.traversal.map((source) => source.url)).toEqual(expected);
      expect(pools.selectable.map((source) => source.url)).toEqual(expected);
    });

    it('合成条目的 rules 与 shuyuan_sources.source 深相等；sourceRevision 与 rules_hash 同源（§5.2）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([engineRow()]);
      const sources = await getReadingSources(new AbortController().signal);
      const engine = sources.find((source) => source.tier === 'M1')!;
      // 硬约束 1：不做字段裁剪/重排/包装——同一对象、深相等、键集完全一致。
      expect(engine.rules).toBe(engineItem);
      expect(engine.rules).toEqual(engineItem);
      expect(Object.keys(engine.rules).sort()).toEqual(Object.keys(engineItem).sort());
      // 内容 revision 保持同源；准入 rules_hash 额外带引擎语义版本前缀。
      const pooled = sourceRevision({ url: engine.url, searchUrl: engine.searchUrl, rules: engine.rules });
      expect(rulesHash(engineItem)).toBe(`1:${pooled}`);
      // 判别力：任何一个键被裁掉都会改变 revision（防裁剪断言不是恒真）。
      const trimmed = { ...engineItem } as Record<string, unknown>;
      delete trimmed.ruleContent;
      expect(sourceRevision({ url: engine.url, searchUrl: engine.searchUrl, rules: trimmed })).not.toBe(pooled);
    });

    it('disableShuyuanSource 后源即时出池，且刷新照抄禁用标记不打回', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      // ① 即时出池：库内该源 disabled_at 非空 ⇒ engineReadingSources 直接剔除。
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow)
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
      // urlfix 哨兵：readEngineRows 是 `JOIN LATERAL (` 子查询；漏斗里是 `CROSS JOIN LATERAL jsonb_array_elements`，
  // 无「( 」紧跟，用它作锚点可避免误捕漏斗（text 已规范化为单空格）。
  const ENGINE_SQL_MARK = 'JOIN LATERAL (';
  execute.mockImplementation(async (query) => {
        const text = query.text;
        // engineHosts（门随池刷）：DISTINCT host 必须先于漏斗聚合分派，两者都命中 FROM source_admission。
        if (text.includes('SELECT DISTINCT host FROM source_admission')) return [{ host: 'engine.example' }];
        // urlfix：readEngineRows 含 FROM source_admission 与 JOIN LATERAL，必须先于漏斗分派避免被截。
        if (text.includes(ENGINE_SQL_MARK)) return [engineRow()];
        if (text.includes('FROM source_admission')) {
          // 准入兼容 L4：漏斗带 url_defaulted / miss_chapter_list / miss_chapter_name 三个新列。
          return [{ ok: 12, deferred: 5, rejected: 3, url_defaulted: 10, miss_chapter_list: 0, miss_chapter_name: 0,
            rejection_codes: { unsupported_operator: 3 } }];
        }
        if (text.includes('FROM shuyuan_sources')) return builtinRegisteredRow;
        if (text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
        return [];
      });
      const health = await getShuyuanPoolHealth(new AbortController().signal);
      expect(health).toMatchObject({
        readingPoolSize: 2, enginePoolSize: 1, poolCandidates: 0,
        admission: { ok: 12, deferred: 5, rejected: 3, url_defaulted: 10, miss_chapter_list: 0, miss_chapter_name: 0,
          rejection_codes: { unsupported_operator: 3 } },
      });
      // 漏斗谓词与入池判据同口径：ok 必须含 compile_ok ∧ search_ok IS TRUE。
      // 4280bda 起 engineHosts 门查询也含 FROM source_admission（SELECT DISTINCT host ... a.compile_ok AND
      // a.search_ok IS TRUE），故选择器必须按漏斗聚合的独有特征定位——顶层 count(*) FILTER（门查询无聚合、
      // 带表别名），不靠调用先后顺序（门与漏斗经 Promise.all 并发，顺序无契约）。
      const funnel = execute.mock.calls.find(([query]) => query.text.includes('count(*) FILTER'))![0];
      expect(funnel.text).toContain('FROM source_admission');
      expect(funnel.text).toContain('compile_ok AND search_ok IS TRUE');
      expect(funnel.text).toContain("search_verdict IN ('challenge', 'conn_fail', 'shell')");
      // 准入兼容 L4（反例 18）：三个观测列都由既有 core_field_mask 列派生（零 schema 改动）。
      expect(funnel.text).toContain("core_field_mask->>'ruleToc.chapterUrl'");
      expect(funnel.text).toContain("core_field_mask->>'ruleToc.chapterList'");
      expect(funnel.text).toContain("core_field_mask->>'ruleToc.chapterName'");
      expect(funnel.text).toContain('jsonb_array_elements(a.compile_diagnostics)');
    });

    it('准入兼容 L4 反例 18：靠引擎默认进池的行计入 url_defaulted（core_field_mask.chapterUrl=false）', async () => {
      // 漏斗是 SQL 聚合（无真库时按 SQL 文本断言 + 类型形状验证）；本用例钉死
      // url_defaulted 的谓词形状：只数 ok 桶（compile_ok ∧ search_ok IS TRUE）里
      // chapterUrl 位图非 true 的行——救回的 10 条预期形态。
      execute.mockImplementation(async (query) => {
        const text = query.text;
        if (text.includes('SELECT DISTINCT host FROM source_admission')) return [];
        if (text.includes('FROM source_admission')) return [{
          ok: 3, deferred: 0, rejected: 0, url_defaulted: 1, miss_chapter_list: 2, miss_chapter_name: 1,
          rejection_codes: {},
        }];
        if (text.includes('FROM shuyuan_sources')) return [];
        if (text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
        return [];
      });
      const health = await getShuyuanPoolHealth(new AbortController().signal);
      expect(health.admission).toEqual({
        ok: 3, deferred: 0, rejected: 0, url_defaulted: 1, miss_chapter_list: 2, miss_chapter_name: 1,
        rejection_codes: {},
      });
      // 同上：按漏斗聚合特征（count(*) FILTER）定位，门查询（SELECT DISTINCT host）不参与匹配。
      const funnel = execute.mock.calls.find(([query]) => query.text.includes('count(*) FILTER'))![0];
      expect(funnel.text).toContain('AS url_defaulted');
      expect(funnel.text).toContain('AS miss_chapter_list');
      expect(funnel.text).toContain('AS miss_chapter_name');
      // 谓词限定在 ok 桶内（url_defaulted 不得把 compile 拒的缺位行也数进去）。
      const urlDefaultedPredicate = funnel.text.split('\n')
        .find((line) => line.includes('AS url_defaulted'))!;
      expect(urlDefaultedPredicate).toContain('compile_ok AND search_ok IS TRUE');
    });

    it('admission 漏斗读失败降级为全 0，不连坐 readingPoolSize（纯观测增量）', async () => {
      execute.mockImplementation(async (query) => {
        const text = query.text;
        if (text.includes('FROM source_admission')) throw new Error('relation "source_admission" does not exist');
        if (text.includes('FROM shuyuan_sources')) return builtinRegisteredRow;
        if (text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
        return [];
      });
      const health = await getShuyuanPoolHealth(new AbortController().signal);
      expect(health).toMatchObject({
        readingPoolSize: 1, enginePoolSize: 0, poolCandidates: 0,
        admission: { ok: 0, deferred: 0, rejected: 0, url_defaulted: 0, miss_chapter_list: 0, miss_chapter_name: 0,
          rejection_codes: {} },
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('shuyuan admission funnel unavailable'),
        expect.objectContaining({ reason: expect.stringContaining('source_admission') }),
      );
    });

    // ---------------------------------------------------------------- §6.1 host 门随池合成刷新
    it('§6.1：engineHosts 抛错时池降级 builtin-only，运行时 host 门保持旧集合（fail-closed，绝不放大）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      // 预置一个「上一轮成功刷入」的旧门集合，模拟库抖动前的既有 ok host。
      refreshSupportedHosts(['stale.example']);
      // engineHosts（第一条 SQL，DISTINCT host）抛错 ⇒ refreshSupportedHosts 不会被调用，本次降级 builtin-only。
      execute.mockRejectedValueOnce(new Error('relation "source_admission" does not exist'))
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow);
      const sources = await getReadingSources(new AbortController().signal);
      // 不抛错、不 500：池降级 builtin-only。
      expect(sources.map((source) => source.tier)).toEqual(['builtin']);
      // 旧门集合原样保留（fail-closed）：stale.example 仍能过 validateSourceUrl。
      expect(validateSourceUrl('https://stale.example/x').href).toBe('https://stale.example/x');
      // 且绝不放大：从未进过门的 host 依旧被拒。
      expect(() => validateSourceUrl('https://never.example/x')).toThrow(SourcePolicyError);
    });

    it('🔴 降级日志脱敏：engineHosts 错误 message 里的连接串（含口令）不进 console.error', async () => {
      // 审查遗留项（shuyuan hostgate/引擎源降级日志）：Neon 连接错误会把 DATABASE_URL 原文
      // 回显在 message 里；降级日志必须先过 safeReason（`://` token 抹成 [redacted-url]）。
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      const secret = 'postgres://leak_user:leak_secret@db.internal.example/finder';
      execute.mockRejectedValueOnce(new Error(`Error connecting to database: ${secret}`))
        .mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce(builtinRegisteredRow);
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin']); // 降级路径本身不变
      const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.stringify(call))
        .join('\n');
      expect(logged).toContain('shuyuan engine host gate refresh failed');
      // 写死的敏感 pattern：连接串任何一段都不许出现。
      expect(logged).not.toContain('leak_secret');
      expect(logged).not.toContain('leak_user');
      expect(logged).not.toContain('postgres://leak_user:leak_secret@db.internal.example/finder');
      expect(logged).toContain('[redacted-url]'); // 抹除痕迹可读，保留错误类别
    });

    it('🔴 降级日志脱敏：引擎源查询（JOIN source_admission）失败同款不泄连接串', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      const secret = 'postgresql://engine:pw123@db2.internal.example/prod';
      execute.mockResolvedValueOnce([{ host: 'engine.example' }]).mockResolvedValueOnce([{ collections: [] }])
        .mockResolvedValueOnce(builtinRegisteredRow)
        .mockRejectedValueOnce(new Error(`fetch failed while connecting: ${secret}`));
      const sources = await getReadingSources(new AbortController().signal);
      expect(sources.map((source) => source.tier)).toEqual(['builtin']);
      const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.stringify(call))
        .join('\n');
      expect(logged).toContain('shuyuan engine sources unavailable');
      expect(logged).not.toContain('pw123');
      expect(logged).not.toContain(secret);
      expect(logged).toContain('[redacted-url]');
    });

    it('§6.1 零回归：引擎开关关时完全不碰 host 门，也不查准入表', async () => {
      // beforeEach显式关闭READING_ENGINE_SOURCES。预置门集合，验证getReadingPool后原样不动。
      refreshSupportedHosts(['preset.example']);
      execute.mockResolvedValueOnce([{ collections: [] }]).mockResolvedValueOnce([]);
      await getReadingSources(new AbortController().signal);
      // 引擎分支根本没进：不查 source_admission（含 engineHosts 的 DISTINCT host）。
      expect(execute.mock.calls.some(([query]) => query.text.includes('source_admission'))).toBe(false);
      // host 门逐字节不动：既没被刷成 DB 实况，也没被收窄。
      expect(validateSourceUrl('https://preset.example/x').href).toBe('https://preset.example/x');
    });
  });

  // 41-PENDING-WAKE：pending（规则变化退回待核验）是死态——入队循环原一律 `pending → continue`，
  // 只要上游规则不再变就永不被重探（生产 944 个 pending 常驻、reachable 0）。此处钉住
  // 「置 pending 的源下一轮能被有界重探并流转」，任何「pending 一律 continue」的变异都会变红。
  describe('pending 死态唤醒（41-PENDING-WAKE）', () => {
    const pendingSeed = (extra: Record<string, unknown> = {}) => ({
      source_url: knownSource.bookSourceUrl, source: knownSource, last_error: '', disabled_at: null, ...extra,
    });
    const probedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

    it('快照里的遗留 pending 下一轮刷新能被重探并流转到 reachable（打破死态）', async () => {
      // 生产现状的直接模拟：上一轮规则变化写出的 pending 条目留在快照里，本轮上游规则不再变。
      // 旧逻辑 `state.status === 'pending' → continue` 永远不会探测它 ⇒ 死态；
      // 新逻辑必须把它放进探测队列并流转出 pending。
      setCollection(11, [knownSource]);
      seedPrevious([pendingSeed()], [
        { url: knownSource.bookSourceUrl, status: 'pending', checked_at: null, error: null },
      ]);
      responses.set('https://builtin.test/', { body: '离线合成响应' });

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://builtin.test/');
      expect(savedStates()[0]).toMatchObject({
        url: knownSource.bookSourceUrl, status: 'reachable', error: null, consecutive_failures: 0,
      });
    });

    it('规则变化当轮即并入有界重探：pending 不再是吸收态（backlog 也不无限）', async () => {
      // 同一轮里规则变化 ⇒ 置 pending **并**入队重探。这是生产 backlog 的主要来源：
      // 若只置 pending 不入队，下一轮才靠遗留 pending 分支慢慢唤醒，周转慢一拍。
      const changed = { ...knownSource, ruleSearch: { name: '.new-title' } };
      setCollection(11, [changed]);
      seedPrevious([pendingSeed()], [
        { url: knownSource.bookSourceUrl, status: 'reachable', checked_at: '2026-09-16T00:00:00Z', error: null },
      ]);
      responses.set('https://builtin.test/', { body: '离线合成响应' });

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://builtin.test/');
      expect(savedStates()[0]).toMatchObject({ status: 'reachable', error: null });
    });

    it('pending 重探失败时按既有 probeWorker 语义累加计数 / 判 failed，不卡在 pending', async () => {
      setCollection(11, [knownSource]);
      // 已累计 2 次失败：本轮再失败（第 3 次）应判 failed，而不是写回 pending。
      seedPrevious([pendingSeed()], [
        { url: knownSource.bookSourceUrl, status: 'pending', checked_at: null, error: null, consecutive_failures: 2 },
      ]);
      responses.set('https://builtin.test/', { body: 'unavailable', status: 503 });

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://builtin.test/');
      expect(savedStates()[0]).toMatchObject({ status: 'failed', consecutive_failures: 3 });
    });

    it('pending 重探不饿死已知失败源重探：名额分配顺序为 probes → discovery → pending', async () => {
      // 已知失败源（带 last_error）+ 一个 pending 源。
      const failedUrl = 'https://builtin.test/failed';
      const failedSource = { ...knownSource, bookSourceUrl: failedUrl, bookSourceName: '失败源' };
      const pendingUrl = knownSource.bookSourceUrl;
      setCollection(11, [failedSource, knownSource]);
      seedPrevious([
        { source_url: failedUrl, source: failedSource, last_error: '历史连接超时', disabled_at: null },
        pendingSeed(),
      ], [
        { url: pendingUrl, status: 'pending', checked_at: null, error: null },
      ]);
      responses.set(failedUrl, { body: 'unavailable', status: 503 });
      responses.set(pendingUrl, { body: 'unavailable', status: 503 });

      await refreshShuyuan();

      const calls = probedUrls().slice(4).map((url) => url.replace(/\/+$/, ''));
      // 已知失败源必须先于 pending 源被探测（probes 段排在 pendingReprobe 之前）。
      expect(calls).toEqual([failedUrl, pendingUrl]);
    });

    it('canProbe 不在门里的 pending 源仍不探（fail-closed 保持）', async () => {
      // unknownSource 的 host 过不了 validateSourceUrl ⇒ 即便它在快照里是 pending 也不被重探。
      setCollection(11, [unknownSource]);
      seedPrevious([], [
        { url: unknownSource.bookSourceUrl, status: 'pending', checked_at: null, error: null },
      ]);

      await refreshShuyuan();

      expect(probedUrls()).toEqual([indexUrl, collectionUrl(11), collectionUrl(12), collectionUrl(13)]);
      // 快照里的 pending 条目仍被原样保留（readMeta 对 pending 放宽 host 门是既有特例），
      // 但它**不进探测队列**：canProbe 是硬门，fail-closed 保持。
      expect(savedStates()).toContainEqual({
        url: unknownSource.bookSourceUrl, status: 'pending', checked_at: null, error: null,
      });
    });

    it('每轮 pending 重探数有界：backlog 再大也只重探 PROBE_PENDING_PER_REFRESH 个', async () => {
      // 构造 50 个 pending 源（远超名额 40），全部可探测（book15 host）。
      const many = Array.from({ length: 50 }, (_, i) => ({
        ...knownSource, bookSourceUrl: `https://builtin.test/p${i}`, bookSourceName: `P${i}`,
      }));
      setCollection(11, many);
      const rows = many.map((item) => ({
        source_url: item.bookSourceUrl, source: item, last_error: '', disabled_at: null,
      }));
      const entries = many.map((item) => ({
        url: item.bookSourceUrl, status: 'pending' as const, checked_at: null, error: null,
      }));
      seedPrevious(rows, entries);
      many.forEach((item) => responses.set(item.bookSourceUrl, { body: '离线合成响应' }));

      await refreshShuyuan();

      const probes = probedUrls().filter((url) => url.startsWith('https://builtin.test/p'));
      // 40 = PROBE_PENDING_PER_REFRESH（4 × 并发 10）。变异：去掉名额上限会探测全部 50 个。
      expect(probes.length).toBe(PROBE_PENDING_PER_REFRESH);
    });
  });

  // 归纳：last_error 的自动写点、连续失败计数、失败计数的持久化与解析等价。
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
      responses.set('https://builtin.test/', { body: 'unavailable', status: 503 });

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://builtin.test/');
      expect(savedStates()).toEqual([{
        url: knownSource.bookSourceUrl, status: 'unprobed', checked_at: null, error: null, consecutive_failures: 1,
      }]);
      // last_error 的自动写点：此前只有人工 POST {action:disable} 会写它。
      expect(savedRows()[0].err).toBe('503 https://builtin.test/');
    });

    it('单次探测失败不降级：保留上一次可达结论，只把计数加到 1', async () => {
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry()]);

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://builtin.test/');
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
        error: expect.stringContaining('https://builtin.test/'), consecutive_failures: 3,
      }]);
    });

    it('阈值差一次时探测失败仍不判死：第二次失败只把计数加到 2，第三次才写 failed', async () => {
      setCollection(11, [knownSource]);
      responses.set('https://builtin.test/', { body: 'unavailable', status: 503 });
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
        error: expect.stringContaining('https://builtin.test/'), consecutive_failures: 3,
      }]);
    });

    it('已知失败源排在补探的未探测源之前', async () => {
      const freshSource = { ...knownSource, bookSourceUrl: 'https://builtin.test/fresh', bookSourceName: '全新源' };
      setCollection(11, [knownSource, freshSource]);
      seedPrevious([storedKnown('历史连接超时')]);
      responses.set('https://builtin.test/', { body: 'unavailable', status: 503 });
      responses.set('https://builtin.test/fresh', { body: 'unavailable', status: 503 });

      await refreshShuyuan();

      // 前 4 次是 index + 3 个合集。探测按 probes 数组顺序下发（并发窗口内也保序），
      // 带 last_error 的已知失败源必须先于「没有任何结论」的补探源，补探不能插到队首。
      expect(probedUrls()).toEqual([
        indexUrl, collectionUrl(11), collectionUrl(12), collectionUrl(13),
        'https://builtin.test/', 'https://builtin.test/fresh',
      ]);
    });

    it('探测成功把连续失败计数清零并回到可达', async () => {
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry({ status: 'unprobed', checked_at: null, consecutive_failures: 2 })]);
      responses.set('https://builtin.test/', { body: '离线合成响应' });

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
        .toMatchObject([{ url: 'https://builtin.test/', name: '抖动源' }]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('探测期间调用方中止不算源失败：不写状态、不累加计数、不提交事务', async () => {
      const controller = new AbortController();
      setCollection(11, [knownSource]);
      seedPrevious([storedKnown('历史连接超时')], [entry({ consecutive_failures: 1 })]);
      const ordinary = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) => {
        if (String(input) === 'https://builtin.test/') {
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

  // B3（source-pipeline-41-review.md）：cron 是典型冷 lambda（每 6 小时一次、实例基本不复用），
  // 刷新开始时模块级 supportedHosts 初值只有 builtin；若不先刷 host 门就构建探测队列，入队判据
  // canProbe（:786）= validateSourceUrl 会把 1200+ 引擎源整批**静默滤掉**——reachable 长期偏低不是
  // 站点不可达，是压根没探。下面钉住「刷新流程先刷 host 门、再 readMeta / 构建探测队列」这条
  // **顺序**不变量：任何「不刷门」或「门刷在探测之后」的变异都会让它们转红（而不是只钉最终结果）。
  describe('冷启动 host 门：探测队列不得静默丢弃引擎源', () => {
    const engineSource = {
      bookSourceUrl: 'https://engine.example/', bookSourceName: '引擎源',
      searchUrl: 'https://engine.example/s?q={{key}}',
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
    };
    const probedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));
    // source_admission 持久表里已有该 host（前几轮准入批次写入）——这是 host 门的数据源，与「本轮
    // 随后才发生」的写库无关；engineHosts 的 DISTINCT host 查询据此返回它。
    const withAdmittedEngineHost = () => execute.mockImplementation(async (query) => {
      if (query.text.includes('DISTINCT host')) return [{ host: 'engine.example' }];
      if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: '2026-09-14T00:00:00Z' }];
      if (query.text.startsWith('SELECT count(*)')) return [zeroCounts];
      return [];
    });
    afterEach(() => refreshSupportedHosts([])); // 复位运行时 host 集合

    it('supportedHosts 仅含 builtin（冷启动）时，刷新仍把引擎源放进探测队列', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts([]); // 冷 lambda：模块级门复位到内建集合
      // 前置自证：此刻门确实是冷的（引擎 host 过不了 validateSourceUrl），否则用例失去判别力。
      expect(() => validateSourceUrl(engineSource.bookSourceUrl)).toThrow(SourcePolicyError);
      setCollection(11, [engineSource]);
      responses.set('https://engine.example/', { body: '离线合成响应' });
      withAdmittedEngineHost();

      await refreshShuyuan();

      expect(probedUrls()).toContain('https://engine.example/');
    });

    it('冷启动时引擎源在快照里的既有探测态不被丢弃（门刷在 readMeta 之前）', async () => {
      vi.stubEnv('READING_ENGINE_SOURCES', '1');
      refreshSupportedHosts([]);
      setCollection(11, [engineSource]);
      seedPrevious([], [{
        url: 'https://engine.example', status: 'reachable', checked_at: '2026-09-16T00:00:00Z', error: null,
      }]);
      // seedPrevious 已占掉前两个 mockResolvedValueOnce（previousRows / storedMeta），DISTINCT host 落其后。
      withAdmittedEngineHost();

      await refreshShuyuan();

      // 门若刷在 readMeta 之后，readMeta（:378 的 canProbe）会把该条目整条丢弃 ⇒ 这里转红。
      expect(savedStates()).toContainEqual({
        url: 'https://engine.example', status: 'reachable', checked_at: '2026-09-16T00:00:00Z', error: null,
      });
    });
  });
});
