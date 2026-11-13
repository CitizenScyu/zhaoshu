// T3 验收测试：worker 任务层（租约/心跳/单写者/发布对账/DB 故障注入）。
// PGlite 真库语义 + 内存 GitHub + mock adapter：不真实联网、不连生产库。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import {
  createArtifactSchema, createProductionSchema, upgradeToAuthV7,
} from './fixtures/production-schema';
import {
  claimDownloadTask, deferDownloadTask, finishDownloadTask, heartbeatDownloadTask, retryDownloadTask, updateDownloadTaskProgress,
} from './download-task-queue';
import { findArtifactBinding, reserveArtifactPath } from './artifact-registry';
import { HOST_WAIT_MAX_FREE_CLAIMS, HOST_WAIT_MAX_PROGRESS_CLAIMS } from './download-task-policy';
import { createWorkerStorage } from '../../runtime-download/storage';
import {
  createEngineAdapter, runDownloadTask, runWorkerOnce, startLeaseHeartbeat,
  TaskLeaseLostError, isLeaseLostError,
  type AdapterOutcome, type SourceAdapter, type SourceAdapterContext, type TaskRow, type WorkerOptions, type WorkerStorage,
} from './download-worker';
import {
  gitBlobSha, LeaseLostError, snapshotPaths, type GitHubContents,
} from './download-publisher';
type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

function queryTag(pg: PGliteLike): SqlTag {
  return (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  }) as SqlTag;
}

class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  calls: { path: string; op: 'put' | 'get' | 'del' }[] = [];
  constructor(public failAt?: { pathPattern: RegExp; op: 'put' | 'get' | 'del'; error: Error }) {}
  async put(path: string, text: string): Promise<void> {
    this.calls.push({ path, op: 'put' });
    if (this.failAt?.op === 'put' && this.failAt.pathPattern.test(path)) throw this.failAt.error;
    this.files.set(path, text);
  }
  async getBytes(path: string): Promise<Buffer | null> {
    this.calls.push({ path, op: 'get' });
    if (this.failAt?.op === 'get' && this.failAt.pathPattern.test(path)) throw this.failAt.error;
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
  async del(path: string): Promise<void> {
    this.calls.push({ path, op: 'del' });
    if (this.failAt?.op === 'del' && this.failAt.pathPattern.test(path)) throw this.failAt.error;
    this.files.delete(path);
  }
}

function scriptAdapter(outcome: AdapterOutcome | ((context: SourceAdapterContext) => Promise<AdapterOutcome>), hooks?: { onStart?: () => void; onProgressCalls?: { chaptersDone: number; chaptersTotal: number; charsTotal: number }[] }): SourceAdapter {
  return {
    kind: 'builtin',
    async download(task, context) {
      hooks?.onStart?.();
      const value = typeof outcome === 'function' ? await outcome(context) : outcome;
      // 触发一次进度上报，验证租约条件写
      if (value.kind !== 'failure' && 'chaptersDone' in value && hooks?.onProgressCalls) {
        hooks.onProgressCalls.push({ chaptersDone: value.chaptersDone, chaptersTotal: value.chaptersTotal, charsTotal: value.charsTotal });
      }
      void task;
      return value;
    },
  };
}

maybe('T3 worker 任务层：租约、单写者、五阶段对账（PGlite + mock GitHub）', () => {
  let pg: PGliteLike;
  let sql: SqlTag;
  let github: MemoryGitHub;
  let progressCalls: { chaptersDone: number; chaptersTotal: number; charsTotal: number }[];

  const storage = (over?: Partial<WorkerStorage>): WorkerStorage => ({
    claim: owner => claimDownloadTask(sql as never, owner),
    taskRow: async id => (await sql`SELECT id, book_id, title, author, status, source_url, source_kind, source_id, requested_by FROM download_tasks WHERE id = ${id}`)[0] as never,
    heartbeat: lease => heartbeatDownloadTask(sql as never, lease),
    progress: (lease, update) => updateDownloadTaskProgress(sql as never, lease, update),
    finish: (lease, result) => finishDownloadTask(sql as never, lease, result),
    defer: (lease, input) => deferDownloadTask(sql as never, lease, input),
    reserveArtifactPath: input => reserveArtifactPath(sql as never, {
      labeledBookId: input.labeledBookId, identityKey: input.identityKey,
      repositoryId: input.repositoryId, branch: input.branch, canonicalPath: input.canonicalPath,
    }),
    findArtifactBinding: input => findArtifactBinding(sql as never, input),
    registerArtifact: (lease, input) => createWorkerStorage(sql as never).registerArtifact(lease, input),
    ...over,
  });

  const options = (adapters: SourceAdapter[], over?: Partial<WorkerOptions>): WorkerOptions => ({
    storage: storage(),
    github,
    adapters,
    repositoryId: 1,
    branch: 'main',
    ...over,
  });

  const completeText = (title: string, chapters: number) =>
    [title, '佚名', '', ...Array.from({ length: chapters }, (_, i) => `【第${i + 1}章 合成。】\n\n${'正文'.repeat(400)}`)].join('\n');

  const insertTask = async (status = 'pending', overrides: Record<string, unknown> = {}): Promise<number> => {
    const keys = Object.keys(overrides);
    const columns = keys.map(key => `"${key}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 2}`).join(', ');
    const rows = await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind${keys.length ? `, ${columns}` : ''})
       VALUES (NULL, 1, '测试书', '佚名', $1, 'https://book15.net/books/1.html', 'system', 'builtin'${keys.length ? `, ${placeholders}` : ''})
       RETURNING id`,
      [status, ...Object.values(overrides)],
    );
    return Number((rows.rows[0] as { id: number }).id);
  };

  const taskState = async (id: number) =>
    (await pg.query('SELECT status, error, chapters_done, artifact_id, lease_owner, lease_generation FROM download_tasks WHERE id = $1', [id])).rows[0];

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = queryTag(pg);
    // 生产 schema 底座（auth v1–v7 真实 users/权限位/身份 CHECK）→ 0002 身份键 → artifact。
    // 由 fixtures/production-schema 复用生产初始化入口，**不手抄建表语句**：抄本会漂移，
    // 漂移过的 title_key 生成式让《余生》类漏匹配在测试里系统性隐形（2026-09-23 复核）。
    const schemaSql = createPGliteSql(pg);
    await createProductionSchema(schemaSql as never, statement => pg.exec(statement));
    await upgradeToAuthV7(schemaSql as never);
    await createArtifactSchema(schemaSql as never);
    await pg.exec(`
      INSERT INTO labeled_books(title, author, source_url) VALUES ('测试书', '佚名', 'https://book15.net/books/1.html');
      INSERT INTO storage_repositories(id, owner, repo, branch, enabled) VALUES (1, 'fixture', 'private', 'main', true);
    `);
    github = new MemoryGitHub();
    progressCalls = [];
  }, 60_000);

  it('完整链路：领取 → adapter → 快照/manifest/规范/指针/DB 五阶段 → done + artifact 登记', async () => {
    const id = await insertTask();
    const txt = completeText('测试书', 3);
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 }, { onProgressCalls: progressCalls })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('done');
    const state = await taskState(id);
    expect(state.status).toBe('done');
    expect(state.artifact_id).not.toBeNull();
    // GitHub 四阶段都写了。v2:快照与规范都是分卷清单 JSON,整本 <version>.txt 永不落盘(设计 §六);
    // 整本正文靠卷还原,规范提交点是 index.json 清单。
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    const version = gitBlobSha(txt).slice(0, 8);
    expect(github.files.has(`${dir}/${version}.json`)).toBe(true);
    expect(github.files.has(`${dir}/${version}.txt`)).toBe(false);
    expect(canonicalPath.endsWith('/index.json')).toBe(true);
    const canonical = JSON.parse(github.files.get(canonicalPath)!);
    expect(canonical.format).toBe('volumes');
    expect(canonical.blob_sha).toBe(gitBlobSha(txt)); // 清单钉住整本完整 hash
    expect(canonical.volumes.map((v: { path: string }) => github.files.get(v.path)).join('')).toBe(txt);
    expect(JSON.parse(github.files.get(`${dir}/current.json`)!).current).toBe(version);
    // DB 第五阶段：artifact published 且带完整 hash
    const artifact = (await pg.query('SELECT quality_status, blob_sha, bytes, version FROM book_artifacts')).rows[0];
    expect(artifact).toMatchObject({ quality_status: 'published', blob_sha: gitBlobSha(txt), version });
  });

  it('partial 零发布：缺章候选不触发任何 GitHub PUT，任务置 partial', async () => {
    const id = await insertTask();
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'incomplete', reason: 'missing_chapters', chaptersTotal: 10, chaptersDone: 7, charsTotal: 5000 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('partial');
    const state = await taskState(id);
    expect(state.status).toBe('partial');
    expect(String(state.error)).toContain('缺章 7/10');
    expect(github.calls).toHaveLength(0); // 零 GET 零 PUT
    expect((await pg.query('SELECT count(*)::int AS n FROM book_artifacts')).rows[0].n).toBe(0);
  });

  // donedup1113：产物已完整的 system 任务领取即 done（出网前拦）。生产背景：retrofix*/gapfill*
  // 手工批次入列不查产物完整度，书已全章发布后任务仍在 no_candidates 退避循环里每轮重扫全池空烧。
  // 用 createWorkerStorage 的真实 taskRow（拦截标志由那条 SELECT 计算），不是测试自己的内联绑定。
  describe('donedup1113 产物已完整的 system 任务领取即收口', () => {
    const publishArtifact = async (labeledBookId: number, done: number, total: number, status = 'published') => {
      const suffix = String(labeledBookId);
      await pg.query(
        `INSERT INTO book_artifacts (labeled_book_id, identity_key, repository_id, branch, canonical_path,
                                      quality_status, published_at, blob_sha, bytes, version, chapters_total, chapters_done, chars)
         VALUES ($1, $5, 1, 'main', $6,
                 $2, CASE WHEN $2 = 'published' THEN now() ELSE NULL END,
                 CASE WHEN $2 = 'published' THEN '0000000000000000000000000000000000000000' ELSE NULL END,
                 CASE WHEN $2 = 'published' THEN 12345 ELSE 0 END,
                 CASE WHEN $2 = 'published' THEN 'v1' ELSE '' END,
                 $3, $4, 12345)`,
        [labeledBookId, status, total, done, `donedup-${suffix}`, `donedup/${suffix}/index.json`],
      );
    };
    const realStorage = () => createWorkerStorage(sql as never);
    const skipOptions = (adapter: SourceAdapter): WorkerOptions =>
      options([adapter], { skipCompleted: true, storage: { ...storage(), taskRow: id => realStorage().taskRow(id) } });

    it('published 且全章 ⇒ 直接 done，adapter 不被调用、零出网', async () => {
      await publishArtifact(1, 128, 128);
      const id = await insertTask();
      let adapterRan = false;
      const result = await runDownloadTask(
        skipOptions(scriptAdapter({ kind: 'failure', code: 'should_never_run' }, { onStart: () => { adapterRan = true; } })),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(adapterRan).toBe(false);
      expect(result).toMatchObject({ processed: true, terminal: 'done', reason: 'artifact_already_complete' });
      expect((await taskState(id)).status).toBe('done');
      expect(github.calls).toHaveLength(0);
    });

    it('user 任务不拦（显式重下合法）：同产物、requested_by=user ⇒ 照常下载', async () => {
      await publishArtifact(1, 128, 128);
      const id = await insertTask();
      await pg.query(`UPDATE download_tasks SET requested_by = 'user', user_id = 1 WHERE id = $1`, [id]);
      const result = await runDownloadTask(
        skipOptions(scriptAdapter({ kind: 'complete', txt: completeText('测试书', 3), chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(result.reason).not.toBe('artifact_already_complete');
    });

    it('预留行（reserved、0/0）不算完整：reserveArtifactPath 建的行默认两值 0，照常下载', async () => {
      await publishArtifact(1, 0, 0, 'reserved');
      await insertTask();
      const result = await runDownloadTask(
        skipOptions(scriptAdapter({ kind: 'complete', txt: completeText('测试书', 3), chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(result.reason).not.toBe('artifact_already_complete');
    });

    it('缺章的 published 产物（300/500）不算完整：照常下载', async () => {
      await publishArtifact(1, 300, 500);
      await insertTask();
      const result = await runDownloadTask(
        skipOptions(scriptAdapter({ kind: 'complete', txt: completeText('测试书', 3), chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(result.reason).not.toBe('artifact_already_complete');
    });

    it('skipCompleted 缺省关：同产物完整也不拦（与引入前逐字一致）', async () => {
      await publishArtifact(1, 128, 128);
      await insertTask();
      const result = await runDownloadTask(
        options([scriptAdapter({ kind: 'complete', txt: completeText('测试书', 3), chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })],
          { storage: { ...storage(), taskRow: id2 => realStorage().taskRow(id2) } }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(result.reason).not.toBe('artifact_already_complete');
    });
  });

  it('adapter 失败（failure）置 failed，同样零发布', async () => {
    const id = await insertTask();
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'failure', code: 'identity_mismatch_or_no_candidate' })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('failed');
    expect((await taskState(id)).status).toBe('failed');
    expect(github.calls).toHaveLength(0);
  });

  it('41-bookidfk：孤儿任务（book_id 不在 labeled_books）写 book_artifacts 撞外键 → failed 且错误为可读码、零发布', async () => {
    // 复现 t8fk-41 task 292：库停在 artifact v1（没有 download_tasks_book_fk），旁路入队了 book_id=292。
    await pg.exec('ALTER TABLE download_tasks DROP CONSTRAINT download_tasks_book_fk');
    const id = await insertTask();
    await pg.query('UPDATE download_tasks SET book_id = 292 WHERE id = $1', [id]);
    const txt = completeText('测试书', 3);
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('failed');
    const state = await taskState(id);
    expect(state.status).toBe('failed');
    expect(String(state.error)).toMatch(/^LABELED_BOOK_MISSING: labeled_books id=292 不存在/);
    expect(String(state.error)).not.toMatch(/violates foreign key constraint/);
    expect(github.calls).toHaveLength(0);
  });

  it('更差候选不晋升：旧 100 章已发布 → 新 80 章 → superseded_by_incomplete，规范/指针保旧', async () => {
    // 先发布一个旧版
    const firstId = await insertTask();
    const oldTxt = completeText('测试书', 100);
    await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt: oldTxt, chaptersTotal: 100, chaptersDone: 100, charsTotal: 100 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect((await taskState(firstId)).status).toBe('done');
    github.calls.length = 0;
    // 新任务：更差候选（80 章）
    const secondId = await insertTask();
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt: completeText('测试书', 80), chaptersTotal: 80, chaptersDone: 80, charsTotal: 80 * 810 })]), (await claimDownloadTask(sql as never, 'worker-b'))!);
    expect(result.terminal).toBe('superseded_by_incomplete');
    const state = await taskState(secondId);
    expect(state.status).toBe('superseded_by_incomplete');
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    const oldVersion = gitBlobSha(oldTxt).slice(0, 8);
    // 规范内容仍是旧版:v2 规范是清单 index.json(非整本),清单仍钉旧版 hash、卷拼接仍还原旧正文。
    const canonical = JSON.parse(github.files.get(canonicalPath)!);
    expect(canonical.blob_sha).toBe(gitBlobSha(oldTxt));
    expect(canonical.volumes.map((v: { path: string }) => github.files.get(v.path)).join('')).toBe(oldTxt);
    expect(JSON.parse(github.files.get(`${dir}/current.json`)!).current).toBe(oldVersion);
    // 指针未重写（零指针 PUT）
    expect(github.calls.some(call => call.op === 'put' && call.path.endsWith('current.json'))).toBe(false);
    // 候选快照留档(分卷清单 JSON)
    const newVersion = gitBlobSha(completeText('测试书', 80)).slice(0, 8);
    expect(github.files.has(`${dir}/${newVersion}.json`)).toBe(true);
  });

  it('失租约停止：处理过程中行被 reclaim（generation+1）→ 无终态写入、无复活', async () => {
    const id = await insertTask();
    const adapter = scriptAdapter(async context => {
      // 模拟长时间抓取中租约被收回
      await pg.query(`UPDATE download_tasks SET status = 'failed', lease_generation = lease_generation + 1, lease_owner = '' WHERE id = $1`, [id]);
      const alive = await context.progress({ chaptersDone: 1, chaptersTotal: 3, charsTotal: 810 });
      void alive;
      return { kind: 'complete', txt: completeText('测试书', 3), chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 };
    });
    const result = await runDownloadTask(options([adapter]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('lease_lost');
    // 状态保持 reclaim 落下的 failed，不被旧进程改写
    const state = await taskState(id);
    expect(state.status).toBe('failed');
    expect(github.calls).toHaveLength(0); // 零发布
  });

  it('发布中段失租约（快照已落）→ LeaseLost 停止，规范/指针不写，DB 不误标 done', async () => {
    const id = await insertTask();
    const txt = completeText('测试书', 3);
    const adapter = scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 });
    const lease = await claimDownloadTask(sql as never, 'worker-a');
    // 让 guard 在 snapshot PUT 之后、manifest 之前失权：直接在 reserveArtifactPath 后收回
    const storageOver = storage({
      reserveArtifactPath: async input => {
        const artifactId = await reserveArtifactPath(sql as never, input);
        await pg.query(`UPDATE download_tasks SET status = 'failed', lease_generation = lease_generation + 1, lease_owner = '' WHERE id = ${lease!.id}`);
        return artifactId;
      },
    });
    const result = await runDownloadTask({ storage: storageOver, github, adapters: [adapter], repositoryId: 1, branch: 'main' }, lease!);
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('lease_lost');
    const state = await taskState(id);
    expect(state.status).toBe('failed'); // 收回方落的终态，未被复活
    const { canonicalPath } = snapshotPaths('测试书', '佚名');
    expect(github.files.has(canonicalPath)).toBe(false); // 规范未写
    expect(github.calls.some(call => call.op === 'put' && call.path.endsWith('current.json'))).toBe(false);
    // 快照/manifest 属内容寻址幂等产物，可能已落；任务行不指向任何 artifact
    expect(state.artifact_id).toBeNull();
  });

  it.each(['registered', 'already', 'lost', 'mismatch', 'unexpected'] as const)('登记结果%s：原样传lease并区分done、失权和失败', async (status) => {
    await insertTask();
    const lease = (await claimDownloadTask(sql as never, 'worker-a'))!;
    const base = storage();
    const finish = vi.fn(base.finish);
    // 此处仅验证worker映射，返回预设值不证明SQL原子性。
    const register = vi.fn<WorkerStorage['registerArtifact']>().mockResolvedValue(status as never);
    const result = await runDownloadTask({ storage: storage({ registerArtifact: register, finish }), github,
      adapters: [scriptAdapter({ kind: 'complete', txt: completeText('测试书', 3), chaptersTotal: 3, chaptersDone: 3, charsTotal: 2430 })],
      repositoryId: 1, branch: 'main' }, lease);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toBe(lease);
    expect(register.mock.calls[0][1]).toMatchObject({ artifactId: expect.any(Number), version: expect.any(String) });
    if (status === 'registered' || status === 'already') {
      expect(result.terminal).toBe('done');
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith(lease, { status: 'done', error: '' });
    } else if (status === 'lost') {
      expect(result).toMatchObject({ processed: false, reason: 'lease_lost' });
      expect(finish).not.toHaveBeenCalled();
    } else {
      expect(result.terminal).toBe('failed');
      expect(finish.mock.calls.map(([, value]) => value.status)).toEqual(['failed']);
      expect(finish.mock.calls[0][0]).toBe(lease);
    }
  });

  it('DB 阶段（第五阶段）失败：任务 failed 可对账，快照/manifest 已落不被重下破坏', async () => {
    const id = await insertTask();
    const txt = completeText('测试书', 3);
    const adapter = scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 });
    const storageOver = storage({
      registerArtifact: async () => {
        throw Object.assign(new Error('connection terminated'), { code: 'XX000' });
      },
    });
    const result = await runDownloadTask({ storage: storageOver, github, adapters: [adapter], repositoryId: 1, branch: 'main' }, (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('failed');
    const state = await taskState(id);
    expect(state.status).toBe('failed');
    const { dir, canonicalPath } = snapshotPaths('测试书', '佚名');
    const version = gitBlobSha(txt).slice(0, 8);
    // GitHub 侧前四阶段已落（可凭完整 hash 对账恢复），artifact 行仍是 reserved。
    // v2:规范/快照都是分卷清单 JSON,整本 <version>.txt 永不落盘,清单钉整本 hash + 卷拼接还原。
    expect(github.files.has(`${dir}/${version}.json`)).toBe(true);
    expect(github.files.has(`${dir}/${version}.txt`)).toBe(false);
    const canonical = JSON.parse(github.files.get(canonicalPath)!);
    expect(canonical.blob_sha).toBe(gitBlobSha(txt));
    expect(canonical.volumes.map((v: { path: string }) => github.files.get(v.path)).join('')).toBe(txt);
    const artifact = (await pg.query('SELECT quality_status FROM book_artifacts')).rows[0];
    expect(artifact.quality_status).toBe('reserved');
    // 修复路径：同内容重试（新 attempt）保留 manifest 原始字节
    const retryId = await retryDownloadTask(sql as never, id, null);
    const second = await runDownloadTask({ storage: storage(), github, adapters: [scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })], repositoryId: 1, branch: 'main' }, (await claimDownloadTask(sql as never, 'worker-b'))!);
    expect(second.terminal).toBe('done');
    expect(JSON.parse(github.files.get(`${dir}/${version}.json`)!).task_id).toBe(id); // 原 manifest 未被重写
    expect((await taskState(retryId)).status).toBe('done');
  });

  // B2-03：GitHub 写入失败（含规范阶段中途失败）放回 pending 退避，到期由 claim 重领、重跑后自愈。
  const retryState = async (id: number) => (await pg.query(
    `SELECT status, error, attempt_count, lease_owner,
            round(extract(epoch FROM (next_attempt_at - now())) / 60)::int AS delay_min
     FROM download_tasks WHERE id = $1`, [id],
  )).rows[0] as { status: string; error: string; attempt_count: number; lease_owner: string; delay_min: number | null };
  const badGateway = () => Object.assign(new Error('bad gateway'), { code: 'http_502' });

  it('B2-03 规范阶段中途失败（卷已换新、index.json 未写）→ pending + 15m 退避；到期重领重跑 → done 且规范收敛到新版', async () => {
    const oldTxt = completeText('测试书', 3);
    const firstId = await insertTask();
    await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt: oldTxt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect((await taskState(firstId)).status).toBe('done');

    const newTxt = completeText('测试书', 4);
    const newAdapter = scriptAdapter({ kind: 'complete', txt: newTxt, chaptersTotal: 4, chaptersDone: 4, charsTotal: 4 * 810 });
    const id = await insertTask();
    github.failAt = { pathPattern: /\/index\.json$/, op: 'put', error: badGateway() };
    const result = await runDownloadTask(options([newAdapter]), (await claimDownloadTask(sql as never, 'worker-b'))!);
    expect(result).toMatchObject({ processed: true, reason: 'publication_retry' });
    expect(result.terminal).toBeUndefined();
    expect(typeof result.retryAt).toBe('string');
    const deferred = await retryState(id);
    expect(deferred).toMatchObject({ status: 'pending', attempt_count: 2, lease_owner: '', delay_min: 15 });
    expect(deferred.error).toContain('canonical:http_502');
    // 半新半旧：规范卷已是新字节，index.json 仍钉旧版（recheck-41 情形 B 的现场）。
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    expect(JSON.parse(github.files.get(canonicalPath)!).blob_sha).toBe(gitBlobSha(oldTxt));
    expect(github.files.get(canonicalPath.replace(/index\.json$/, 'vol-001.txt'))).toBe(newTxt);

    // 退避未到期不可领；到期后同一行被 claim 重领（不新建行），重跑自愈。
    github.failAt = undefined;
    expect(await claimDownloadTask(sql as never, 'worker-c')).toBeNull();
    await pg.query("UPDATE download_tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
    const rerun = await runWorkerOnce(options([newAdapter]), 'worker-c');
    expect(rerun.terminal).toBe('done');
    expect((await taskState(id)).status).toBe('done');
    expect(JSON.parse(github.files.get(canonicalPath)!).blob_sha).toBe(gitBlobSha(newTxt));
    expect(JSON.parse(github.files.get(`${dir}/current.json`)!).current).toBe(gitBlobSha(newTxt).slice(0, 8));
    expect((await pg.query('SELECT count(*)::int AS n FROM download_tasks')).rows[0].n).toBe(2);
  });

  it('B2-03 快照阶段传输失败同样退避；第 3 次失败 ⇒ 30m（与书源不可达同阶梯、封顶 30m）', async () => {
    const id = await insertTask('pending', { attempt_count: 3 });
    github.failAt = { pathPattern: /\/v-[a-f0-9]{8}\.txt$/, op: 'put', error: badGateway() };
    const txt = completeText('测试书', 3);
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.reason).toBe('publication_retry');
    expect(result.stage).toBe('snapshot:http_502');
    const state = await retryState(id);
    expect(state).toMatchObject({ status: 'pending', attempt_count: 4, delay_min: 30 });
    expect(state.error).toContain('snapshot:http_502');
  });

  it('B2-03 有界：attempt_count 已到上限（16）⇒ failed 终态，不再入队', async () => {
    const id = await insertTask('pending', { attempt_count: 16 });
    github.failAt = { pathPattern: /\/index\.json$/, op: 'put', error: badGateway() };
    const txt = completeText('测试书', 3);
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result).toMatchObject({ processed: true, terminal: 'failed', retryAt: null });
    const state = await retryState(id);
    expect(state).toMatchObject({ status: 'failed', attempt_count: 16, delay_min: null });
    expect(state.error).toContain('停止自动重试');
  });

  it('B2-03 确定性失败（指针文件损坏 current_json_unreadable）不重试：直接 failed', async () => {
    const id = await insertTask();
    const { dir } = snapshotPaths('测试书', '佚名');
    github.files.set(`${dir}/current.json`, '{not json');
    const txt = completeText('测试书', 3);
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('failed');
    const state = await retryState(id);
    expect(state).toMatchObject({ status: 'failed', attempt_count: 1, delay_min: null });
    expect(state.error).toContain('current_json_unreadable');
  });

  it('B2-03 退避写入时租约已失 ⇒ lease_lost，不写任何状态（不与接管者并发）', async () => {
    const id = await insertTask();
    github.failAt = { pathPattern: /\/index\.json$/, op: 'put', error: badGateway() };
    const lease = await claimDownloadTask(sql as never, 'worker-a');
    const storageOver = storage({
      defer: async (held, input) => {
        await pg.query(`UPDATE download_tasks SET status = 'failed', lease_generation = lease_generation + 1, lease_owner = '' WHERE id = $1`, [id]);
        return deferDownloadTask(sql as never, held, input);
      },
    });
    const txt = completeText('测试书', 3);
    const result = await runDownloadTask({ storage: storageOver, github, adapters: [scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })], repositoryId: 1, branch: 'main' }, lease!);
    expect(result).toMatchObject({ processed: false, reason: 'lease_lost' });
    expect(await retryState(id)).toMatchObject({ status: 'failed', attempt_count: 1 });
  });

  // hostwait1031：回退候选 host 全被别的任务占着 ⇒ 开关开时排队放回、不计 attempt；不计数领取有上限。
  const occupied: AdapterOutcome = {
    kind: 'incomplete', reason: 'source_unavailable', stage: 'search', retryCause: 'host_occupied',
    chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
  };

  it('hostwait1031：开关开 ⇒ attempt 不变、30m 后重领；开关关 ⇒ 与改前一致（+1、15m 阶梯）', async () => {
    const id = await insertTask();
    const on = await runDownloadTask(options([scriptAdapter(occupied)], { hostWait: true }), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(on).toMatchObject({ processed: true, reason: 'source_unavailable', stage: 'search', hostWait: true });
    expect(on.terminal).toBeUndefined();
    const waited = await retryState(id);
    expect(waited).toMatchObject({ status: 'pending', attempt_count: 1, lease_owner: '', delay_min: 30 });
    expect(waited.error).toContain('host_occupied');
    await pg.query("UPDATE download_tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
    const off = await runDownloadTask(options([scriptAdapter(occupied)]), (await claimDownloadTask(sql as never, 'worker-b'))!);
    expect(off.hostWait).toBeUndefined();
    expect(await retryState(id)).toMatchObject({ status: 'pending', attempt_count: 2, delay_min: 15 });
  });

  it('hostwait1031：普通 source_unavailable（无 retryCause）开关开也照旧计数', async () => {
    const id = await insertTask();
    const plain: AdapterOutcome = { kind: 'incomplete', reason: 'source_unavailable', stage: 'search', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 };
    const result = await runDownloadTask(options([scriptAdapter(plain)], { hostWait: true }), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.hostWait).toBeUndefined();
    expect(await retryState(id)).toMatchObject({ status: 'pending', attempt_count: 2, delay_min: 15 });
  });

  it('breakeryield1031：retryCause host_breaker 开关开同样排队不计次，错误列标 host_breaker', async () => {
    const id = await insertTask();
    const breaker: AdapterOutcome = { ...occupied, stage: 'content', retryCause: 'host_breaker' };
    const result = await runDownloadTask(options([scriptAdapter(breaker)], { hostWait: true }), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result).toMatchObject({ processed: true, reason: 'source_unavailable', stage: 'content', hostWait: true });
    const waited = await retryState(id);
    expect(waited).toMatchObject({ status: 'pending', attempt_count: 1, delay_min: 30 });
    expect(waited.error).toContain('host_breaker');
  });

  it('recheckyield1031：retryCause recheck_unavailable 不走排队，开关开也照常计次退避', async () => {
    const id = await insertTask();
    const recheck: AdapterOutcome = { ...occupied, stage: 'toc', retryCause: 'recheck_unavailable' };
    const result = await runDownloadTask(options([scriptAdapter(recheck)], { hostWait: true }), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.hostWait).toBeUndefined();
    expect(await retryState(id)).toMatchObject({ status: 'pending', attempt_count: 2, delay_min: 15 });
  });

  it.each([
    [HOST_WAIT_MAX_FREE_CLAIMS - 2, 'pending'],
    [HOST_WAIT_MAX_FREE_CLAIMS - 1, 'partial'],
  ] as const)('hostwait1031 有界：已有 %i 次不计数领取 ⇒ %s（额度用尽回到计数路径，16 次照落 partial）', async (free, status) => {
    const id = await insertTask('pending', { attempt_count: 16, lease_generation: 16 + free });
    const result = await runDownloadTask(options([scriptAdapter(occupied)], { hostWait: true }), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe(status === 'partial' ? 'partial' : undefined);
    expect(await retryState(id)).toMatchObject({ status, attempt_count: 16 });
  });

  // breakerprogress1102：熔断让出且本轮有净增 ⇒ 不计数领取上限放宽到 HOST_WAIT_MAX_PROGRESS_CLAIMS；无进展/开关关照旧 32。
  const progressedBreaker: AdapterOutcome = { ...occupied, stage: 'content', retryCause: 'host_breaker', progressed: true };
  const stalledBreaker: AdapterOutcome = { ...occupied, stage: 'content', retryCause: 'host_breaker' };
  it.each<[number, boolean, AdapterOutcome, 'pending' | 'partial']>([
    [HOST_WAIT_MAX_FREE_CLAIMS - 1, true, progressedBreaker, 'pending'],
    [HOST_WAIT_MAX_PROGRESS_CLAIMS - 2, true, progressedBreaker, 'pending'],
    [HOST_WAIT_MAX_PROGRESS_CLAIMS - 1, true, progressedBreaker, 'partial'],
    [HOST_WAIT_MAX_FREE_CLAIMS - 1, true, stalledBreaker, 'partial'],
    [HOST_WAIT_MAX_FREE_CLAIMS - 1, false, progressedBreaker, 'partial'],
  ])('breakerprogress1102：已有 %i 次不计数领取、开关 %s（第 %# 例）', async (free, on, outcome, status) => {
    const id = await insertTask('pending', { attempt_count: 16, lease_generation: 16 + free });
    const result = await runDownloadTask(options([scriptAdapter(outcome)], { hostWait: true, ...(on ? { hostWaitProgress: true } : {}) }), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe(status === 'partial' ? 'partial' : undefined);
    expect(await retryState(id)).toMatchObject({ status, attempt_count: 16 });
  });

  it('同内容重试不破坏 manifest：第二次发布保留首次 task_id/generated_at，规范幂等', async () => {
    const id = await insertTask();
    const txt = completeText('测试书', 3);
    const first = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(first.terminal).toBe('done');
    const { dir } = snapshotPaths('测试书', '佚名');
    const originalManifest = github.files.get(`${dir}/${gitBlobSha(txt).slice(0, 8)}.json`)!;
    const originalGenerated = JSON.parse(originalManifest).generated_at;
    github.calls.length = 0;
    // 重试（新任务同内容）
    const secondId = await insertTask();
    const second = await runDownloadTask(options([scriptAdapter({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 })]), (await claimDownloadTask(sql as never, 'worker-b'))!);
    expect(second.terminal).toBe('done');
    expect(github.files.get(`${dir}/${gitBlobSha(txt).slice(0, 8)}.json`)).toBe(originalManifest);
    expect(JSON.parse(originalManifest).generated_at).toBe(originalGenerated);
    expect(JSON.parse(originalManifest).task_id).toBe(id); // 首次任务 id
    void secondId;
  });

  it('心跳：startLeaseHeartbeat 检测失租约并置信号；间隔不受进度写影响', async () => {
    const id = await insertTask();
    const lease = (await claimDownloadTask(sql as never, 'worker-a'))!;
    const heartbeat = startLeaseHeartbeat(storage(), lease, 10);
    expect(await heartbeat.check()).toBeUndefined();
    // 收回
    await pg.query(`UPDATE download_tasks SET status='failed', lease_generation = lease_generation + 1, lease_owner='' WHERE id = ${id}`);
    await expect(heartbeat.check()).rejects.toBeInstanceOf(TaskLeaseLostError);
    expect(heartbeat.signal.aborted).toBe(true);
    await heartbeat.stop();
    expect(isLeaseLostError(new TaskLeaseLostError())).toBe(true);
    expect(isLeaseLostError(new LeaseLostError())).toBe(true);
    expect(isLeaseLostError(new Error('x'))).toBe(false);
  });

  it('队列空：runWorkerOnce 返回 queue_empty；同任务不可被并发双领（SKIP LOCKED 语义）', async () => {
    expect((await runWorkerOnce(options([scriptAdapter({ kind: 'failure', code: 'noop' })]), 'worker-a')).reason).toBe('queue_empty');
    await insertTask();
    const [first, second] = await Promise.all([
      claimDownloadTask(sql as never, 'worker-a'),
      claimDownloadTask(sql as never, 'worker-b'),
    ]);
    expect(first === null || second === null).toBe(true); // PGlite 单会话串行：一次只有一个租约
  });

  it('engine adapter 接缝：code=0 → complete；missing_chapters → incomplete；抛错 → failure', async () => {
    const fakeDownload = vi.fn(async (_m: unknown, args: { source: string }, _resolve: unknown, _transport: unknown, hooks: { signal?: AbortSignal; onProgress?: (u: { chaptersDone: number; chaptersTotal: number; charsTotal: number }) => Promise<void> }) => {
      await hooks.onProgress?.({ chaptersDone: 2, chaptersTotal: 3, charsTotal: 1620 });
      // errors 故意不放 source_unavailable：该 reason 本就在 incomplete 名单内，
      // 删掉 `result.code===2` 分支测试仍绿。用 download_failed 才能钉住退出码契约。
      if (args.source.includes('dead')) return { code: 2, manifest: { status: 'partial', errors: ['download_failed'], chapters_total: 0, chapters_done: 0, chars: 0 } };
      // dlfail42：白名单外错误兜底 download_failed 时 manifest 带 failure_name（脱敏构造器名）
      // diag1031：downloadBook 自身抛出（如检查点锁 EEXIST）⇒ adapter_runtime_error 带构造器名/固定码，原文不带
      if (args.source.includes('throws')) throw Object.assign(new Error('EEXIST: synthetic path detail'), { code: 'EEXIST' });
      if (args.source.includes('opaque')) return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], failure_name: 'TypeError', chapters_total: 0, chapters_done: 0, chars: 0 } };
      // diag1030：带固定码与阶段；phasebad 的阶段不合白名单 ⇒ 该段省略
      if (args.source.includes('ruleerr')) return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], failure_name: 'RuleEngineError', failure_code: 'RULE_EVAL_FAILED', failure_phase: 'toc', chapters_total: 0, chapters_done: 0, chars: 0 } };
      if (args.source.includes('phasebad')) return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], failure_name: 'RuleEngineError', failure_code: 'bad code', failure_phase: 'To C', chapters_total: 0, chapters_done: 0, chars: 0 } };
      if (args.source.includes('noname')) return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], chapters_total: 0, chapters_done: 0, chars: 0 } };
      // breakeryield1031：熔断让出 ⇒ code=2 + retry_cause；其余 retry_cause 值不透传
      if (args.source.includes('breaker')) return { code: 2, manifest: { status: 'partial', errors: ['source_unavailable'], failure_stage: 'content', retry_cause: args.source.includes('breakerodd') ? 'other' : 'host_breaker', chapters_total: 3, chapters_done: 2, chars: 1620,
        // breakerprogress1102：progress_gain 正整数才透传 progressed
        ...(args.source.includes('breakergain') ? { progress_gain: 2 } : args.source.includes('breakerzero') ? { progress_gain: 0 } : {}) } };
      if (args.source.includes('recheck')) return { code: 2, manifest: { status: 'partial', errors: ['source_unavailable'], failure_stage: 'toc', retry_cause: 'recheck_unavailable', chapters_total: 3, chapters_done: 3, chars: 2430 } };
      const mode = args.source.includes('bad') ? 'missing' : 'ok';
      if (mode === 'ok') return { code: 0, manifest: { status: 'done', errors: [], chapters_total: 3, chapters_done: 3, chars: 2430, artifact: { file: 'book.txt', sha256: 'x', bytes: 9 } } };
      return { code: 1, manifest: { status: 'partial', errors: ['missing_chapters'], chapters_total: 3, chapters_done: 2, chars: 1620 } };
    });
    const adapter = createEngineAdapter({
      downloadBook: fakeDownload as never,
      modules: { api: {} },
      resolveSource: async () => ({ builtin: true }),
      readBookText: async () => '整本合成正文',
      outRoot: 'unused',
    });
    expect(adapter.kind).toBe('engine');
    const ok = await adapter.download({ id: 1, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://book15.net/x', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(ok).toMatchObject({ kind: 'complete', txt: '整本合成正文', chaptersTotal: 3 });
    const bad = await adapter.download({ id: 2, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://bad.example/y', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(bad).toMatchObject({ kind: 'incomplete', reason: 'missing_chapters', chaptersDone: 2 });
    // code=2（源不可用）单列分类：保留退出码契约，按可重试的 incomplete 收口，不落 failure 桶。
    const dead = await adapter.download({ id: 5, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://dead.example/z', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(dead).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable' });
    expect((dead as { retryCause?: string }).retryCause).toBeUndefined();
    // dlfail42：download_failed 兜底带 failure_name ⇒ failure 带 detail（构造器名类别）；
    // 同兜底但无 failure_name（老 manifest）⇒ 无 detail，行为不变。
    const opaque = await adapter.download({ id: 6, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://opaque.example/z', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(opaque).toMatchObject({ kind: 'failure', code: 'download_failed', detail: 'TypeError' });
    const run = (id: number, host: string) => adapter.download({ id, book_id: 1, title: 't', author: 'a', status: 'running', source_url: `https://${host}.example/z`, source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(await run(8, 'ruleerr')).toMatchObject({ kind: 'failure', code: 'download_failed', detail: 'RuleEngineError/RULE_EVAL_FAILED@toc' });
    expect(await run(9, 'phasebad')).toMatchObject({ kind: 'failure', code: 'download_failed', detail: 'RuleEngineError' });
    const thrown = await run(10, 'throws');
    expect(thrown).toMatchObject({ kind: 'failure', code: 'adapter_runtime_error', detail: 'Error/EEXIST' });
    expect(JSON.stringify(thrown)).not.toContain('synthetic path detail');
    expect(await run(11, 'breaker')).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable', stage: 'content', retryCause: 'host_breaker', chaptersDone: 2 });
    expect((await run(12, 'breakerodd') as { retryCause?: string }).retryCause).toBeUndefined();
    expect(await run(14, 'breakergain')).toMatchObject({ retryCause: 'host_breaker', progressed: true });
    expect((await run(15, 'breakerzero') as { progressed?: boolean }).progressed).toBeUndefined();
    expect((await run(16, 'breaker') as { progressed?: boolean }).progressed).toBeUndefined();
    expect(await run(13, 'recheck')).toMatchObject({ kind: 'incomplete', reason: 'source_unavailable', stage: 'toc', retryCause: 'recheck_unavailable' });
    const noname = await adapter.download({ id: 7, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://noname.example/z', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(noname).toMatchObject({ kind: 'failure', code: 'download_failed' });
    expect((noname as { detail?: string }).detail).toBeUndefined();
    // hooks 被透传：进度上报发生
    expect(fakeDownload.mock.calls[0][4].onProgress).toBeTypeOf('function');
  });

  it('resumeseed1031：engine adapter 开跑前以本任务 out 调 prepareOut；prepareOut 抛错不影响下载', async () => {
    const seen: string[] = [];
    const order: string[] = [];
    const make = (prepareOut: (out: string) => void) => createEngineAdapter({
      downloadBook: (async (_m: unknown, args: { out: string }) => {
        order.push(`download:${args.out}`);
        return { code: 0, manifest: { status: 'done', errors: [], chapters_total: 1, chapters_done: 1, chars: 3, artifact: { file: 'book.txt', sha256: 'x', bytes: 3 } } };
      }) as never,
      modules: {},
      resolveSource: async () => ({}),
      readBookText: async () => '合成文',
      outRoot: 'synthetic-out',
      prepareOut,
    });
    const task = { id: 1, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://seed.example/x', source_kind: 'engine', source_id: null, requested_by: 'system' } as const;
    const hooks = { signal: new AbortController().signal, progress: async () => {} };
    expect(await make(out => { seen.push(out); order.push(`prepare:${out}`); }).download(task, hooks)).toMatchObject({ kind: 'complete' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^synthetic-out\/[0-9a-f]{24}$/);
    expect(order).toEqual([`prepare:${seen[0]}`, `download:${seen[0]}`]);
    expect(await make(() => { throw new Error('synthetic seed failure'); }).download(task, hooks)).toMatchObject({ kind: 'complete' });
  });

  it('engine adapter：外部信号触发中断 → TaskLeaseLost 语义传播（同内容重试不破坏 manifest 由发布器保证）', async () => {
    const controller = new AbortController();
    const adapter = createEngineAdapter({
      downloadBook: (async (_m: unknown, _args: unknown, _resolve: unknown, _transport: unknown, hooks: { signal?: AbortSignal }) => {
        void hooks;
        controller.abort(new TaskLeaseLostError());
        return { code: 1, manifest: { status: 'partial', errors: ['interrupted'], chapters_total: 0, chapters_done: 0, chars: 0 } };
      }) as never,
      modules: {},
      resolveSource: async () => ({}),
      readBookText: async () => '',
      outRoot: 'unused',
    });
    // 中断由 onProgress 抛 TaskLeaseLostError 或外部 signal 已 abort 两种形态传播；
    // downloadBook 正常返回 partial 时，adapter 必须看到 signal.aborted 并转为失权错误。
    await expect(adapter.download({ id: 1, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://book15.net/x', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: controller.signal,
      progress: async () => {},
    })).rejects.toBeInstanceOf(TaskLeaseLostError);
    // signal.reason 为普通错误（非失权）时，不升格为失权：按 incomplete 收口
    const generic = new AbortController();
    generic.abort(new Error('interrupted'));
    const soft = createEngineAdapter({
      downloadBook: (async () => ({ code: 1, manifest: { status: 'partial', errors: ['interrupted'], chapters_total: 0, chapters_done: 0, chars: 0 } })) as never,
      modules: {},
      resolveSource: async () => ({}),
      readBookText: async () => '',
      outRoot: 'unused',
    });
    await expect(soft.download({ id: 2, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://book15.net/x', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: generic.signal,
      progress: async () => {},
    })).resolves.toMatchObject({ kind: 'incomplete', reason: 'interrupted' });
  });

  it('engine adapter：任务预算耗尽 → incomplete/budget_exhausted（保住检查点续传，不落 failed）', async () => {
    // 场景：worker 侧预算定时器先于引擎自身 budget 触发，外部 abort reason 透传进章循环后
    // 不再匹配引擎 knownError，errors[0] 退化为兜底 download_failed——adapter 必须按「谁触发的」归一。
    const deadline = new AbortController();
    const adapter = createEngineAdapter({
      downloadBook: (async (_m: unknown, _args: unknown, _resolve: unknown, _transport: unknown, hooks: { signal?: AbortSignal }) => {
        void hooks;
        deadline.abort(new Error('budget_exhausted'));
        return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], chapters_total: 10, chapters_done: 4, chars: 8100 } };
      }) as never,
      modules: {},
      resolveSource: async () => ({}),
      readBookText: async () => '',
      outRoot: 'unused',
    });
    await expect(adapter.download({ id: 3, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://book15.net/x', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: deadline.signal,
      progress: async () => {},
    })).resolves.toMatchObject({ kind: 'incomplete', reason: 'budget_exhausted', chaptersDone: 4, chaptersTotal: 10 });
    // 心跳失权（reason 为 TaskLeaseLostError 实例）仍必须升格，不被这条归一吞掉
    const lease = new AbortController();
    const lost = createEngineAdapter({
      downloadBook: (async () => {
        lease.abort(new TaskLeaseLostError());
        return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], chapters_total: 10, chapters_done: 4, chars: 8100 } };
      }) as never,
      modules: {},
      resolveSource: async () => ({}),
      readBookText: async () => '',
      outRoot: 'unused',
    });
    await expect(lost.download({ id: 4, book_id: 1, title: 't', author: 'a', status: 'running', source_url: 'https://book15.net/x', source_kind: 'engine', source_id: null, requested_by: 'system' }, {
      signal: lease.signal,
      progress: async () => {},
    })).rejects.toBeInstanceOf(TaskLeaseLostError);
  });

  it('runDownloadTask 端到端：taskTimeoutMs 耗尽 → DB 终态 partial（不是 failed）', async () => {
    // 复审阻断：taskTimer abort 合成 signal 后，incomplete 分支若无条件 throwIfAborted，
    // partial 永不写入、外层 catch 落 failed。本例经 runDownloadTask，删掉守卫放行即失败。
    const id = await insertTask();
    const adapter = createEngineAdapter({
      downloadBook: (async (_m: unknown, _args: unknown, _resolve: unknown, _transport: unknown, hooks: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          const s = hooks.signal;
          if (!s) return reject(new Error('missing signal'));
          if (s.aborted) return resolve();
          const watchdog = setTimeout(() => reject(new Error('budget timer did not fire')), 2000);
          s.addEventListener('abort', () => { clearTimeout(watchdog); resolve(); }, { once: true });
        });
        return { code: 1, manifest: { status: 'partial', errors: ['download_failed'], chapters_total: 10, chapters_done: 4, chars: 8100 } };
      }) as never,
      modules: {},
      resolveSource: async () => ({}),
      readBookText: async () => '',
      outRoot: 'unused',
    });
    const result = await runDownloadTask(
      options([adapter], { taskTimeoutMs: 30 }),
      (await claimDownloadTask(sql as never, 'worker-a'))!,
    );
    expect(result.terminal).toBe('partial');
    expect(result.reason).toBe('budget_exhausted');
    const state = await taskState(id);
    expect(state.status).toBe('partial');
    expect(String(state.error)).toContain('budget_exhausted');
    expect(github.calls).toHaveLength(0);
  });

  it('运行不做 DDL：任务层全程零 CREATE/ALTER 语句（对 sql 标签包装捕获）', async () => {
    const statements: string[] = [];
    const recording: SqlTag = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(parts.join('?'));
      return sql(parts, ...values);
    }) as SqlTag;
    const id = await insertTask();
    await runDownloadTask({
      storage: storage({
        claim: owner => claimDownloadTask(recording as never, owner),
        heartbeat: lease => heartbeatDownloadTask(recording as never, lease),
        progress: (lease, update) => updateDownloadTaskProgress(recording as never, lease, update),
        finish: (lease, result) => finishDownloadTask(recording as never, lease, result),
        registerArtifact: async (lease, input) => {
          statements.push('register-artifact(update)');
          return createWorkerStorage(sql as never).registerArtifact(lease, input);
        },
      }),
      github, adapters: [scriptAdapter({ kind: 'complete', txt: completeText('测试书', 2), chaptersTotal: 2, chaptersDone: 2, charsTotal: 1620 })],
      repositoryId: 1, branch: 'main',
    }, (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(statements.some(text => /\b(CREATE|ALTER|DROP)\b/i.test(text))).toBe(false);
    expect((await taskState(id)).status).toBe('done');
  });

  // tocfloor1111：下限证据（任务行 chapters_done）不被进度通道冲掉；同一次领取的腿间刷新下限。
  describe('tocfloor1111 任务层配套（WorkerOptions.tocFloor）', () => {
    const floorStorage = (over?: Partial<WorkerStorage>) => {
      const real = createWorkerStorage(sql as never);
      return storage({ taskRow: id => real.taskRow(id), ...over });
    };
    const legAdapter = (leg: (task: TaskRow, context: SourceAdapterContext) => Promise<AdapterOutcome>): SourceAdapter =>
      ({ kind: 'builtin', download: leg });
    const progressState = async (id: number) =>
      (await pg.query('SELECT status, error, chapters_done, chapters_total, chars_total FROM download_tasks WHERE id = $1', [id])).rows[0];
    // 一条腿抓到 120 章后，下一条腿取到 40 章的目录先报 0，再被闸门拒。rows 记下每次进度回调返回后行上的章数。
    const rejectedAfterProgress = (floors: unknown[], outcome: AdapterOutcome, rows: unknown[] = []) => legAdapter(async (task, context) => {
      floors.push(task.chapter_floor);
      await context.progress({ chaptersDone: 120, chaptersTotal: 200, charsTotal: 9000 });
      floors.push(task.chapter_floor);
      rows.push((await progressState(task.id)).chapters_done);
      await context.progress({ chaptersDone: 0, chaptersTotal: 40, charsTotal: 0 });
      floors.push(task.chapter_floor);
      rows.push((await progressState(task.id)).chapters_done);
      return outcome;
    });

    it('开：行上进度只升不降（腿报 0 后行即刻仍是 120，此刻崩溃也不丢）；腿内已抓章数即时抬高 task.chapter_floor', async () => {
      const id = await insertTask();
      const floors: unknown[] = [];
      const rows: unknown[] = [];
      const result = await runDownloadTask(
        options([rejectedAfterProgress(floors, { kind: 'failure', code: 'toc_below_floor' }, rows)], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('failed');
      expect(floors).toEqual([0, 120, 120]);
      expect(rows).toEqual([120, 120]);
      expect(await progressState(id)).toMatchObject({ status: 'failed', error: 'toc_below_floor', chapters_done: 120, chapters_total: 200, chars_total: 9000 });
    });

    it('关（缺省）：行留最后一次进度、下限不动，与引入前一致', async () => {
      const id = await insertTask();
      const floors: unknown[] = [];
      const rows: unknown[] = [];
      await runDownloadTask(
        options([rejectedAfterProgress(floors, { kind: 'failure', code: 'toc_below_floor' }, rows)], { storage: floorStorage() }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(floors).toEqual([0, 0, 0]);
      expect(rows).toEqual([120, 0]);
      expect(await progressState(id)).toMatchObject({ status: 'failed', chapters_done: 0, chapters_total: 40, chars_total: 0 });
    });

    it('开：partial、放回 pending（书源不可达退避）、限速反馈收口都留最高进度', async () => {
      const partial = await insertTask();
      await runDownloadTask(
        options([rejectedAfterProgress([], { kind: 'incomplete', reason: 'missing_chapters', chaptersTotal: 40, chaptersDone: 0, charsTotal: 0 })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(await progressState(partial)).toMatchObject({ status: 'partial', chapters_done: 120, chapters_total: 200 });
      const deferred = await insertTask();
      const result = await runDownloadTask(
        options([rejectedAfterProgress([], { kind: 'incomplete', reason: 'source_unavailable', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0, stage: 'search' })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result).toMatchObject({ processed: true, reason: 'source_unavailable' });
      expect(await progressState(deferred)).toMatchObject({ status: 'pending', chapters_done: 120, chapters_total: 200 });
      await pg.query(`UPDATE download_tasks SET status = 'failed' WHERE id = $1`, [deferred]); // 同书只许一条活跃系统任务
      const limited = await insertTask();
      const feedback = await runDownloadTask(
        options([legAdapter(async (task, context) => {
          await rejectedAfterProgress([], { kind: 'failure', code: 'download_failed' }).download(task, context);
          context.onFeedbackFailure?.({ code: 'LIMITER_FEEDBACK_UNAVAILABLE', origin: 'limiter-feedback' });
          return { kind: 'failure', code: 'download_failed' };
        })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(feedback).toMatchObject({ reason: 'limiter_feedback_unavailable' });
      expect(await progressState(limited)).toMatchObject({ status: 'failed', error: 'limiter_feedback_unavailable', chapters_done: 120 });
    });

    it('开：领取时行上已有的进度是历次最高的初值（上次领取抓到 120，这次的腿只报 0 就被拒）', async () => {
      const id = await insertTask('pending', { chapters_done: 120, chapters_total: 200, chars_total: 9000 });
      const floors: unknown[] = [];
      await runDownloadTask(
        options([legAdapter(async (task, context) => {
          floors.push(task.chapter_floor);
          await context.progress({ chaptersDone: 0, chaptersTotal: 40, charsTotal: 0 });
          return { kind: 'failure', code: 'toc_below_floor' };
        })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(floors).toEqual([120]);
      expect(await progressState(id)).toMatchObject({ status: 'failed', chapters_done: 120, chapters_total: 200, chars_total: 9000 });
    });

    it('开：腿没报过进度就失败 ⇒ 不写行（行原样）；腿抛异常 ⇒ failed 行留最高进度', async () => {
      const silent = await insertTask('pending', { chapters_done: 120, chapters_total: 200, chars_total: 9000 });
      let writes = 0;
      const counting = floorStorage({ progress: async (lease, update) => { writes += 1; return updateDownloadTaskProgress(sql as never, lease, update); } });
      await runDownloadTask(
        options([legAdapter(async () => ({ kind: 'failure', code: 'identity_mismatch_or_no_candidate' }))], { storage: counting, tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(writes).toBe(0);
      expect(await progressState(silent)).toMatchObject({ status: 'failed', chapters_done: 120 });
      const thrown = await insertTask();
      const result = await runDownloadTask(
        options([legAdapter(async (_task, context) => {
          await context.progress({ chaptersDone: 120, chaptersTotal: 200, charsTotal: 9000 });
          await context.progress({ chaptersDone: 0, chaptersTotal: 40, charsTotal: 0 });
          throw new Error('合成异常');
        })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('failed');
      expect(await progressState(thrown)).toMatchObject({ status: 'failed', chapters_done: 120, chapters_total: 200 });
    });

    it('开：complete 登记后把行改写成本次发布的章数（领取期间行上一直是 120）', async () => {
      const id = await insertTask();
      const txt = completeText('测试书', 3);
      const rows: unknown[] = [];
      const result = await runDownloadTask(
        options([legAdapter(async (task, context) => {
          await context.progress({ chaptersDone: 120, chaptersTotal: 200, charsTotal: 9000 });
          await context.progress({ chaptersDone: 3, chaptersTotal: 3, charsTotal: 3 * 810 });
          rows.push((await progressState(task.id)).chapters_done);
          return { kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 };
        })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(rows).toEqual([120]);
      expect(await progressState(id)).toMatchObject({ status: 'done', chapters_done: 3, chapters_total: 3, chars_total: 3 * 810 });
    });

    it('开：done 与章数同一条 UPDATE——腿结束后进度通道再写库出错也不会留下 done 行 120/200', async () => {
      const id = await insertTask();
      const txt = completeText('测试书', 3);
      let writes = 0;
      const flaky = floorStorage({
        progress: async (lease, update) => {
          writes += 1;
          if (writes > 2) throw new Error('合成库错误');
          return updateDownloadTaskProgress(sql as never, lease, update);
        },
      });
      const result = await runDownloadTask(
        options([legAdapter(async (_task, context) => {
          await context.progress({ chaptersDone: 120, chaptersTotal: 200, charsTotal: 9000 });
          await context.progress({ chaptersDone: 3, chaptersTotal: 3, charsTotal: 3 * 810 });
          return { kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 };
        })], { storage: flaky, tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(writes).toBe(2);
      expect(await progressState(id)).toMatchObject({ status: 'done', chapters_done: 3, chapters_total: 3, chars_total: 3 * 810 });
    });

    it('开：整本复用（腿不报进度直接 complete）⇒ done 行是本次发布的章数，不是上次领取留下的', async () => {
      const id = await insertTask('pending', { chapters_done: 120, chapters_total: 200, chars_total: 9000 });
      const txt = completeText('测试书', 3);
      const result = await runDownloadTask(
        options([legAdapter(async () => ({ kind: 'complete', txt, chaptersTotal: 3, chaptersDone: 3, charsTotal: 3 * 810 }))],
          { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result.terminal).toBe('done');
      expect(await progressState(id)).toMatchObject({ status: 'done', chapters_done: 3, chapters_total: 3, chars_total: 3 * 810 });
    });

    it('开：停机中止放回 pending 的行留最高进度（重领时作初值）', async () => {
      const id = await insertTask();
      const stop = new AbortController();
      const real = createWorkerStorage(sql as never);
      const result = await runDownloadTask(
        options([legAdapter(async (_task, context) => {
          await context.progress({ chaptersDone: 120, chaptersTotal: 200, charsTotal: 9000 });
          await context.progress({ chaptersDone: 0, chaptersTotal: 40, charsTotal: 0 });
          stop.abort();
          throw new Error('interrupted');
        })], { storage: floorStorage({ releaseClaim: lease => real.releaseClaim(lease) } as Partial<WorkerStorage>), tocFloor: true, shutdownSignal: stop.signal }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(result).toMatchObject({ processed: false, reason: 'shutdown_released' });
      expect(await progressState(id)).toMatchObject({ status: 'pending', chapters_done: 120, chapters_total: 200 });
    });

    it('nofloor- 任务（chapter_floor 为 null）：行上照样留最高进度，但不生成下限', async () => {
      const id = await insertTask('pending', { source_revision: 'nofloor-20261111' });
      const floors: unknown[] = [];
      await runDownloadTask(
        options([rejectedAfterProgress(floors, { kind: 'failure', code: 'download_failed' })], { storage: floorStorage(), tocFloor: true }),
        (await claimDownloadTask(sql as never, 'worker-a'))!,
      );
      expect(floors).toEqual([null, null, null]);
      expect(await progressState(id)).toMatchObject({ status: 'failed', chapters_done: 120 });
    });
  });
});
