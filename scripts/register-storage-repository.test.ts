// 41-coldbuild：storage_repositories 仓位登记入口的参数解析、幂等语义与真库（PGlite）行为。
import { describe, expect, it } from 'vitest';
import { initializeArtifactSchema } from '../src/lib/artifact-schema';
import { loadPGlite, type PGliteLike } from '../src/lib/fixtures/pglite';
import { createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import {
  DEFAULT_BRANCH, DEFAULT_REPO, inspectRegistration, parseRegisterArgs, planRegistration, runRegistration,
} from './register-storage-repository.mjs';

describe('参数解析：目标显式给出，仓库键来自配置/缺省', () => {
  it.each([
    [[], /--database-url-env/],
    [['--dry-run'], /--database-url-env/],
    [['--database-url-env=', '--dry-run'], /--database-url-env/],
    [['--database-url-env=prod_url', '--dry-run'], /大写变量名/],
    [['--database-url-env=DATABASE_URL', '--dry-run'], /不能是 DATABASE_URL/],
    [['--database-url-env=TEST_DATABASE_URL', '--dry-run'], /不能是 TEST_DATABASE_URL/],
    [['--database-url-env=PROD_URL', '--dry-run', '--apply'], /不能同时给/],
    [['--database-url-env=PROD_URL', '--bogus'], /未知参数/],
    [['--database-url-env=PROD_URL', '--repo=onlyowner'], /owner\/repo 形态/],
    [['--database-url-env=PROD_URL', '--repo=a/b/c'], /owner\/repo 形态/],
  ])('%j 被拒绝', (argv, message) => {
    expect(() => parseRegisterArgs(argv, {})).toThrow(message);
  });

  it('缺省：无 --repo/--branch 时回落到环境变量，再回落到代码现役缺省', () => {
    expect(parseRegisterArgs(['--database-url-env=PROD_URL'], {})).toMatchObject({ owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main' });
    expect(parseRegisterArgs(['--database-url-env=PROD_URL'], {})).toMatchObject({ owner: DEFAULT_REPO.split('/')[0], branch: DEFAULT_BRANCH });
    expect(parseRegisterArgs(['--database-url-env=PROD_URL'], { ZHAOSHU_BOOKS_REPO: 'Org/Repo', DOWNLOAD_TARGET_BRANCH: 'rel' }))
      .toMatchObject({ owner: 'Org', repo: 'Repo', branch: 'rel', mode: 'dry-run' });
    expect(parseRegisterArgs(['--database-url-env=PROD_URL', '--repo=X/y', '--branch=z'], {}))
      .toMatchObject({ owner: 'X', repo: 'y', branch: 'z' });
    expect(parseRegisterArgs(['--database-url-env=PROD_URL', '--apply'], {}).mode).toBe('apply');
  });

  it('env 里的仓库键非法也拒绝（不静默用缺省顶替）', () => {
    expect(() => parseRegisterArgs(['--database-url-env=PROD_URL'], { ZHAOSHU_BOOKS_REPO: 'noslash' })).toThrow(/owner\/repo 形态/);
  });
});

describe('planRegistration（纯函数）：已有可写行即空转，不擅自解封', () => {
  const key = { owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main' };
  it('无行 → insert', () => {
    expect(planRegistration({ present: false }, key)).toMatchObject({ status: 'insert', planned: { enabled: true, is_private: true, read_only: false } });
  });
  it('已有可写行（同分支）→ noop', () => {
    const state = { present: true, writable: true, branchOk: true, existing: { id: 1, branch: 'main', enabled: true, private: true, readOnly: false, sealed: false } };
    expect(planRegistration(state, key)).toMatchObject({ status: 'noop', existing: { id: 1 } });
  });
  it('已有但不可写 → refused（不解封 sealed / read_only）', () => {
    const state = { present: true, writable: false, branchOk: true, existing: { id: 2, branch: 'main', enabled: false, private: true, readOnly: false, sealed: false } };
    const plan = planRegistration(state, key);
    expect(plan.status).toBe('refused');
    expect(plan.reason).toMatch(/不满足可写判据.*enabled=false/);
  });
  it('已有但分支不符 → refused（身份唯一，不能再插一行）', () => {
    const state = { present: true, writable: false, branchOk: false, existing: { id: 3, branch: 'other', enabled: true, private: true, readOnly: false, sealed: false } };
    const plan = planRegistration(state, key);
    expect(plan.status).toBe('refused');
    expect(plan.reason).toMatch(/branch=other ≠ 目标 main/);
  });
});

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('runRegistration（PGlite 真库）', () => {
  // artifact schema 的 book_artifacts 对 labeled_books(id) 与 download_tasks 有外键依赖；
  // 本用例只关心 storage_repositories，故建两张最小父表（与迁移 0001 的形状无关，够用即可）。
  // download_tasks 要有 book_id：artifact v2（41-bookidfk）给它加指向 labeled_books(id) 的外键。
  async function withArtifactSchema(): Promise<PGliteLike> {
    const pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE labeled_books (id serial PRIMARY KEY); CREATE TABLE download_tasks (id serial PRIMARY KEY, book_id int NOT NULL);');
    await initializeArtifactSchema(createPGliteSql(pg) as never);
    return pg;
  }
  const key = { owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main' };

  it('dry-run 只读：报告将 INSERT，库仍 0 行；apply 才写，且与生产行同值（enabled/private、¬read_only、未 sealed）', async () => {
    const pg = await withArtifactSchema();
    const sql = createPGliteSql(pg);
    const dry = await runRegistration(sql, key, 'dry-run');
    expect(dry).toMatchObject({ status: 'dry-run', planned: { owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main' } });
    expect((await pg.query('SELECT count(*)::int AS n FROM storage_repositories')).rows[0].n).toBe(0);

    const applied = await runRegistration(sql, key, 'apply');
    expect(applied).toMatchObject({ status: 'applied', id: 1 });
    expect((await pg.query('SELECT owner, repo, branch, enabled, is_private, read_only, sealed_at FROM storage_repositories')).rows)
      .toEqual([{ owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main', enabled: true, is_private: true, read_only: false, sealed_at: null }]);
  }, 60_000);

  it('幂等：重复 apply 空转（noop），不再插第二行', async () => {
    const pg = await withArtifactSchema();
    const sql = createPGliteSql(pg);
    await runRegistration(sql, key, 'apply');
    const again = await runRegistration(sql, key, 'apply');
    expect(again).toMatchObject({ status: 'noop', existing: { id: 1, branch: 'main' } });
    expect((await pg.query('SELECT count(*)::int AS n FROM storage_repositories')).rows[0].n).toBe(1);
  }, 60_000);

  it('大小写不敏感：换大小写写法也认作同一身份（唯一索引 lower(owner), lower(repo)）', async () => {
    const pg = await withArtifactSchema();
    const sql = createPGliteSql(pg);
    await runRegistration(sql, key, 'apply');
    const again = await runRegistration(sql, { ...key, owner: 'citizenscyu', repo: 'ZHAOSHU-BOOKS' }, 'apply');
    expect(again.status).toBe('noop');
    expect((await pg.query('SELECT count(*)::int AS n FROM storage_repositories')).rows[0].n).toBe(1);
  }, 60_000);

  it('已有行被人工设为 read_only → refused、不写库（不擅自解封）', async () => {
    const pg = await withArtifactSchema();
    const sql = createPGliteSql(pg);
    await runRegistration(sql, key, 'apply');
    await pg.query('UPDATE storage_repositories SET read_only = true WHERE id = 1');
    expect(await inspectRegistration(sql, key)).toMatchObject({ present: true, writable: false, branchOk: true });
    const result = await runRegistration(sql, key, 'apply');
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/readOnly=true/);
    expect((await pg.query('SELECT read_only FROM storage_repositories')).rows).toEqual([{ read_only: true }]);
  }, 60_000);

  it('T8 worker 的可写反查能命中登记行（resolveRepositoryId 同判据）', async () => {
    const pg = await withArtifactSchema();
    const sql = createPGliteSql(pg);
    await runRegistration(sql, key, 'apply');
    const rows = (await pg.query(`SELECT id FROM storage_repositories
      WHERE lower(owner) = lower($1) AND lower(repo) = lower($2) AND branch = $3
        AND enabled AND is_private AND NOT read_only AND sealed_at IS NULL LIMIT 1`, ['CitizenScyu', 'zhaoshu-books', 'main'])).rows;
    expect(rows).toEqual([{ id: 1 }]);
  }, 60_000);
});
