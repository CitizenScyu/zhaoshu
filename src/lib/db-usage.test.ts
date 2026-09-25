import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_USAGE_PHASES, parseLlmUsage, type LlmUsageRecord, type TokenTotals } from './llm-usage';

const mocks = vi.hoisted(() => ({ neon: vi.fn(), sql: vi.fn(), transaction: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));

const zero: TokenTotals = { prompt: 0, completion: 0, total: 0, cache: 0, calls: 0, missingUsageCalls: 0 };
const recall = { prompt: 120, completion: 30, total: 150, cache: 50, calls: 2, missingUsageCalls: 1 };
const recentRecall = { prompt: 20, completion: 5, total: 25, cache: 5, calls: 1, missingUsageCalls: 0 };
const profile = { prompt: 80, completion: 20, total: 100, cache: 20, calls: 1, missingUsageCalls: 0 };
const feedback = { ...zero, calls: 1, missingUsageCalls: 1 };
const record: LlmUsageRecord = {
  phase: 'find_recall', model: 'test-model', requestId: 'request-123', createdAt: '2026-09-15T00:00:00.000Z',
  usage: parseLlmUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 50 } }),
};

function queryText(call: unknown[]): string {
  const [parts] = call;
  expect(Array.isArray(parts)).toBe(true); // Neon HTTP sql 只使用标签模板。
  return (parts as TemplateStringsArray).join('?');
}

describe('LLM usage storage and aggregates (mocked Neon HTTP queries)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@database.invalid/test');
    mocks.neon.mockReturnValue(Object.assign(mocks.sql, { transaction: mocks.transaction }));
    mocks.sql.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (builder: (tx: typeof mocks.sql) => unknown[]) => builder(mocks.sql));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('creates the table, adds compatibility columns and indexes phase/time once under concurrent initialization', async () => {
    const { ensureUsageSchema } = await import('./db');
    await Promise.all([ensureUsageSchema(), ensureUsageSchema()]);
    await ensureUsageSchema();
    expect(mocks.sql).toHaveBeenCalledTimes(3);
    const queries = mocks.sql.mock.calls.map(queryText);
    expect(queries[0]).toContain('CREATE TABLE IF NOT EXISTS llm_usage');
    expect(queries[0]).toContain("CHECK (phase IN ('find_recall', 'find_rerank', 'profile', 'feedback'))");
    expect(queries[1]).toContain('ADD COLUMN IF NOT EXISTS total_tokens');
    expect(queries[1]).toContain('ADD COLUMN IF NOT EXISTS usage_details');
    expect(queries[2]).toContain('ON llm_usage (phase, created_at DESC)');
  });

  it('writes the actual counts, raw cache details and request metadata as bound values', async () => {
    const { recordLlmUsage } = await import('./db');
    await recordLlmUsage(record);
    const insert = mocks.sql.mock.calls.find((call) => queryText(call).includes('INSERT INTO llm_usage'))!;
    expect(insert.slice(1)).toEqual([
      record.createdAt, 'find_recall', 'test-model', 120, 30, 150, 50, false, 'request-123', JSON.stringify(record.usage.rawUsage),
    ]);
    expect(queryText(insert)).not.toContain('request-123');
  });

  it('stores unknown usage as zero with an explicit missing flag and nullable request id', async () => {
    const { recordLlmUsage } = await import('./db');
    await recordLlmUsage({ ...record, requestId: null, usage: parseLlmUsage(undefined) });
    const insert = mocks.sql.mock.calls.find((call) => queryText(call).includes('INSERT INTO llm_usage'))!;
    expect(insert.slice(1)).toEqual([record.createdAt, 'find_recall', 'test-model', 0, 0, 0, 0, true, null, '{}']);
  });

  // Part 2：观测字段叠在**已存在的** usage_details jsonb 里（零迁移）。这里钉住它的位置与内容：
  // 观测键在上游原始 usage 之**后**写，所以同名的上游字段会被我们观测到的真值覆盖。
  it('merges observation fields into the existing usage_details jsonb without adding columns', async () => {
    const { recordLlmUsage } = await import('./db');
    await recordLlmUsage({
      ...record,
      observation: {
        attempts: 2, firstByteTimeouts: 1, retried: true, fallbackUsed: false,
        ttfbMs: 12_345, errorCode: 'UPSTREAM_FIRST_BYTE_TIMEOUT',
      },
    });
    const insert = mocks.sql.mock.calls.find((call) => queryText(call).includes('INSERT INTO llm_usage'))!;
    expect(insert.slice(1)).toEqual([
      record.createdAt, 'find_recall', 'test-model', 120, 30, 150, 50, false, 'request-123',
      JSON.stringify({
        ...record.usage.rawUsage,
        attempts: 2, firstByteTimeouts: 1, retried: true, fallbackUsed: false,
        ttfbMs: 12_345, errorCode: 'UPSTREAM_FIRST_BYTE_TIMEOUT',
      }),
    ]);
    // 零迁移：整条写入路径的 SQL 里没有为观测字段新加的列/键（既有的 ALTER 只补 total_tokens
    // 与 usage_details 两列，是本改动之前就有的）。
    const sqlText = mocks.sql.mock.calls.map(queryText).join(' ');
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS usage_details');
    expect(sqlText).not.toMatch(/attempts|ttfb|cf_ray|error_code|first_byte/i);
  });

  it.each(['CREATE TABLE', 'INSERT INTO'])('logs a %s failure without rejecting business work', async (needle) => {
    mocks.sql.mockImplementation((parts: TemplateStringsArray) => {
      if (parts.join('').includes(needle)) throw new Error('usage database unavailable');
      return [];
    });
    const { recordLlmUsage } = await import('./db');
    await expect(recordLlmUsage(record)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      'LLM usage write failed:', { phase: 'find_recall', model: 'test-model', requestId: 'request-123' },
    );
  });

  it('retries failed usage initialization and leaves the main schema usable', async () => {
    mocks.sql.mockImplementation((parts: TemplateStringsArray) => {
      if (parts.join('').includes('llm_usage')) throw new Error('usage DDL unavailable');
      // 认证闸门读记账连续性（1..7 全在册）；喂齐全账本让 assertAuthSchema 放行。
      if (parts.join('').includes('FROM auth_schema_migrations')) return [1, 2, 3, 4, 5, 6, 7].map((version) => ({ version }));
      return [];
    });
    const { ensureSchema, recordLlmUsage } = await import('./db');
    await recordLlmUsage(record);
    await expect(ensureSchema()).resolves.toBeUndefined();
    expect(mocks.sql.mock.calls.map(queryText).join(' ')).not.toContain('recommendations_book_query_idx');
    mocks.sql.mockResolvedValue([]);
    await recordLlmUsage(record);
    expect(mocks.sql.mock.calls.filter((call) => queryText(call).includes('CREATE TABLE IF NOT EXISTS llm_usage'))).toHaveLength(2);
    expect(mocks.sql.mock.calls.filter((call) => queryText(call).includes('INSERT INTO llm_usage'))).toHaveLength(1);
  });

  it('keeps a missing DATABASE_URL non-fatal for usage recording', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { recordLlmUsage } = await import('./db');
    await expect(recordLlmUsage(record)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('aggregates all-time, recent and missing counts with one query, filling absent phases with zero', async () => {
    const { ensureUsageSchema, getLlmUsageStats } = await import('./db');
    await ensureUsageSchema();
    mocks.sql.mockClear();
    mocks.sql.mockResolvedValue([
      { phase: 'feedback', total: feedback, last_24h: feedback },
      { phase: 'find_recall', total: recall, last_24h: recentRecall },
      { phase: 'profile', total: profile, last_24h: profile },
    ]);
    expect(await getLlmUsageStats()).toEqual({
      total: { prompt: 200, completion: 50, total: 250, cache: 70, calls: 4, missingUsageCalls: 2 },
      last24h: { prompt: 100, completion: 25, total: 125, cache: 25, calls: 3, missingUsageCalls: 1 },
      byPhase: [
        { phase: 'find_recall', ...recall }, { phase: 'find_rerank', ...zero },
        { phase: 'profile', ...profile }, { phase: 'feedback', ...feedback },
      ],
    });
    expect(mocks.sql).toHaveBeenCalledOnce();
    const query = queryText(mocks.sql.mock.calls[0]);
    expect(query).toContain('FROM llm_usage GROUP BY phase');
    expect(query).toContain('sum(COALESCE(total_tokens, prompt_tokens + completion_tokens))');
    expect(query).toContain("count(*) FILTER (WHERE usage_missing AND created_at >= now() - interval '24 hours')");
    expect(query.match(/created_at >= now\(\) - interval '24 hours'/g)).toHaveLength(6);
    expect(query).not.toMatch(/SELECT\s+\*/);
  });

  it('returns a complete zero-valued result for an empty table', async () => {
    const { getLlmUsageStats } = await import('./db');
    expect(await getLlmUsageStats()).toEqual({
      total: zero, last24h: zero, byPhase: LLM_USAGE_PHASES.map((phase) => ({ phase, ...zero })),
    });
    expect(mocks.sql.mock.calls.filter((call) => queryText(call).includes('FROM llm_usage GROUP BY phase'))).toHaveLength(1);
  });

  it('preserves totals beyond signed 32-bit counters', async () => {
    const { ensureUsageSchema, getLlmUsageStats } = await import('./db');
    await ensureUsageSchema();
    mocks.sql.mockResolvedValue([{ phase: 'profile', total: { ...profile, prompt: 5_000_000_000, total: 5_000_000_020 }, last_24h: zero }]);
    expect((await getLlmUsageStats()).total).toMatchObject({ prompt: 5_000_000_000, total: 5_000_000_020 });
  });

  it('propagates query failure so stats can report unavailable instead of a false zero', async () => {
    const { ensureUsageSchema, getLlmUsageStats } = await import('./db');
    await ensureUsageSchema();
    mocks.sql.mockRejectedValue(new Error('read unavailable'));
    await expect(getLlmUsageStats()).rejects.toThrow('read unavailable');
  });
});
