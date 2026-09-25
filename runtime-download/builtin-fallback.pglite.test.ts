// 41-T8FB 验收：builtin 任务在 book15 不可达时回退引擎源池（PGlite 真库 + 生产装配 createDownloadExecutor，
// 合成 transport / 引擎 api / downloadBook + 内存 GitHub；不联网、不连生产）。
// 反例四件（任务书 §4）：
//   ① book15 不可达 + 引擎源身份匹配 ⇒ 下载成功（done + 发布），任务行仍绑 book15；
//   ② 作者不匹配 ⇒ 不下载、任务仍 pending（不扣额度）；
//   ③ 引擎源也失败 ⇒ 仍 pending 且退避生效（额度退还、最多试 MAX_FALLBACK_SOURCES 个源）；
//   ④ book15 可达 ⇒ 行为与改前一致（不碰引擎源池）。
// 另钉：host 级跳过（book15 已知不可达时一个请求都不打）、DOWNLOAD_ENGINE_FALLBACK=0 回到改前、预检关闭时下载腿自己回退。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema, loadPGlite, makeSqlTag, type PGliteLike } from './testing/pglite';
import { createWorkerStorage, type DownloadSql } from './storage';
import { createDownloadExecutor } from './entry';
import { DEFAULT_DECISIONS } from './executor';
import { assembleEngineModules } from './engine';
import { MAX_FALLBACK_SOURCES } from './builtin-fallback';
import type { GitHubContents } from '../src/lib/download-publisher';
import { recordHostFailure, recordHostSuccess } from '../src/lib/source-host-health';

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

/** shell daily-budget 的文件形态（{date, used}），配合 entry 的 budgetStatePath 走真退还。 */
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
type DownloadMode = 'done' | 'unavailable' | 'mismatch';

/** 同一本书在引擎站 host 上的搜索列表与详情。 */
const listing = (host: string, author = AUTHOR, listAuthor = author) => ({
  hits: [{ title: TITLE, author: listAuthor, bookUrl: `https://${host}/book/1` }],
  detail: { title: TITLE, author },
});

maybe('41-T8FB：builtin 任务 book15 不可达时回退引擎源池', () => {
  let pg: PGliteLike;
  let sql: DownloadSql;
  let github: MemoryGitHub;
  let workDir: string;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = makeSqlTag(pg);
    await createSchema(pg);
    github = new MemoryGitHub();
    workDir = mkdtempSync(join(tmpdir(), 't8fb41-'));
  }, 60_000);
  afterEach(() => {
    recordHostSuccess('book15.net'); // 清掉进程内 host 健康记忆，用例互不影响
    rmSync(workDir, { recursive: true, force: true });
  });

  const insertTask = async (): Promise<number> => Number(((await pg.query(
    `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind)
     VALUES (NULL, 1, $1, $2, 'pending', $3, 'system', 'builtin') RETURNING id`, [TITLE, AUTHOR, BOOK_URL],
  )).rows[0] as { id: number }).id);
  const row = async (id: number) => (await pg.query(
    `SELECT status, error, attempt_count, artifact_id, source_url, source_kind,
            (extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::float8 AS delay_ms
     FROM download_tasks WHERE id = $1`, [id],
  )).rows[0] as {
    status: string; error: string; attempt_count: number; artifact_id: number | null;
    source_url: string; source_kind: string; delay_ms: number | null;
  };

  /**
   * 生产装配 + 合成边界：
   * - transport：book15 两个 host 按 book15Reachable 决定连接超时或回合成页面；其余 host 不该被打到。
   * - 引擎 api：按 catalog 回搜索列表/详情（记录被搜的 host）。
   * - downloadBook：按 host 回 done/unavailable/mismatch（记录实际下载用的源 host）。
   */
  async function wired(opts: {
    catalog?: Catalog; pool?: string[]; downloads?: Record<string, DownloadMode>;
    book15Reachable?: boolean; env?: Record<string, string>;
  }) {
    const requests: string[] = [];
    const searched: string[] = [];
    const downloaded: string[] = [];
    const poolLoads: number[] = [];
    const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const catalog = opts.catalog ?? {};
    const downloads: Record<string, DownloadMode> = {
      'book15.net': opts.book15Reachable ? 'done' : 'unavailable', ...opts.downloads,
    };
    const search = `<div class="list-item-panel"><h3><a href="${BOOK_URL}">${TITLE}</a></h3><a class="author">${AUTHOR}</a></div><li itemprop="mainEntity"><a itemprop="url" href="${BOOK_URL}"><h2 itemprop="name">${TITLE}</h2></a><p itemprop="author">${AUTHOR}</p></li>`;
    const detail = `<h1>${TITLE}</h1><div class="d-info-panel"><a href="/author/1">${AUTHOR}</a></div><meta property="og:novel:book_name" content="${TITLE}"><meta property="og:novel:author" content="${AUTHOR}">`;
    const transport = async (url: string) => {
      requests.push(hostOf(url));
      if (!hostOf(url).endsWith('book15.net')) throw new Error(`unexpected host ${hostOf(url)}`);
      if (!opts.book15Reachable) throw new DOMException('书源连接超时', 'ConnectTimeoutError');
      return { url, text: url.includes('/search') ? search : detail };
    };
    const base = assembleEngineModules();
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
      const mode = downloads[host] ?? 'unavailable';
      if (mode === 'unavailable') {
        return { code: 2, manifest: { status: 'partial', errors: ['source_unavailable'], failure_stage: 'search', chapters: [] } };
      }
      if (mode === 'mismatch') return { code: 1, manifest: { status: 'partial', errors: ['identity_mismatch_or_no_candidate'], chapters: [] } };
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

  const expectNoBookText = (logs: unknown) => {
    const printed = JSON.stringify(logs);
    for (const secret of [TITLE, AUTHOR, 'details1', '/book/1', 'https://']) expect(printed).not.toContain(secret);
  };

  it('① book15 不可达 + 引擎源身份匹配 ⇒ 用引擎源下载成功并发布；任务行仍绑 book15；额度扣 1', async () => {
    const id = await insertTask();
    const w = await wired({
      pool: ['nomatch.example', 'good.example', 'later.example'],
      catalog: { 'nomatch.example': { hits: [], detail: { title: '', author: '' } }, 'good.example': listing('good.example'), 'later.example': listing('later.example') },
      downloads: { 'good.example': 'done' },
    });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state.status).toBe('done');
    expect(state.artifact_id).not.toBeNull();
    expect(state.source_url).toBe(BOOK_URL); // 不覆盖 book15 绑定
    expect(state.source_kind).toBe('builtin');
    expect(w.downloaded).toEqual(['good.example']); // 按池序首个身份匹配的源，book15 在预检已判不可达、不再下载
    expect(w.budget.used()).toBe(1);
    expect([...github.files.keys()].some(path => path.endsWith('/index.json'))).toBe(true);
    const used = w.logs.find(line => line.message === '引擎回退下载');
    expect(used?.fields).toMatchObject({ taskId: id, host: 'good.example', outcome: 'complete' });
    expectNoBookText(w.logs);
  });

  it('② 作者不匹配（列表带错作者 / 列表无作者但详情作者不符）⇒ 不下载、任务仍 pending、不扣额度', async () => {
    const id = await insertTask();
    const w = await wired({
      pool: ['listwrong.example', 'detailwrong.example'],
      catalog: {
        'listwrong.example': listing('listwrong.example', '别人'),
        'detailwrong.example': listing('detailwrong.example', '别人', ''),
      },
      downloads: { 'listwrong.example': 'done', 'detailwrong.example': 'done' },
    });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    const state = await row(id);
    expect(state).toMatchObject({ status: 'pending', attempt_count: 2, artifact_id: null, source_url: BOOK_URL });
    expect(state.error).toContain('source_unavailable');
    expect(w.searched).toEqual(['listwrong.example', 'detailwrong.example']);
    expect(w.downloaded).toEqual([]);
    expect(w.budget.used()).toBe(0);
    expect(github.files.size).toBe(0);
  });

  it('③ 引擎源也失败 ⇒ 最多试 MAX_FALLBACK_SOURCES 个源，仍 pending、退避 15m 生效、额度退还、零发布', async () => {
    const id = await insertTask();
    const pool = ['s1.example', 's2.example', 's3.example', 's4.example'];
    const w = await wired({
      pool,
      catalog: Object.fromEntries(pool.map(host => [host, listing(host)])),
      downloads: { 's1.example': 'unavailable', 's2.example': 'mismatch', 's3.example': 'unavailable', 's4.example': 'done' },
    });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(w.downloaded).toEqual(pool.slice(0, MAX_FALLBACK_SOURCES));
    const state = await row(id);
    expect(state).toMatchObject({ status: 'pending', attempt_count: 2, artifact_id: null });
    expect(state.delay_ms).toBe(15 * MINUTE);
    expect(w.budget.used()).toBe(0); // 领取扣 1、判不可达退 1
    expect(github.files.size).toBe(0);
    expect(await createWorkerStorage(sql).claim('peek')).toBeNull(); // 退避生效：未到期不可再领
    expect(w.logs.find(line => line.message === '书源不可达')?.fields).toMatchObject({ reason: 'source_unavailable', host: 'book15.net' });
  });

  it('④ book15 可达 ⇒ 与改前一致：只走 book15，不读引擎源池、不搜引擎源', async () => {
    const id = await insertTask();
    const w = await wired({ book15Reachable: true, pool: ['good.example'], catalog: { 'good.example': listing('good.example') } });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(await row(id)).toMatchObject({ status: 'done', source_url: BOOK_URL });
    expect(w.downloaded).toEqual(['book15.net']);
    expect(w.poolLoads).toEqual([]);
    expect(w.searched).toEqual([]);
    expect(w.logs.some(line => line.message.startsWith('引擎回退'))).toBe(false);
  });

  it('⑤ host 级跳过：book15 已知不可达（fetch 层健康记忆 suspect）⇒ 对 book15 一个请求都不打，直接回退', async () => {
    recordHostFailure('book15.net', 'timeout');
    recordHostFailure('book15.net', 'timeout');
    const id = await insertTask();
    const w = await wired({ pool: ['good.example'], catalog: { 'good.example': listing('good.example') }, downloads: { 'good.example': 'done' } });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(w.requests).toEqual([]);
    expect(w.downloaded).toEqual(['good.example']);
    expect((await row(id)).status).toBe('done');
  });

  it('⑤b host 级跳过 + 无匹配源 ⇒ 零出网直接退避（不再每本白等连接超时）', async () => {
    recordHostFailure('book15.net', 'timeout');
    recordHostFailure('book15.net', 'timeout');
    const id = await insertTask();
    const w = await wired({ pool: [] });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(w.requests).toEqual([]);
    expect(await row(id)).toMatchObject({ status: 'pending', attempt_count: 2 });
    expect(w.budget.used()).toBe(0);
  });

  it('⑥ DOWNLOAD_ENGINE_FALLBACK=0 ⇒ 回到改前：book15 不可达只退避，不读引擎源池', async () => {
    const id = await insertTask();
    const w = await wired({ env: { DOWNLOAD_ENGINE_FALLBACK: '0' }, pool: ['good.example'], catalog: { 'good.example': listing('good.example') }, downloads: { 'good.example': 'done' } });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(await row(id)).toMatchObject({ status: 'pending', attempt_count: 2 });
    expect(w.poolLoads).toEqual([]);
    expect(w.downloaded).toEqual([]);
    expect(w.logs.find(line => line.message === '执行器装配完成')?.fields?.engineFallback).toBe(false);
  });

  it('⑦ 预检关闭（DOWNLOAD_IDENTITY_PRECHECK=0）⇒ 下载腿 book15 判不可达后自己选源回退', async () => {
    const id = await insertTask();
    const w = await wired({
      env: { DOWNLOAD_IDENTITY_PRECHECK: '0' }, pool: ['good.example'],
      catalog: { 'good.example': listing('good.example') }, downloads: { 'good.example': 'done' },
    });
    expect(await w.executor.runOnce()).toBe(DEFAULT_DECISIONS.TASK_DONE);
    expect(w.downloaded).toEqual(['book15.net', 'good.example']);
    expect((await row(id)).status).toBe('done');
  });
});
