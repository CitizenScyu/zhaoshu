import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LLM_USAGE_PHASES, type TokenStats } from '@/lib/llm-usage';

const { ensureSchema, getSql, sql, getLlmUsageStats } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), sql: vi.fn(), getLlmUsageStats: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ ensureSchema, getSql, getLlmUsageStats }));
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

const fixtures = [
  { section: 'library', needle: 'count(quality)', rows: [{ total: 12, with_quality: 10, avg_quality: 8.2, chars_labeled: 360000 }], empty: [{ total: 0, with_quality: 0, avg_quality: null, chars_labeled: 0 }] },
  { section: 'library', needle: 'AS genre', rows: [{ genre: '仙侠', n: 12 }], empty: [] },
  { section: 'download', needle: 'FROM download_tasks', rows: [{ total: 3, done: 2, chapters: 100, chars: 400000 }], empty: [{ total: 0, done: 0, chapters: 0, chars: 0 }] },
  { section: 'find', needle: 'count(DISTINCT query)', rows: [{ queries: 4, recommendations: 6 }], empty: [{ queries: 0, recommendations: 0 }] },
  { section: 'shelf', needle: 'GROUP BY status', rows: [{ name: 'want', count: 6 }], empty: [] },
  { section: 'shuyuan', needle: 'FROM shuyuan_sources', rows: [{ total: 10, active: 8 }], empty: [{ total: 0, active: 0 }] },
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
      library: { total: 12, withQuality: 10, avgQuality: 8.2, charsLabeled: 360000, genres: [{ name: '仙侠', count: 12 }] },
      download: { total: 3, done: 2, chapters: 100, chars: 400000 },
      find: { queries: 4, recommendations: 6 }, shelf: { statuses: [{ name: 'want', count: 6 }] },
      shuyuan: { total: 10, active: 8 }, tokens,
      availability: { library: true, download: true, find: true, shelf: true, shuyuan: true, tokens: true },
    });
    const findQuery = sql.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join('').includes('count(DISTINCT query)'));
    expect(findQuery?.slice(1)).toEqual(['书库添加']);
    expect(getLlmUsageStats).toHaveBeenCalledOnce();
  });

  it('keeps real empty aggregates at zero with available=true', async () => {
    mockQueries(undefined, true);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      library: { total: 0, withQuality: 0, avgQuality: null, charsLabeled: 0, genres: [] },
      download: { total: 0, done: 0, chapters: 0, chars: 0 }, find: { queries: 0, recommendations: 0 },
      shelf: { statuses: [] }, shuyuan: { total: 0, active: 0 }, tokens: emptyTokens,
      availability: { library: true, download: true, find: true, shelf: true, shuyuan: true, tokens: true },
    });
  });

  it.each(fixtures)('marks $section unavailable when $needle fails, keeping other partitions', async ({ section, needle }) => {
    mockQueries(needle);
    const res = await GET(request());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data[section]).toBeNull();
    expect(data.availability[section]).toBe(false);
    expect(data.code).toBe('STATS_PARTIAL');
    expect(data.error).toBe('部分统计暂不可用，请稍后重试');
    for (const key of Object.keys(data.availability)) {
      if (key === section) continue;
      expect(data.availability[key]).toBe(true);
      expect(data[key]).not.toBeNull();
    }
    expect(JSON.stringify(data)).not.toContain('private database details');
  });

  it.each(['schema', 'client', 'all queries'])('returns controlled 503 for failed %s', async (stage) => {
    if (stage === 'schema') ensureSchema.mockRejectedValue(new Error('private database details'));
    if (stage === 'client') getSql.mockImplementation(() => { throw new Error('private database details'); });
    if (stage === 'all queries') mockQueries('*');
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      library: null, download: null, find: null, shelf: null, shuyuan: null, tokens: null,
      availability: { library: false, download: false, find: false, shelf: false, shuyuan: false, tokens: false },
      error: '统计暂不可用，请稍后重试', code: 'STATS_UNAVAILABLE',
    });
    if (stage !== 'all queries') expect(sql).not.toHaveBeenCalled();
  });
});
