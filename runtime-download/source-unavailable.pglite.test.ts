// 41-EXEC-SRCUNAVAIL 验收：书源不可达（搜索阶段连接超时 / 源站 5xx）⇒ 任务回到可重试态、
// 日配额退还、零发布；4xx 与身份不符维持终态；连续不可达按 attempt_count 退避递增，封顶转终态。
// PGlite 真库 + 真 downloadBook（builtin 腿）+ 合成 transport + 内存 GitHub；不联网、不连生产。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema, loadPGlite, makeSqlTag, type PGliteLike } from './testing/pglite';
import { createWorkerStorage, type DownloadSql } from './storage';
import { createExecutor, DEFAULT_DECISIONS } from './executor';
import { assembleEngineModules, createResolveSource } from './engine';
import { createEngineAdapter, type SourceAdapter } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import { SourceHttpError } from '../src/lib/source-fetch';
import { downloadBook } from '../scripts/engine-download.mjs';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const MINUTE = 60_000;
const BOOK_URL = 'https://book15.net/books/details1.html';

class MemoryGitHub implements GitHubContents {
  calls: string[] = [];
  async put(path: string): Promise<void> { this.calls.push(`put ${path}`); }
  async getBytes(path: string): Promise<Buffer | null> { this.calls.push(`get ${path}`); return null; }
}

/** 日预算替身：与 shell daily-budget 同语义（领取成功才扣 1，触顶拒绝），并记下每次退还的票据。 */
function ledgerBudget(limit = 3) {
  let used = 0;
  const refunds: string[] = [];
  return {
    used: () => used,
    refunds,
    async read() { return { used, limit }; },
    async consume() {
      if (used >= limit) return { allowed: false, date: '2026-09-24', used, limit };
      used += 1;
      return { allowed: true, date: '2026-09-24', used, limit };
    },
    async refund(ticket: { key: string; date: string }) {
      refunds.push(ticket.key);
      used -= 1;
      return 'refunded' as const;
    },
  };
}

type LogLine = { level: string; message: string; fields?: Record<string, unknown> };

maybe('41-EXEC-SRCUNAVAIL：书源不可达不落终态、不耗日配额、零发布', () => {
  let pg: PGliteLike;
  let sql: DownloadSql;
  let github: MemoryGitHub;
  let outRoot: string;
  const modules = assembleEngineModules();

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = makeSqlTag(pg);
    await createSchema(pg);
    github = new MemoryGitHub();
    outRoot = mkdtempSync(join(tmpdir(), 'execfix41-'));
  }, 60_000);
  afterEach(() => rmSync(outRoot, { recursive: true, force: true }));

  const insertTask = async (): Promise<number> => Number(((await pg.query(
    `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind)
     VALUES (NULL, 1, '测试书', '佚名', 'pending', $1, 'system', 'builtin') RETURNING id`, [BOOK_URL],
  )).rows[0] as { id: number }).id);
  const row = async (id: number) => (await pg.query(
    `SELECT status, error, attempt_count, artifact_id,
            (extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::float8 AS delay_ms,
            to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at
     FROM download_tasks WHERE id = $1`, [id],
  )).rows[0] as { status: string; error: string; attempt_count: number; artifact_id: number | null; delay_ms: number | null; next_attempt_at: string | null };
  const artifactRows = async () => Number(((await pg.query('SELECT count(*)::int AS n FROM book_artifacts')).rows[0] as { n: number }).n);
  const dueNow = (id: number) => pg.query(`UPDATE download_tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);

  /** 真 downloadBook 的 builtin 腿；transport 按脚本失败或回页面（不联网）。 */
  const builtinAdapter = (transport: (url: string) => Promise<{ url: string; text: string }>): SourceAdapter => createEngineAdapter({
    downloadBook: downloadBook as never,
    modules,
    resolveSource: createResolveSource(modules) as never,
    transport: (async (url: string) => transport(url)) as never,
    readBookText: async () => { throw new Error('书源不可达时不应读整本'); },
    outRoot,
    sourceKind: 'builtin',
    rateMs: 0,
    timeoutMs: 2000,
  });
  const failingSearch = (error: () => unknown) => builtinAdapter(async () => { throw error(); });

  const runOnce = (adapter: SourceAdapter, budget: ReturnType<typeof ledgerBudget>, logs: LogLine[] = []) => createExecutor({
    storage: createWorkerStorage(sql),
    github,
    adapters: [adapter],
    budget,
    refundBudget: budget.refund,
    log: (level: string, message: string, fields?: Record<string, unknown>) => { logs.push({ level, message, fields }); },
    repositoryId: 1,
    branch: 'main',
    owner: 'worker-a',
    decisions: DEFAULT_DECISIONS,
  } as never).runOnce();

  it('① 搜索阶段 ConnectTimeout ⇒ 回到 pending（非终态）并排退避、配额退还、零发布、一行结构化日志', async () => {
    const id = await insertTask();
    const budget = ledgerBudget();
    const logs: LogLine[] = [];
    expect(await runOnce(failingSearch(() => new DOMException('书源连接超时', 'ConnectTimeoutError')), budget, logs))
      .toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state.status).toBe('pending');
    expect(state.error).toContain('source_unavailable');
    expect(state.attempt_count).toBe(2);
    expect(state.delay_ms).toBe(15 * MINUTE);
    expect(state.artifact_id).toBeNull();
    expect(budget.used()).toBe(0); // 领取扣 1、判定不可达退 1
    expect(budget.refunds).toHaveLength(1);
    expect(github.calls).toEqual([]);
    expect(await artifactRows()).toBe(0);
    // 退避生效：未到 next_attempt_at 不可再领
    expect(await createWorkerStorage(sql).claim('peek')).toBeNull();
    // 可观测：恰一行，只含原因码/阶段/源 host/下次可重试时刻，不含书名、作者、URL
    const lines = logs.filter(line => line.fields?.reason === 'source_unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0].fields).toEqual({ reason: 'source_unavailable', stage: 'search', host: 'book15.net', retryAt: state.next_attempt_at });
    const printed = JSON.stringify(logs);
    for (const secret of ['测试书', '佚名', 'details1', 'search.html', 'kw=', 'https://']) expect(printed).not.toContain(secret);
  });

  it.each([522, 503])('② 源站 HTTP %s ⇒ 同 ①：pending + 退避、配额退还、零发布', async status => {
    const id = await insertTask();
    const budget = ledgerBudget();
    expect(await runOnce(failingSearch(() => new SourceHttpError(status)), budget)).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state).toMatchObject({ status: 'pending', attempt_count: 2, artifact_id: null });
    expect(state.error).toContain('source_unavailable');
    expect(state.delay_ms).toBe(15 * MINUTE);
    expect(budget.used()).toBe(0);
    expect(github.calls).toEqual([]);
    expect(await artifactRows()).toBe(0);
  });

  it('③ 404 ⇒ 仍是终态 download_failed，不排退避、不退配额（防回归）', async () => {
    const id = await insertTask();
    const budget = ledgerBudget();
    const logs: LogLine[] = [];
    await runOnce(failingSearch(() => new SourceHttpError(404)), budget, logs);
    const state = await row(id);
    expect(state).toMatchObject({ status: 'failed', error: 'download_failed', attempt_count: 1, next_attempt_at: null });
    expect(budget.used()).toBe(1);
    expect(budget.refunds).toEqual([]);
    expect(logs.some(line => line.fields?.reason === 'source_unavailable')).toBe(false);
    expect(github.calls).toEqual([]);
  });

  it('④ identity_mismatch ⇒ 仍是终态，不退配额（防回归，身份门不放宽）', async () => {
    const id = await insertTask();
    const budget = ledgerBudget();
    const adapter = builtinAdapter(async url => (url.includes('/search')
      ? { url, text: '<a href="/books/details1.html">测试书</a>' }
      : { url, text: '<meta property="og:novel:book_name" content="测试书"><meta property="og:novel:author" content="另一位作者">' }));
    await runOnce(adapter, budget);
    const state = await row(id);
    expect(state).toMatchObject({ status: 'failed', error: 'identity_mismatch_or_no_candidate', attempt_count: 1, next_attempt_at: null });
    expect(budget.used()).toBe(1);
    expect(budget.refunds).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it('⑤ 同一任务重复不可达：每次领取各扣各退、票据互异，配额净零且不为负', async () => {
    const id = await insertTask();
    const budget = ledgerBudget();
    await runOnce(failingSearch(() => new SourceHttpError(522)), budget);
    await dueNow(id);
    await runOnce(failingSearch(() => new SourceHttpError(522)), budget);
    expect(budget.used()).toBe(0);
    expect(budget.refunds).toHaveLength(2);
    expect(new Set(budget.refunds).size).toBe(2); // 票据按「任务 id + 租约 generation」，一次扣减一张
    expect(budget.refunds.every(key => key.startsWith(`${id}:`))).toBe(true);
    expect((await row(id)).attempt_count).toBe(3);
  });

  it('⑥ 连续不可达 ⇒ 退避按 attempt_count 递增：15m → 30m → 1h → 2h', async () => {
    const id = await insertTask();
    const budget = ledgerBudget();
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await runOnce(failingSearch(() => new DOMException('书源连接超时', 'ConnectTimeoutError')), budget);
      const state = await row(id);
      expect(state.status).toBe('pending');
      delays.push(Number(state.delay_ms));
      await dueNow(id);
    }
    expect(delays).toEqual([15, 30, 60, 120].map(m => m * MINUTE));
    expect(budget.used()).toBe(0);
  });

  it('⑥ 上限：退避封顶 6h；第 16 次仍不可达 ⇒ 转终态 partial（source_unavailable），配额照退、零发布', async () => {
    const id = await insertTask();
    await pg.query('UPDATE download_tasks SET attempt_count = 15 WHERE id = $1', [id]);
    const budget = ledgerBudget();
    const logs: LogLine[] = [];
    await runOnce(failingSearch(() => new SourceHttpError(522)), budget, logs);
    const deferred = await row(id);
    expect(deferred).toMatchObject({ status: 'pending', attempt_count: 16 });
    expect(deferred.delay_ms).toBe(6 * 60 * MINUTE);
    await dueNow(id);
    await runOnce(failingSearch(() => new SourceHttpError(522)), budget, logs);
    const terminal = await row(id);
    expect(terminal.status).toBe('partial');
    expect(terminal.attempt_count).toBe(16);
    expect(terminal.error).toContain('source_unavailable');
    expect(budget.used()).toBe(0);
    expect(budget.refunds).toHaveLength(2);
    const lines = logs.filter(line => line.fields?.reason === 'source_unavailable');
    expect(lines.map(line => line.fields?.retryAt)).toEqual([deferred.next_attempt_at, null]);
    expect(github.calls).toEqual([]);
    expect(await artifactRows()).toBe(0);
  });
});
