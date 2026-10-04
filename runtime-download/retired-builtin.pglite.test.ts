// 失效源整改（618）退休反例：真实注册表里 book15 已退休——builtin 下载任务的旧 book15 URL
// 在**真实注册表**（无 vi.mock）下必须零出网、零 builtin 下载腿，引擎回退照常可选源；
// 回退关闭（DOWNLOAD_ENGINE_FALLBACK=0）时按 source_unavailable 退避收口（可重试、零发布、不终态）。
// PGlite 真库 + 生产装配 createDownloadExecutor + 合成 transport/引擎 api/downloadBook + 内存 GitHub；不联网。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSchema, loadPGlite, makeSqlTag, type PGliteLike } from './testing/pglite';
import { createWorkerStorage, type DownloadSql } from './storage';
import { createDownloadExecutor } from './entry';
import { DEFAULT_DECISIONS } from './executor';
import type { GitHubContents } from '../src/lib/download-publisher';
import { reclaimStaleTasks } from '../src/lib/download-task-reclaim';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const MINUTE = 60_000;
const TITLE = '测试书';
const AUTHOR = '佚名';
const BOOK_URL = 'https://book15.net/books/details1.html';
const TXT = '第一章\n\n合成正文\n\n';

class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

const hostOf = (url: string) => new URL(url).hostname;
const utcToday = () => new Date().toISOString().slice(0, 10);

function fileBudget(path: string, limit = 3) {
  const read = () => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      return raw.date === utcToday() ? Number(raw.used) : 0;
    } catch { return 0; }
  };
  return {
    used: read,
    async read() { return { date: utcToday(), used: read() }; },
    async consume() {
      const used = read();
      if (used >= limit) return { allowed: false, date: utcToday(), used, limit };
      writeFileSync(path, JSON.stringify({ date: utcToday(), used: used + 1 }));
      return { allowed: true, date: utcToday(), used: used + 1, limit };
    },
  };
}

type Hit = { title: string; author: string; bookUrl: string };
type Catalog = Record<string, { hits: Hit[]; detail: { title: string; author: string } }>;

const listing = (host: string) => ({
  hits: [{ title: TITLE, author: AUTHOR, bookUrl: `https://${host}/book/1` }],
  detail: { title: TITLE, author: AUTHOR },
});

maybe('618 退休源反例：旧 book15 URL 的 builtin 下载任务（真实注册表）', () => {
  let pg: PGliteLike;
  let pgToClose: PGliteLike | undefined;
  let sql: DownloadSql;
  let github: MemoryGitHub;
  let workDir = '';

  beforeEach(async () => {
    pg = new PGliteCtor!();
    pgToClose = pg;
    sql = makeSqlTag(pg);
    await createSchema(pg);
    github = new MemoryGitHub();
    workDir = mkdtempSync(join(tmpdir(), 't8ret618-'));
  }, 60_000);
  afterEach(async () => {
    const current = pgToClose;
    pgToClose = undefined;
    try {
      if (current) {
        await current.close();
        expect(current).toHaveProperty('closed', true);
      }
    } finally {
      const directory = workDir;
      workDir = '';
      if (directory) {
        const target = resolve(directory);
        expect(dirname(target)).toBe(resolve(tmpdir()));
        expect(basename(target)).toMatch(/^t8ret618-[A-Za-z0-9]+$/);
        rmSync(target, { recursive: true, force: true });
      }
    }
  });

  const insertTask = async (opts: {
    requestedBy?: string; attemptCount?: number; status?: string; updatedAtAgoMs?: number;
  } = {}): Promise<number> => Number(((await pg.query(
    `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind, attempt_count, updated_at)
     VALUES (NULL, 1, $1, $2, $3, $4, $5, 'builtin', $6, now() - ($7::bigint * interval '1 millisecond')) RETURNING id`,
    [TITLE, AUTHOR, opts.status ?? 'pending', BOOK_URL, opts.requestedBy ?? 'system',
      opts.attemptCount ?? 0, opts.updatedAtAgoMs ?? 0],
  )).rows[0] as { id: number }).id);
  const row = async (id: number) => (await pg.query(
    `SELECT status, error, attempt_count, artifact_id, source_url, lease_owner,
            (extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::float8 AS delay_ms
     FROM download_tasks WHERE id = $1`, [id],
  )).rows[0] as { status: string; error: string; attempt_count: number; artifact_id: number | null; source_url: string; lease_owner: string; delay_ms: number | null };

  /** 生产装配 + 合成边界。transport 对任何请求一律记录并抛错（断言「零出网」）。 */
  async function wired(opts: { catalog?: Catalog; pool?: string[]; env?: Record<string, string>; strictDownload?: boolean }) {
    const requests: string[] = [];
    const searched: string[] = [];
    const downloaded: string[] = [];
    const poolLoads: number[] = [];
    const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const catalog = opts.catalog ?? {};
    const transport = async (url: string) => {
      requests.push(hostOf(url));
      throw new Error(`unexpected request to ${hostOf(url)}`); // 退休 host：任何请求都算违规
    };
    // 生产装配读真 supported（BUILTIN_SOURCES[0].lifecycle='retired'），只合成网络/下载边界。
    const base = await import('./engine').then((m) => m.assembleEngineModules());
    const modules = {
      ...base,
      compile: { ...base.compile, compileSource: () => ({}) },
      api: {
        ...base.api,
        engineSearchBook: async (engine: { url: string }) => { searched.push(hostOf(engine.url)); return catalog[hostOf(engine.url)]?.hits ?? []; },
        engineFetchDetail: async (engine: { url: string }) => catalog[hostOf(engine.url)]?.detail ?? {},
      },
    };
    const engineDownload = async (_m: unknown, args: Record<string, string>, _r: unknown, _t: unknown,
      hooks: { onProgress?: (u: { chaptersDone: number; chaptersTotal: number; charsTotal: number }) => Promise<void> }) => {
      const host = hostOf(args.source);
      downloaded.push(host);
      // 严格模式（退休反例专用）：任何下载腿调用都算违规——返回 code=2 让任务层按不可达收口并断言。
      if (opts.strictDownload) {
        return { code: 2, manifest: { status: 'partial', errors: ['source_unavailable'], failure_stage: 'resolve', chapters: [] } };
      }
      mkdirSync(args.out, { recursive: true });
      writeFileSync(join(args.out, 'book.txt'), TXT);
      await hooks.onProgress?.({ chaptersDone: 1, chaptersTotal: 1, charsTotal: 4 });
      return { code: 0, manifest: { status: 'done', errors: [], chapters_total: 1, chapters_done: 1, chars: 4, artifact: { file: 'book.txt', sha256: 'x', bytes: 1 } } };
    };
    const budgetPath = join(workDir, 'daily-budget.json');
    const budget = fileBudget(budgetPath);
    const executor = await createDownloadExecutor({
      budget, budgetStatePath: budgetPath, budgetLimit: 3, workDir,
      env: (opts.env ?? {}) as NodeJS.ProcessEnv,
      storage: createWorkerStorage(sql) as never, github,
      modules: modules as never, transport: transport as never, engineDownload: engineDownload as never,
      loadEnginePool: async () => {
        poolLoads.push(1);
        return (opts.pool ?? []).map(host => ({ url: `https://${host}/`, name: host, searchUrl: '/s?q={{key}}', rules: { x: 1 } }));
      },
      repositoryId: 1, branch: 'main', owner: 'worker-a',
      log: (level: string, message: string, fields?: Record<string, unknown>) => { logs.push({ level, message, fields }); },
    } as never);
    return { executor, requests, searched, downloaded, poolLoads, logs, budget };
  }

  it('① 退休 host + 引擎源身份匹配 ⇒ 零 book15 请求/零 builtin 下载腿，引擎源下载成功；任务行仍绑 book15', async () => {
    const id = await insertTask();
    const w = await wired({
      pool: ['good.example'],
      catalog: { 'good.example': listing('good.example') },
    });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state.status).toBe('done');
    expect(state.source_url).toBe(BOOK_URL); // 不覆盖 book15 绑定
    expect(w.requests).toEqual([]); // 退休 host 一个请求都不发（transport 任何调用都记为违规）
    expect(w.downloaded).toEqual(['good.example']); // 只下载引擎源；book15 下载腿零调用
    expect(w.searched).toEqual(['good.example']); // 回退选源只在引擎源上搜
    expect(w.budget.used()).toBe(1);
    expect([...github.files.keys()].some(path => path.endsWith('/index.json'))).toBe(true);
  });

  it('② 退休 host + 引擎源无此书 ⇒ 仍按 source_unavailable 退避（pending、15m、额度退还、零发布），零 book15 请求', async () => {
    const id = await insertTask();
    const w = await wired({ pool: ['nomatch.example'], catalog: { 'nomatch.example': { hits: [], detail: { title: '', author: '' } } } });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state).toMatchObject({ status: 'pending', attempt_count: 2, artifact_id: null, source_url: BOOK_URL });
    expect(state.error).toContain('source_unavailable');
    expect(state.delay_ms).toBe(15 * MINUTE);
    expect(w.requests).toEqual([]);
    expect(w.downloaded).toEqual([]);
    expect(w.budget.used()).toBe(0); // 领取扣 1、判不可达退 1
    expect(github.files.size).toBe(0);
  });

  it('③ DOWNLOAD_ENGINE_FALLBACK=0 ⇒ 退休 host 按不可达退避收口：不读池、零出网、额度退还', async () => {
    const id = await insertTask();
    // 回退关闭 = 回到改前装配：builtin 腿不再被 wrap，downloadBook 以任务行 book15 URL 被调用一次，
    // 但 resolveSource 的退休收口（code=2）使它**零出网**即返回 source_unavailable ⇒ 退避不终态。
    // strictDownload 桩按真实 downloadBook 的退休行为回 code=2（resolve 阶段）。
    const w = await wired({ env: { DOWNLOAD_ENGINE_FALLBACK: '0' }, pool: ['good.example'], catalog: { 'good.example': listing('good.example') }, strictDownload: true });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state).toMatchObject({ status: 'pending', attempt_count: 2, artifact_id: null });
    expect(state.error).toContain('source_unavailable');
    expect(w.poolLoads).toEqual([]); // 回退关闭：不读引擎源池
    expect(w.downloaded).toEqual(['book15.net']); // builtin 腿被调用一次（改前行为），但——
    expect(w.requests).toEqual([]); // ——零出网：退休在 resolve 即收口，不靠连接超时判出
    expect(w.budget.used()).toBe(0);
  });

  // 669：钉住 666 轮亲读的三条既有语义（不改生产代码）。
  // 依据：download-worker.ts:195–209 settleSourceUnavailable —— attemptCount<16 ⇒ defer 重排；
  //       否则 ⇒ finish 终态 partial（非 failed）。defer 语义见 download-task-queue.ts:223–233。
  it('④ user 任务同源不可用仍走 defer（不因 requested_by=user 而直接 failed）', async () => {
    // requested_by='user'、源不可用、attempt_count=0 < 16。
    // settleSourceUnavailable 不读 requested_by（download-worker.ts:190–209 无该判断），
    // 领取 +1 后 lease.attemptCount=1 < 16 ⇒ defer：download-task-queue.ts:225 置 status='pending'、
    // attempt_count=attempt_count+1、lease_owner=''。断言其未落 failed。
    const id = await insertTask({ requestedBy: 'user' });
    const w = await wired({ pool: ['nomatch.example'], catalog: { 'nomatch.example': { hits: [], detail: { title: '', author: '' } } } });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state.status).toBe('pending'); // 非 failed
    expect(state.status).not.toBe('failed');
    expect(state.attempt_count).toBe(2); // 领取 +1、defer +1
    expect(state.lease_owner).toBe('');
    expect(state.error).toContain('source_unavailable');
    expect(w.requests).toEqual([]);
  });

  it('⑤ attempt_count 达上限（16）⇒ finish 终态 partial 且不再重排（非 failed）', async () => {
    // 源不可用、领取后 lease.attemptCount 达 SOURCE_RETRY_MAX_ATTEMPTS=16（download-task-policy.ts:11）：
    // download-worker.ts:195 的 `attemptCount < 16` 为假 ⇒ download-worker.ts:203–208 走 finish(status:'partial')，
    // 不 defer。插入 attempt_count=15，领取 +1 ⇒ lease.attemptCount=16（上限）。
    const id = await insertTask({ attemptCount: 15 });
    const w = await wired({ pool: ['nomatch.example'], catalog: { 'nomatch.example': { hits: [], detail: { title: '', author: '' } } } });
    await w.executor.runOnce();
    const state = await row(id);
    expect(state.status).toBe('partial'); // 终态 partial，非 failed
    expect(state.status).not.toBe('failed');
    // finish 不改 attempt_count（download-task-queue.ts:202–208）：仍为领取后的 16；
    // 若发生 defer 则为 17 —— 据此钉住「不再重排」。
    expect(state.attempt_count).toBe(16);
    expect(state.error).toContain('source_unavailable');
    expect(w.requests).toEqual([]);
  });

  it('⑥ reclaim 对照：同一过期租约下 system 回 pending、user 直接 failed', async () => {
    // 依据 download-task-reclaim.ts:18–36：WHERE status='running' AND 心跳过期；
    //   requested_by='system' AND attempt_count < 16 ⇒ 'pending' 且 attempt_count+1；
    //   否则（含 user，不分次数）⇒ 'failed' 且 attempt_count 不变；两者 lease_owner=''（:34）。
    const staleAgo = 31 * MINUTE; // > DOWNLOAD_TASK_STALE_MS=30min（download-task-policy.ts:3）
    const sysId = await insertTask({ requestedBy: 'system', attemptCount: 0, status: 'running', updatedAtAgoMs: staleAgo });
    const userId = await insertTask({ requestedBy: 'user', attemptCount: 0, status: 'running', updatedAtAgoMs: staleAgo });
    await reclaimStaleTasks(sql);
    const sys = await row(sysId);
    const user = await row(userId);
    // 并列断言：同一回收谓词下两种 requested_by 的终态分叉。
    expect(sys.status).toBe('pending');
    expect(sys.attempt_count).toBe(1); // system 且 <16：attempt_count+1
    expect(sys.lease_owner).toBe('');
    expect(user.status).toBe('failed');
    expect(user.status).not.toBe('pending');
    expect(user.attempt_count).toBe(0); // user：attempt_count 不变（即使次数远低于上限）
    expect(user.lease_owner).toBe('');
  });
});
