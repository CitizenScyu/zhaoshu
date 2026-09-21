// T3 验收测试：worker 任务层（租约/心跳/单写者/发布对账/DB 故障注入）。
// PGlite 真库语义 + 内存 GitHub + mock adapter：不真实联网、不连生产库。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import {
  claimDownloadTask, finishDownloadTask, heartbeatDownloadTask, retryDownloadTask, updateDownloadTaskProgress,
} from './download-task-queue';
import { authSchemaV7Statement } from './auth-store';
import { initializeArtifactSchema } from './business-schema';
import { reserveArtifactPath } from './artifact-registry';
import {
  createEngineAdapter, runDownloadTask, runWorkerOnce, startLeaseHeartbeat,
  TaskLeaseLostError, isLeaseLostError,
  type AdapterOutcome, type SourceAdapter, type SourceAdapterContext, type WorkerOptions, type WorkerStorage,
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
  calls: { path: string; op: 'put' | 'get' }[] = [];
  constructor(public failAt?: { pathPattern: RegExp; op: 'put' | 'get'; error: Error }) {}
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
    reserveArtifactPath: input => reserveArtifactPath(sql as never, {
      labeledBookId: input.labeledBookId, identityKey: input.identityKey,
      repositoryId: input.repositoryId, branch: input.branch, canonicalPath: input.canonicalPath,
    }),
    registerArtifact: async input => {
      await sql`UPDATE book_artifacts SET quality_status = 'published', version = ${input.version},
        blob_sha = ${input.blobSha}, bytes = ${input.bytes}, chapters_total = ${input.chaptersTotal},
        chapters_done = ${input.chaptersDone}, chars = ${input.charsTotal}, snapshot_path = ${input.snapshotPath},
        source_revision = ${input.sourceRevision}, published_at = now()
        WHERE id = ${input.artifactId}`;
      const rows = await sql`UPDATE download_tasks SET artifact_id = ${input.artifactId}
        WHERE id = (SELECT id FROM download_tasks WHERE status = 'running' AND artifact_id IS NULL ORDER BY id DESC LIMIT 1)
        RETURNING id`;
      return rows.length === 1;
    },
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
    await pg.exec(`
      CREATE TABLE auth_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO auth_schema_migrations(version) SELECT generate_series(1, 6);
      CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO users(id) VALUES (1), (2);
      CREATE TABLE download_tasks (
        id serial PRIMARY KEY, book_id integer NOT NULL, title text NOT NULL, author text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'pending', source_url text NOT NULL DEFAULT '',
        chapters_total integer NOT NULL DEFAULT 0, chapters_done integer NOT NULL DEFAULT 0,
        chars_total integer NOT NULL DEFAULT 0, error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        user_id integer NOT NULL CONSTRAINT download_tasks_user_fk REFERENCES users(id)
      );
      CREATE TABLE labeled_books (
        id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '', source_url text NOT NULL DEFAULT '',
        title_key text GENERATED ALWAYS AS (lower(btrim(normalize(title, NFKC)))) STORED,
        author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED,
        UNIQUE (title_key, author_key)
      );
    `);
    // v7 迁移（真语句，不是副本）+ T2 artifact registry DDL
    {
      // authSchemaV7Statement 返回 Neon 查询 promise；给它 thenable 壳直接对 PGlite 执行。
      const tx = (parts: TemplateStringsArray, ...values: unknown[]) => ({
        then: (resolve: (rows: unknown) => unknown, reject: (e: unknown) => unknown) => {
          let text = ''; const params: unknown[] = [];
          parts.forEach((part, index) => { text += part; if (index < values.length) { params.push(values[index]); text += '$' + params.length; } });
          return pg.query(text, params).then(r => resolve(r.rows), reject) as unknown as Promise<unknown>;
        },
      });
      void (await authSchemaV7Statement(tx as never));
    }
    {
      // PGlite 适配器：标签查询返回行数组；transaction 以真 BEGIN/COMMIT 串行执行语句。
      type Stmt = { text: string; params: unknown[] };
      const toStmt = (parts: TemplateStringsArray, values: unknown[]): Stmt => {
        let text = ''; const params: unknown[] = [];
        parts.forEach((part, index) => { text += part; if (index < values.length) { params.push(values[index]); text += '$' + params.length; } });
        return { text, params };
      };
      const txTag = (parts: TemplateStringsArray, ...values: unknown[]) => {
        const stmt = toStmt(parts, values);
        return { ...stmt, then: (resolve: (rows: unknown) => unknown, reject: (e: unknown) => unknown) =>
          pg.query(stmt.text, stmt.params).then(r => resolve(r.rows), reject) as unknown as Promise<unknown> };
      };
      const txAdapter = Object.assign(txTag, {
        transaction: async (build: (tx: typeof txTag) => ReturnType<typeof txTag>[]) => {
          const stmts = build(txTag) as unknown as Stmt[];
          await pg.exec('BEGIN');
          try {
            const rows = [];
            for (const statement of stmts) rows.push((await pg.query(statement.text, statement.params)).rows);
            await pg.exec('COMMIT');
            return rows;
          } catch (error) {
            await pg.exec('ROLLBACK').catch(() => {});
            throw error;
          }
        },
      });
      await initializeArtifactSchema(txAdapter as never);
    }
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

  it('adapter 失败（failure）置 failed，同样零发布', async () => {
    const id = await insertTask();
    const result = await runDownloadTask(options([scriptAdapter({ kind: 'failure', code: 'identity_mismatch_or_no_candidate' })]), (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(result.terminal).toBe('failed');
    expect((await taskState(id)).status).toBe('failed');
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
    // hooks 被透传：进度上报发生
    expect(fakeDownload.mock.calls[0][4].onProgress).toBeTypeOf('function');
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
        registerArtifact: async input => {
          statements.push('register-artifact(update)');
          await sql`UPDATE book_artifacts SET quality_status = 'published', version = ${input.version}, blob_sha = ${input.blobSha}, bytes = ${input.bytes}, chapters_total = ${input.chaptersTotal}, chapters_done = ${input.chaptersDone}, chars = ${input.charsTotal}, snapshot_path = ${input.snapshotPath}, source_revision = ${input.sourceRevision}, published_at = now() WHERE id = ${input.artifactId}`;
          await sql`UPDATE download_tasks SET artifact_id = ${input.artifactId} WHERE id = ${id} AND status = 'running'`;
          return true;
        },
      }),
      github, adapters: [scriptAdapter({ kind: 'complete', txt: completeText('测试书', 2), chaptersTotal: 2, chaptersDone: 2, charsTotal: 1620 })],
      repositoryId: 1, branch: 'main',
    }, (await claimDownloadTask(sql as never, 'worker-a'))!);
    expect(statements.some(text => /\b(CREATE|ALTER|DROP)\b/i.test(text))).toBe(false);
    expect((await taskState(id)).status).toBe('done');
  });
});
