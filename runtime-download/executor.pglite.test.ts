// T8 验收：执行器端到端（PGlite 真库 + 合成抓取 + 内存 GitHubContents，禁真网络/真 DB）。
// 覆盖：完整五阶段、partial 零发布、失权停止（无终态）、任务预算耗尽→可续传 partial、
// code=2 源不可用、日预算耗尽→BUDGET_EXHAUSTED 且任务回退 pending、空队列 NO_TASK。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema, loadPGlite, makeSqlTag, type PGliteLike } from './testing/pglite';
import { createWorkerStorage, type DownloadSql } from './storage';
import { createExecutor, DEFAULT_DECISIONS, type DailyBudgetLike } from './executor';
import type { SourceAdapter } from '../src/lib/download-worker';
import type { GitHubContents } from '../src/lib/download-publisher';
import { gitBlobSha, snapshotPaths } from '../src/lib/download-publisher';
import { createEngineAdapter } from '../src/lib/download-worker';
import { downloadBook } from '../scripts/engine-download.mjs';
import { assembleEngineModules, createResolveSource } from './engine';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  calls: { path: string; op: 'put' | 'get' }[] = [];
  async put(path: string, text: string): Promise<void> { this.calls.push({ path, op: 'put' }); this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    this.calls.push({ path, op: 'get' });
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

function fakeBudget(limit = 20): DailyBudgetLike & { used(): number } {
  let used = 0;
  return {
    used: () => used,
    async read() { return { used, limit }; },
    async consume() { if (used >= limit) return { allowed: false }; used += 1; return { allowed: true }; },
  };
}

type FakeManifest = { code: number; status: string; errors: string[]; total: number; done: number; chars: number; waitAbort?: boolean };
function fakeEngine(mode: Partial<FakeManifest> = {}) {
  const m: FakeManifest = { code: 0, status: 'done', errors: [], total: 3, done: 3, chars: 2430, ...mode };
  return async (_m: unknown, _a: unknown, _r: unknown, _t: unknown, hooks: { signal?: AbortSignal; onProgress?: (u: { chaptersDone: number; chaptersTotal: number; charsTotal: number }) => Promise<void> }) => {
    if (m.waitAbort) {
      // 模拟长抓取：等待任务预算定时器 abort，再以引擎兜底码返回 partial。
      await new Promise<void>((resolve) => {
        if (hooks.signal?.aborted) return resolve();
        hooks.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], chapters_total: m.total, chapters_done: m.done, chars: m.chars } };
    }
    await hooks.onProgress?.({ chaptersDone: m.done, chaptersTotal: m.total, charsTotal: m.chars });
    if (m.code === 0) return { code: 0, manifest: { status: 'done', errors: [], chapters_total: m.total, chapters_done: m.done, chars: m.chars, artifact: { file: 'book.txt', sha256: 'x', bytes: 1 } } };
    return { code: m.code, manifest: { status: m.status, errors: m.errors, chapters_total: m.total, chapters_done: m.done, chars: m.chars } };
  };
}

function engineAdapter(mode: Partial<FakeManifest>, txt = '整本合成正文'): SourceAdapter {
  return createEngineAdapter({
    downloadBook: fakeEngine(mode) as never,
    modules: {}, resolveSource: async () => ({}), readBookText: async () => txt, outRoot: 'unused',
  });
}

maybe('T8 执行器端到端：领取 → 合成抓取 → 五阶段发布 → DB 终态', () => {
  let pg: PGliteLike;
  let sql: DownloadSql;
  let github: MemoryGitHub;
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  const insertTask = async (status = 'pending', sourceKind = 'engine'): Promise<number> => {
    const rows = await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind)
       VALUES (NULL, 1, '测试书', '佚名', $1, 'https://book15.net/books/1.html', 'system', $2) RETURNING id`,
      [status, sourceKind],
    );
    return Number((rows.rows[0] as { id: number }).id);
  };
  const taskState = async (id: number) =>
    (await pg.query('SELECT status, error, artifact_id FROM download_tasks WHERE id = $1', [id])).rows[0] as { status: string; error: string; artifact_id: number | null };

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = makeSqlTag(pg);
    await createSchema(pg);
    github = new MemoryGitHub();
  }, 60_000);

  const deps = (adapters: SourceAdapter[], budget: DailyBudgetLike, over: Record<string, unknown> = {}) => ({
    storage: createWorkerStorage(sql), github, adapters, budget, repositoryId: 1, branch: 'main', owner: 'worker-a', decisions: DEFAULT_DECISIONS, ...over,
  });

  it('完整链路：done + artifact 登记 + 四阶段 GitHub 写入 + 日预算扣 1', async () => {
    const id = await insertTask();
    const budget = fakeBudget();
    const executor = createExecutor(deps([engineAdapter({}, '整本合成正文')], budget));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(await taskState(id)).toMatchObject({ status: 'done' });
    expect(budget.used()).toBe(1);
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    const version = gitBlobSha('整本合成正文').slice(0, 8);
    expect(github.files.has(`${dir}/${version}.txt`)).toBe(true);
    expect(github.files.has(`${dir}/${version}.json`)).toBe(true);
    expect(github.files.get(canonicalPath)).toBe('整本合成正文');
    expect(JSON.parse(github.files.get(`${dir}/current.json`)!).current).toBe(version);
    const artifact = (await pg.query('SELECT quality_status, version FROM book_artifacts')).rows[0];
    expect(artifact).toMatchObject({ quality_status: 'published', version });
  });

  it('空队列：NO_TASK 且不扣日预算', async () => {
    const budget = fakeBudget();
    const executor = createExecutor(deps([engineAdapter({})], budget));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.NO_TASK);
    expect(budget.used()).toBe(0);
  });

  it('partial 零发布：缺章候选无任何 GitHub PUT，任务 partial', async () => {
    const id = await insertTask();
    const budget = fakeBudget();
    const executor = createExecutor(deps([engineAdapter({ code: 1, status: 'partial', errors: ['missing_chapters'], total: 10, done: 7, chars: 5000 })], budget));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await taskState(id);
    expect(state.status).toBe('partial');
    expect(state.error).toContain('缺章 7/10');
    expect(github.calls).toHaveLength(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM book_artifacts')).rows[0].n).toBe(0);
    expect(budget.used()).toBe(1);
  });

  it('code=2 源不可用：可重试的 partial（source_unavailable），零发布', async () => {
    const id = await insertTask();
    const executor = createExecutor(deps([engineAdapter({ code: 2, status: 'partial', errors: ['source_unavailable'], total: 0, done: 0, chars: 0 })], fakeBudget()));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await taskState(id);
    expect(state.status).toBe('partial');
    expect(state.error).toContain('source_unavailable');
    expect(github.calls).toHaveLength(0);
  });

  it('code=2 端到端：真实 createResolveSource 抛 ResolveSourceError(2) → 真实 downloadBook → source_unavailable partial', async () => {
    // 发现 3：走真实 createResolveSource + 真实 downloadBook（非 stub），钉住 code=2 的
    // 端到端转译（resolve 抛 code 2 → downloadBook failureCode=2 → errors[source_unavailable]
    // → adapter incomplete → 任务 partial）。非 https URL 触发 ResolveSourceError(2)。
    const rows = await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind)
       VALUES (NULL, 1, '测试书', '佚名', 'pending', 'http://book15.net/books/1.html', 'system', 'engine') RETURNING id`,
    );
    const id = Number((rows.rows[0] as { id: number }).id);
    const outRoot = mkdtempSync(join(tmpdir(), 't8-resolve-'));
    tmpDirs.push(outRoot);
    const modules = assembleEngineModules();
    const adapter = createEngineAdapter({
      downloadBook: downloadBook as never,
      modules,
      resolveSource: createResolveSource(modules),
      readBookText: async () => { throw new Error('should not read book on code=2'); },
      outRoot,
      sourceKind: 'engine',
    });
    const executor = createExecutor(deps([adapter], fakeBudget()));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await taskState(id);
    expect(state.status).toBe('partial');
    expect(state.error).toContain('source_unavailable');
    expect(github.calls).toHaveLength(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM book_artifacts')).rows[0].n).toBe(0);
  });

  it('失权停止：抓取中租约被收回 → 无终态写入、无发布；决策 TASK_DONE（任务已尝试）', async () => {
    const id = await insertTask();
    const adapter: SourceAdapter = {
      kind: 'engine',
      async download(_task, ctx) {
        await pg.query(`UPDATE download_tasks SET status='failed', lease_generation = lease_generation + 1, lease_owner='' WHERE id = $1`, [id]);
        await ctx.progress({ chaptersDone: 1, chaptersTotal: 3, charsTotal: 10 });
        return { kind: 'complete', txt: '整本合成正文', chaptersTotal: 3, chaptersDone: 3, charsTotal: 2430 };
      },
    };
    const executor = createExecutor(deps([adapter], fakeBudget()));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect((await taskState(id)).status).toBe('failed'); // 收回方落的终态未被旧进程改写
    expect(github.calls).toHaveLength(0);
  });

  it('引擎自身预算耗尽：归一切续传 partial（不落 failed），零发布', async () => {
    const id = await insertTask();
    const executor = createExecutor(deps([engineAdapter({ code: 1, status: 'partial', errors: ['budget_exhausted'], total: 10, done: 4, chars: 8100 })], fakeBudget()));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await taskState(id);
    expect(state.status).toBe('partial');
    expect(state.error).toContain('budget_exhausted');
    expect(github.calls).toHaveLength(0);
  });

  it('worker 侧预算定时器 abort：归一切续传 partial，零发布', async () => {
    const id = await insertTask();
    const executor = createExecutor(deps([engineAdapter({ waitAbort: true, total: 10, done: 4, chars: 8100 })], fakeBudget(), { taskTimeoutMs: 40 }));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect((await taskState(id)).status).toBe('partial');
    expect(github.calls).toHaveLength(0);
  });

  it('日预算耗尽：领取后 consume 拒绝 → BUDGET_EXHAUSTED，任务回退 pending，零发布', async () => {
    const id = await insertTask();
    const budget = fakeBudget(0);
    const executor = createExecutor(deps([engineAdapter({})], budget));
    expect(await executor.runOnce()).toBe(DEFAULT_DECISIONS.BUDGET_EXHAUSTED);
    expect((await taskState(id)).status).toBe('pending'); // 回退，不占租约、不 stranding
    expect(budget.used()).toBe(0);
    expect(github.calls).toHaveLength(0);
  });
});
