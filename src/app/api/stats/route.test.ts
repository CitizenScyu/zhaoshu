import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LLM_USAGE_PHASES, type TokenStats } from '@/lib/llm-usage';

const { ensureSchema, getSql, sql, getLlmUsageStats, session, pool } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), sql: vi.fn(), getLlmUsageStats: vi.fn(), session: vi.fn(),
  // B3：池健康度（getShuyuanPoolHealth → getReadingSources）不触 SQL mock 之外的路径，
  // 直接替换为固定值；测试需要控制 readingPoolSize/refreshedAtAgeHours 时再覆写。
  pool: { readingPoolSize: 1, refreshedAtAgeHours: 72.5 },
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql, getLlmUsageStats }));
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: session }));
vi.mock('@/lib/shuyuan', async (original) => ({
  ...await original<typeof import('@/lib/shuyuan')>(),
  getShuyuanPoolHealth: vi.fn(async () => pool),
}));
import { GET } from './route';

const zero = { prompt: 0, completion: 0, total: 0, cache: 0, calls: 0, missingUsageCalls: 0 };
const tokens: TokenStats = {
  total: { prompt: 200, completion: 50, total: 250, cache: 70, calls: 4, missingUsageCalls: 2 },
  last24h: { prompt: 100, completion: 25, total: 125, cache: 25, calls: 3, missingUsageCalls: 1 },
  byPhase: [
    { phase: 'find_recall', prompt: 120, completion: 30, total: 150, cache: 50, calls: 2, missingUsageCalls: 1 },
    { phase: 'find_rerank', ...zero },
    { phase: 'profile', prompt: 80, completion: 20, total: 100, cache: 20, calls: 1, missingUsageCalls: 0 },
    { phase: 'feedback', ...zero, calls: 1, missingUsageCalls: 1 },
  ],
};
const emptyTokens: TokenStats = { total: zero, last24h: zero, byPhase: LLM_USAGE_PHASES.map((phase) => ({ phase, ...zero })) };
const sourceCounts = { total: 10, active: 1, enabled: 8, disabled: 2, unprobed: 5, pending: 2, reachable: 2, failed: 1 };
const emptySourceCounts = { total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 };

const ownerMetadata = {
  subject: { userId: 1 }, allowedSections: ['library', 'find', 'shelf', 'download', 'shuyuan', 'tokens'],
  sectionScopes: { library: 'shared', download: 'personal', find: 'personal', shelf: 'personal', shuyuan: 'shared', tokens: 'shared-owner' },
};
const readyStates = { library: 'ok', download: 'ok', find: 'ok', shelf: 'ok', shuyuan: 'ok', tokens: 'ok' };
const downloadStats = { total: 3, done: 2, chapters: 100, chars: 400000 };
const emptyDownloadStats = { total: 0, done: 0, chapters: 0, chars: 0 };

const fixtures = [
  { section: 'library', needle: 'count(quality)', rows: [{ total: 12, with_quality: 10, avg_quality: 8.2, chars_labeled: 360000 }], empty: [{ total: 0, with_quality: 0, avg_quality: null, chars_labeled: 0 }] },
  { section: 'library', needle: 'AS genre', rows: [{ genre: '仙侠', n: 12 }], empty: [] },
  { section: 'download', needle: 'FROM download_tasks', rows: [downloadStats], empty: [emptyDownloadStats] },
  { section: 'find', needle: 'count(DISTINCT query)', rows: [{ queries: 4, recommendations: 6 }], empty: [{ queries: 0, recommendations: 0 }] },
  { section: 'shelf', needle: 'GROUP BY status', rows: [{ name: 'want', count: 6 }], empty: [] },
  { section: 'shuyuan', needle: 'FROM shuyuan_meta', rows: [{ collections: [], refreshed_at: null }], empty: [] },
  { section: 'shuyuan', needle: 'FROM shuyuan_sources', rows: [sourceCounts], empty: [emptySourceCounts] },
  { section: 'tokens', needle: 'FROM llm_usage', rows: [], empty: [] },
];

// 事务合批的观测面：每条批内语句的文本、整体成败、事务选项。
// 把某个只读段从批里摘出去时，批内语句数会变，下面的断言必须变红。
type BatchRecord = { texts: string[]; result: 'pending' | 'ok' | 'failed'; options?: unknown };
const batches: BatchRecord[] = [];

function rowsForQuery(text: string, failure?: string, empty = false) {
  const fixture = fixtures.find(({ needle }) => text.includes(needle));
  if (!fixture) throw new Error('Unexpected SQL query');
  if (failure === '*' || failure === fixture.needle) throw new Error('private database details');
  return empty ? fixture.empty : fixture.rows;
}

function mockQueries(failure?: string, empty = false) {
  getLlmUsageStats.mockImplementation(async () => {
    if (failure === '*' || failure === 'FROM llm_usage') throw new Error('private database details');
    return empty ? emptyTokens : tokens;
  });
  sql.mockImplementation((strings: TemplateStringsArray) => rowsForQuery(strings.join(''), failure, empty));
  batches.length = 0;
  Object.assign(sql, {
    transaction: vi.fn(async (batch: ((tx: unknown) => unknown[]) | unknown[], options?: unknown) => {
      const record: BatchRecord = { texts: [], result: 'pending', options };
      batches.push(record);
      const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
        record.texts.push(strings.join(''));
        return (sql as unknown as (parts: TemplateStringsArray, ...rest: unknown[]) => unknown)(strings, ...values);
      };
      try {
        const result = typeof batch === 'function' ? (batch as (t: unknown) => unknown[])(tx) : batch;
        record.result = 'ok';
        return result;
      } catch (error) {
        record.result = 'failed';
        throw error;
      }
    }),
  });
}

function request() {
  return new NextRequest('http://localhost/api/stats', { headers: { Authorization: 'Bearer stats-test-owner' } });
}

describe('GET /api/stats', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'stats-test-owner');
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'false');
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    mockQueries();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('authenticates before initialization', async () => {
    const req = request();
    req.headers.delete('Authorization');
    expect((await GET(req)).status).toBe(401);
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(getLlmUsageStats).not.toHaveBeenCalled();
  });

  it('returns aggregate data and explicit availability for each partition', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...ownerMetadata, sectionStates: readyStates,
      library: { total: 12, withQuality: 10, avgQuality: 8.2, charsLabeled: 360000, genres: [{ name: '仙侠', count: 12 }] },
      download: downloadStats,
      find: { queries: 4, recommendations: 6 }, shelf: { statuses: [{ name: 'want', count: 6 }] },
      shuyuan: { ...sourceCounts, ...pool }, tokens,
      availability: { library: true, download: true, find: true, shelf: true, shuyuan: true, tokens: true },
    });
    const findQuery = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('count(DISTINCT query)'));
    expect(findQuery?.slice(1)).toEqual([1, '书库添加']);
    const downloadQuery = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('FROM download_tasks'));
    expect(downloadQuery?.slice(1)).toEqual(['done', 'done', 'done', 1]);
    expect(getLlmUsageStats).toHaveBeenCalledOnce();
  });

  it('library 段的两条查询合成一次只读事务往返，语句与顺序不变', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    // 合批专属断言：库段只发一次事务；摘掉任一条只会让批内语句数变少（变异自测见回报）。
    // shuyuan 段（counts+meta）与 download 段也各走一次事务（B3 起 shuyuan 增加了
    // meta 往返）；这里锁的是「库段本身只有一批且语句恰好两条」。
    const libraryBatch = batches.find((batch) => batch.texts.some((text) => text.includes('count(quality)')));
    expect(libraryBatch).toBeDefined();
    expect(libraryBatch!.result).toBe('ok');
    expect(libraryBatch!.options).toEqual({ readOnly: true });
    expect(libraryBatch!.texts).toHaveLength(2);
    expect(libraryBatch!.texts[0]).toContain('count(quality)');
    expect(libraryBatch!.texts[1]).toContain('AS genre');
    // 合批没有把别的容错段卷进来：下载段仍是自己的一次独立往返（单段失败不连坐）。
    const downloadCalls = sql.mock.calls.filter(([parts]) => (parts as TemplateStringsArray).join('').includes('FROM download_tasks'));
    expect(downloadCalls).toHaveLength(1);
  });

  it('keeps real empty aggregates at zero with available=true', async () => {
    mockQueries(undefined, true);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...ownerMetadata, sectionStates: readyStates,
      library: { total: 0, withQuality: 0, avgQuality: null, charsLabeled: 0, genres: [] },
      download: emptyDownloadStats, find: { queries: 0, recommendations: 0 },
      shelf: { statuses: [] }, shuyuan: { ...emptySourceCounts, ...pool }, tokens: emptyTokens,
      availability: { library: true, download: true, find: true, shelf: true, shuyuan: true, tokens: true },
    });
  });

  it.each(fixtures)('keeps $section failure/readiness distinct for $needle', async ({ section, needle }) => {
    mockQueries(needle);
    const res = await GET(request());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data[section]).toBeNull();
    expect(data.availability[section]).toBe(false);
    expect(data.sectionStates[section]).toBe('unavailable');
    expect(data.code).toBe('STATS_PARTIAL');
    expect(data.error).toBe('部分统计暂不可用，请稍后重试');
    for (const key of Object.keys(data.availability)) {
      if (key === section) continue;
      expect(data.availability[key]).toBe(true);
      expect(data[key]).not.toBeNull();
    }
    expect(JSON.stringify(data)).not.toContain('private database details');
  });

  it('启用数量与探测可达数量独立，active 只计启用且真实可达', async () => {
    const data = await (await GET(request())).json();
    expect(data.shuyuan).toEqual({ ...sourceCounts, ...pool });
    expect(data.shuyuan.active).not.toBe(data.shuyuan.enabled);
    const query = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('FROM shuyuan_sources'));
    expect((query![0] as TemplateStringsArray).join('')).toContain("disabled_at IS NULL AND p.status = 'reachable'");
    expect((query![0] as TemplateStringsArray).join('')).toContain('AS unprobed');
    expect((query![0] as TemplateStringsArray).join('')).toContain('AS pending');
  });

  it('B3：shuyuan 段带 readingPoolSize 与 refreshedAtAgeHours，池健康独立于计数', async () => {
    // 995 enabled / 0 可达的假象正是这次要暴露的：池大小必须独立可见。
    pool.readingPoolSize = 0; pool.refreshedAtAgeHours = 74.2;
    const data = await (await GET(request())).json();
    expect(data.shuyuan).toMatchObject({ enabled: 8, readingPoolSize: 0, refreshedAtAgeHours: 74.2 });
    // 池查询失败不连坐计数段：pool 拒绝时 counts 仍在，shuyuan 段整体降级。
    const { getShuyuanPoolHealth } = await import('@/lib/shuyuan');
    (getShuyuanPoolHealth as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pool down'));
    const degraded = await (await GET(request())).json();
    expect(degraded.shuyuan).toBeNull();
    expect(degraded.availability.shuyuan).toBe(false);
  });

  it.each(['schema', 'client', 'all queries'])('returns controlled 503 for failed %s', async (stage) => {
    if (stage === 'schema') ensureSchema.mockRejectedValue(new Error('private database details'));
    if (stage === 'client') getSql.mockImplementation(() => { throw new Error('private database details'); });
    if (stage === 'all queries') mockQueries('*');
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ...ownerMetadata, sectionStates: { library: 'unavailable', download: 'unavailable', find: 'unavailable', shelf: 'unavailable', shuyuan: 'unavailable', tokens: 'unavailable' },
      library: null, download: null, find: null, shelf: null, shuyuan: null, tokens: null,
      availability: { library: false, download: false, find: false, shelf: false, shuyuan: false, tokens: false },
      error: '统计暂不可用，请稍后重试', code: 'STATS_UNAVAILABLE',
    });
    if (stage !== 'all queries') expect(sql).not.toHaveBeenCalled();
  });
  it.each([false, true])('member download=%s：无权限是 forbidden，有权限时按本人任务统计', async (canDownload) => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    session.mockResolvedValue({ userId: 2, role: 'member', canFind: true, canRead: canDownload, canDownload, authMethod: 'password', membersEnabled: true });
    const req = new NextRequest('http://localhost/api/stats?userId=1', { headers: { Cookie: 'nf-dev-session=member-a' } });
    const res = await GET(req); const data = await res.json();
    expect(res.status).toBe(200); expect(data.subject.userId).toBe(2); expect(data.code).toBeUndefined();
    expect(data.download).toEqual(canDownload ? downloadStats : null);
    expect(data.sectionStates.download).toBe(canDownload ? 'ok' : 'forbidden');
    expect(data.availability.download).toBe(canDownload);
    expect(data.sectionStates.shuyuan).toBe(canDownload ? 'ok' : 'forbidden');
    expect(data.tokens).toBeNull(); expect(data.sectionStates.tokens).toBe('forbidden');
    expect(getLlmUsageStats).not.toHaveBeenCalled();
    for (const [parts, ...values] of sql.mock.calls) {
      const text = parts.join('');
      if (text.includes('FROM download_tasks')) {
        // 归属必须是会话里的 userId(2)，而不是查询串里的 userId=1。
        expect(text).toContain('WHERE user_id =');
        expect(values.at(-1)).toBe(2);
      }
      // F07：书架统计也按本人 userId 过滤（新口径是 DISTINCT ON 子查询 + GROUP BY status）。
      if (text.includes('FROM recommendations')) { expect(text).toContain('user_id ='); expect(values[0]).toBe(2); }
      if (!canDownload) { expect(text).not.toContain('download_tasks'); expect(text).not.toContain('shuyuan_sources'); }
    }
    if (!canDownload) expect(sql.mock.calls.some(([parts]) => parts.join('').includes('download_tasks'))).toBe(false);
  });

  it('两个用户的下载统计互不串：查询各自带本人 userId 且不复用他人结果', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    sql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('');
      const userId = values.at(-1);
      if (text.includes('FROM download_tasks')) return [{ total: userId === 2 ? 3 : 7, done: userId === 2 ? 2 : 5, chapters: userId === 2 ? 100 : 900, chars: userId === 2 ? 400000 : 3_600_000 }];
      const fixture = fixtures.find(({ needle }) => text.includes(needle));
      if (!fixture) throw new Error('Unexpected SQL query');
      return fixture.rows;
    });
    const fetchAs = async (userId: number, cookie: string) => {
      session.mockResolvedValue({ userId, role: 'member', canFind: true, canRead: true, canDownload: true, authMethod: 'password', membersEnabled: true });
      return (await (await GET(new NextRequest('http://localhost/api/stats', { headers: { Cookie: cookie } }))).json());
    };
    const a = await fetchAs(2, 'nf-dev-session=member-a');
    const b = await fetchAs(3, 'nf-dev-session=member-b');
    expect(a.subject.userId).toBe(2); expect(a.download).toEqual({ total: 3, done: 2, chapters: 100, chars: 400000 });
    expect(b.subject.userId).toBe(3); expect(b.download).toEqual({ total: 7, done: 5, chapters: 900, chars: 3_600_000 });
    expect(a.sectionStates.download).toBe('ok'); expect(b.sectionStates.download).toBe('ok');
    expect(a.download).not.toEqual(b.download);
  });
  it('无 find 能力时不访问任一统计分区', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    session.mockResolvedValue({ userId: 2, role: 'member', canFind: false, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    expect((await GET(new NextRequest('http://localhost/api/stats', { headers: { Cookie: 'nf-dev-session=member-a' } }))).status).toBe(403);
    expect(ensureSchema).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled(); expect(getLlmUsageStats).not.toHaveBeenCalled();
  });

});
