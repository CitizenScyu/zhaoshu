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

  const insertTask = async (): Promise<number> => Number(((await pg.query(
    `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind)
     VALUES (NULL, 1, $1, $2, 'pending', $3, 'system', 'builtin') RETURNING id`, [TITLE, AUTHOR, BOOK_URL],
  )).rows[0] as { id: number }).id);
  const row = async (id: number) => (await pg.query(
    `SELECT status, error, attempt_count, artifact_id, source_url,
            (extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::float8 AS delay_ms
     FROM download_tasks WHERE id = $1`, [id],
  )).rows[0] as { status: string; error: string; attempt_count: number; artifact_id: number | null; source_url: string; delay_ms: number | null };

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
});
