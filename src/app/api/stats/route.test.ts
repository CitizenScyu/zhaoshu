import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LLM_USAGE_PHASES, type TokenStats } from '@/lib/llm-usage';

const { ensureSchema, getSql, sql, getLlmUsageStats, session } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), sql: vi.fn(), getLlmUsageStats: vi.fn(), session: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql, getLlmUsageStats }));
vi.mock('@/lib/auth-session', async (original) => ({ ...await original<typeof import('@/lib/auth-session')>(), findSessionByToken: session }));
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
const readyStates = { library: 'ok', download: 'not_ready', find: 'ok', shelf: 'ok', shuyuan: 'ok', tokens: 'ok' };

const fixtures = [
  { section: 'library', needle: 'count(quality)', rows: [{ total: 12, with_quality: 10, avg_quality: 8.2, chars_labeled: 360000 }], empty: [{ total: 0, with_quality: 0, avg_quality: null, chars_labeled: 0 }] },
  { section: 'library', needle: 'AS genre', rows: [{ genre: '仙侠', n: 12 }], empty: [] },
  { section: 'download', needle: 'FROM download_tasks', rows: [{ total: 3, done: 2, chapters: 100, chars: 400000 }], empty: [{ total: 0, done: 0, chapters: 0, chars: 0 }] },
  { section: 'find', needle: 'count(DISTINCT query)', rows: [{ queries: 4, recommendations: 6 }], empty: [{ queries: 0, recommendations: 0 }] },
  { section: 'shelf', needle: 'GROUP BY status', rows: [{ name: 'want', count: 6 }], empty: [] },
  { section: 'shuyuan', needle: 'FROM shuyuan_meta', rows: [{ collections: [], refreshed_at: null }], empty: [] },
  { section: 'shuyuan', needle: 'FROM shuyuan_sources', rows: [sourceCounts], empty: [emptySourceCounts] },
  { section: 'tokens', needle: 'FROM llm_usage', rows: [], empty: [] },
];

function mockQueries(failure?: string, empty = false) {
  getLlmUsageStats.mockImplementation(async () => {
    if (failure === '*' || failure === 'FROM llm_usage') throw new Error('private database details');
    return empty ? emptyTokens : tokens;
  });
  sql.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('');
    const fixture = fixtures.find(({ needle }) => text.includes(needle));
    if (!fixture) throw new Error('Unexpected SQL query');
    if (failure === '*' || failure === fixture.needle) throw new Error('private database details');
    return empty ? fixture.empty : fixture.rows;
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
      download: null,
      find: { queries: 4, recommendations: 6 }, shelf: { statuses: [{ name: 'want', count: 6 }] },
      shuyuan: sourceCounts, tokens,
      availability: { library: true, download: false, find: true, shelf: true, shuyuan: true, tokens: true },
    });
    const findQuery = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('count(DISTINCT query)'));
    expect(findQuery?.slice(1)).toEqual([1, '书库添加']);
    expect(getLlmUsageStats).toHaveBeenCalledOnce();
  });

  it('keeps real empty aggregates at zero with available=true', async () => {
    mockQueries(undefined, true);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...ownerMetadata, sectionStates: readyStates,
      library: { total: 0, withQuality: 0, avgQuality: null, charsLabeled: 0, genres: [] },
      download: null, find: { queries: 0, recommendations: 0 },
      shelf: { statuses: [] }, shuyuan: emptySourceCounts, tokens: emptyTokens,
      availability: { library: true, download: false, find: true, shelf: true, shuyuan: true, tokens: true },
    });
  });

  it.each(fixtures)('keeps $section failure/readiness distinct for $needle', async ({ section, needle }) => {
    mockQueries(needle);
    const res = await GET(request());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data[section]).toBeNull();
    expect(data.availability[section]).toBe(false);
    if (section === 'download') {
      expect(data.sectionStates.download).toBe('not_ready');
      expect(data.code).toBeUndefined();
      expect(sql.mock.calls.some(([parts]) => parts.join('').includes('download_tasks'))).toBe(false);
    } else {
      expect(data.code).toBe('STATS_PARTIAL');
      expect(data.error).toBe('部分统计暂不可用，请稍后重试');
    }
    for (const key of Object.keys(data.availability)) {
      if (key === section || key === 'download') continue;
      expect(data.availability[key]).toBe(true);
      expect(data[key]).not.toBeNull();
    }
    expect(JSON.stringify(data)).not.toContain('private database details');
  });

  it('启用数量与探测可达数量独立，active 只计启用且真实可达', async () => {
    const data = await (await GET(request())).json();
    expect(data.shuyuan).toEqual(sourceCounts);
    expect(data.shuyuan.active).not.toBe(data.shuyuan.enabled);
    const query = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('FROM shuyuan_sources'));
    expect((query![0] as TemplateStringsArray).join('')).toContain("disabled_at IS NULL AND p.status = 'reachable'");
    expect((query![0] as TemplateStringsArray).join('')).toContain('AS unprobed');
    expect((query![0] as TemplateStringsArray).join('')).toContain('AS pending');
  });

  it.each(['schema', 'client', 'all queries'])('returns controlled 503 for failed %s', async (stage) => {
    if (stage === 'schema') ensureSchema.mockRejectedValue(new Error('private database details'));
    if (stage === 'client') getSql.mockImplementation(() => { throw new Error('private database details'); });
    if (stage === 'all queries') mockQueries('*');
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ...ownerMetadata, sectionStates: { library: 'unavailable', download: 'not_ready', find: 'unavailable', shelf: 'unavailable', shuyuan: 'unavailable', tokens: 'unavailable' },
      library: null, download: null, find: null, shelf: null, shuyuan: null, tokens: null,
      availability: { library: false, download: false, find: false, shelf: false, shuyuan: false, tokens: false },
      error: '统计暂不可用，请稍后重试', code: 'STATS_UNAVAILABLE',
    });
    if (stage !== 'all queries') expect(sql).not.toHaveBeenCalled();
  });
  it.each([false, true])('member download=%s：无权限和未就绪不算数据库故障，个人查询按本人', async (canDownload) => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    session.mockResolvedValue({ userId: 2, role: 'member', canFind: true, canRead: canDownload, canDownload, authMethod: 'password', membersEnabled: true });
    const req = new NextRequest('http://localhost/api/stats?userId=1', { headers: { Cookie: 'nf-dev-session=member-a' } });
    const res = await GET(req); const data = await res.json();
    expect(res.status).toBe(200); expect(data.subject.userId).toBe(2); expect(data.code).toBeUndefined();
    expect(data.download).toBeNull(); expect(data.sectionStates.download).toBe(canDownload ? 'not_ready' : 'forbidden');
    expect(data.sectionStates.shuyuan).toBe(canDownload ? 'ok' : 'forbidden');
    expect(data.tokens).toBeNull(); expect(data.sectionStates.tokens).toBe('forbidden');
    expect(getLlmUsageStats).not.toHaveBeenCalled();
    for (const [parts, ...values] of sql.mock.calls) {
      const text = parts.join(''); expect(text).not.toContain('download_tasks');
      if (text.includes('FROM recommendations')) { expect(text).toContain('WHERE user_id ='); expect(values[0]).toBe(2); }
      if (!canDownload) expect(text).not.toContain('shuyuan_sources');
    }
  });
  it('无 find 能力时不访问任一统计分区', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    session.mockResolvedValue({ userId: 2, role: 'member', canFind: false, canRead: false, canDownload: false, authMethod: 'password', membersEnabled: true });
    expect((await GET(new NextRequest('http://localhost/api/stats', { headers: { Cookie: 'nf-dev-session=member-a' } }))).status).toBe(403);
    expect(ensureSchema).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled(); expect(getLlmUsageStats).not.toHaveBeenCalled();
  });

});
