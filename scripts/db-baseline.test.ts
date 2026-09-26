// 41-BASELINE：从未登记的已有库「只补记账」（db:baseline:prod）。
// 契约来源（0001–0003 真跑出的库逐项导出）、放行（迁移建的库 / 按生产演化路径建的库）、逐类拒绝且零写入、
// 已有记账表拒绝、dry-run 零写入、锁内复核，以及 db:migrate:prod 对未登记已有库的拒绝，全部在 PGlite 真库上跑真 SQL。
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { initializeArtifactSchema } from '../src/lib/artifact-schema';
import { initializeBusinessSchema } from '../src/lib/business-schema';
import { loadPGlite, type PGliteLike } from '../src/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import { identityKeyMigrationSql } from '../src/lib/fixtures/production-schema';
import {
  applyBaseline, BASELINE_ABSENT, BASELINE_CHECKSUMS, BASELINE_DATA_CHECKS, BASELINE_TABLE_SOURCES, BASELINE_VERSIONS,
  compareShape, inspectShape, shapeToContract,
} from './db-baseline.mjs';
import { BASELINE_LEDGER_SHAPE, BASELINE_SHAPE } from './db-baseline-contract.mjs';
import { applyMigration, ARTIFACT_TABLES, EXPECTED_TABLES, loadMigrations, PUBLISHED_CHECKSUMS, SCHEMA_MIGRATIONS_DDL } from './db-migration-lib.mjs';
import { main, parseProdArgs, runProdBaseline, runProdCheck, runProdMigrate } from './db-prod.mjs';
import { runAuthMigration } from './migrate-auth-prod.mjs';

// db.ts 的用量表只能经它自己的 neon() 建（生产 llm_usage 就是这么来的）；把 neon 换成当前 PGlite 的标签适配器，
// 其余导出（Client 等）保持原样。
const neonTarget = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@neondatabase/serverless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neondatabase/serverless')>()),
  neon: () => neonTarget.sql,
}));

type Migration = Awaited<ReturnType<typeof loadMigrations>>[number];
const FAKE_URL = 'postgresql://u:not-a-secret-marker@ep-fake-123.example.test/db';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

let cached: Migration[] | undefined;
const load = async () => (cached ??= await loadMigrations());

// (a) 0001–0003 真跑出的库，auth 补到 7、artifact schema 补到 v1，再去掉记账表：结构与生产（迁移管理
// 的表 + auth 侧 + artifact 侧全齐）相同，只是从未登记。artifact 三表是 41-coldbuild 加的：db:check:prod
// 现在要求它们存在，而生产本来就有（t8-pilot-41-report.md:24），所以「登记后 check 应通过」的模型必须含它们。
async function migratedUnledgered(): Promise<PGliteLike> {
  const pg = new PGliteCtor!();
  await applyMigration(createPGliteClient(pg), await load());
  await runAuthMigration(createPGliteSql(pg), 'apply');
  await initializeArtifactSchema(createPGliteSql(pg) as never);
  await pg.exec('DROP TABLE schema_migrations');
  return pg;
}

// 生产的真实演化路径：旧主应用建的表 → auth 迁移 v1–v7 → 运行期业务 DDL → 手工 0002 → artifact DDL → db.ts 用量表。
// 全部走仓内真代码，没有一句手抄 DDL；从没跑过迁移 runner，所以没有 schema_migrations。
async function productionEvolved(): Promise<PGliteLike> {
  const pg = new PGliteCtor!();
  await pg.exec(await readFile(new URL('../tests/db/fixtures/legacy-app.sql', import.meta.url), 'utf8'));
  const sql = createPGliteSql(pg);
  await runAuthMigration(sql, 'apply');
  await initializeBusinessSchema(sql as never);
  await pg.exec(identityKeyMigrationSql());
  await initializeArtifactSchema(sql as never);
  neonTarget.sql = sql;
  vi.stubEnv('DATABASE_URL', 'postgresql://pglite@localhost/usage');
  try {
    vi.resetModules();
    const { ensureUsageSchema } = await import('../src/lib/db');
    await ensureUsageSchema();
  } finally {
    vi.unstubAllEnvs();
    neonTarget.sql = null;
  }
  return pg;
}

// 写入指纹：全部表的结构快照 + 各表行数（含 auth 记账行）。dry-run 与任何拒绝前后必须完全相同。
async function fingerprint(pg: PGliteLike) {
  const shape = await inspectShape(createPGliteClient(pg));
  const tables = [...new Set(shape.columns.map((row) => String(row.table_name)))].sort();
  const counts: Record<string, unknown> = {};
  for (const table of tables) counts[table] = (await pg.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
  const authLedger = (await pg.query('SELECT version, applied_at FROM auth_schema_migrations ORDER BY version')).rows;
  return { shape, counts, authLedger };
}
const ledgerPresent = async (pg: PGliteLike) =>
  (await pg.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`)).rows[0].present;

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => { lines.push(line); }, logError: (line: string) => { lines.push(line); } };
}
const baselineArgv = (apply: boolean) => ['baseline', '--database-url-env=PROD_DATABASE_URL', ...(apply ? ['--apply'] : [])];
const okProbe = async () => ({ serializedLocks: true, transactionPinned: true });

describe('参数', () => {
  it('baseline 与 migrate 同样默认 dry-run，--apply 才写', () => {
    expect(parseProdArgs(['baseline', '--database-url-env=PROD_URL'])).toEqual({ command: 'baseline', envName: 'PROD_URL', mode: 'dry-run' });
    expect(parseProdArgs(['baseline', '--database-url-env=PROD_URL', '--apply']).mode).toBe('apply');
    expect(() => parseProdArgs(['baseline', '--database-url-env=DATABASE_URL'])).toThrow(/不能是 DATABASE_URL/);
    expect(() => parseProdArgs(['baseline', '--database-url-env=PROD_URL', '--apply', '--dry-run'])).toThrow(/不能同时给/);
  });
});

describe('契约的来源与冻结', () => {
  it('摘要钉死：baseline 只替 v1–v3 作证，且与已发布摘要一致', async () => {
    const migrations = await load();
    expect(BASELINE_VERSIONS).toEqual([1, 2, 3]);
    for (const version of BASELINE_VERSIONS) {
      expect(migrations.find((item) => item.version === version)?.checksum, `v${version}`).toBe(BASELINE_CHECKSUMS[version as 1 | 2 | 3]);
    }
    for (const [version, checksum] of Object.entries(PUBLISHED_CHECKSUMS)) expect(BASELINE_CHECKSUMS[Number(version) as 1 | 2]).toBe(checksum);
  }, 60_000);

  it('契约的表 = 迁移管理的表（EXPECTED_TABLES 去掉记账表与 artifact 三表）= 出处表的键', () => {
    const expected = EXPECTED_TABLES.filter((table) => table !== 'schema_migrations' && !ARTIFACT_TABLES.includes(table)).sort();
    expect(Object.keys(BASELINE_SHAPE).sort()).toEqual(expected);
    expect(Object.keys(BASELINE_TABLE_SOURCES).sort()).toEqual(expected);
  });

  it('核对项的出处都指向 0001–0003 的行号', () => {
    const sources = [...Object.values(BASELINE_TABLE_SOURCES), ...BASELINE_ABSENT.map((item) => item.source),
      ...BASELINE_DATA_CHECKS.map((item) => item.source)];
    for (const source of sources) expect(source).toMatch(/^000[123]:\d/);
  });
});

maybe('PGlite 真库', () => {
  it('契约 = 0001→0003 在空库上真跑出的结构（逐列 / 约束 / 索引全等，一项不多一项不少）', async () => {
    const pg = new PGliteCtor!();
    await applyMigration(createPGliteClient(pg), await load());
    const shape = await inspectShape(createPGliteClient(pg));
    const tables = [...new Set(shape.columns.map((row) => String(row.table_name)))].filter((table) => table !== 'schema_migrations');
    expect(shapeToContract(shape, tables)).toEqual(BASELINE_SHAPE);
    expect(compareShape(shape)).toEqual({ problems: [], extra: [] });
    // runner 建的记账表形状（baseline 对「空记账表」的放行判据）同样来自真跑；identity 的 START WITH 2（0001:5）在契约里。
    expect(shapeToContract(shape, ['schema_migrations'])).toEqual(BASELINE_LEDGER_SHAPE);
    expect(BASELINE_SHAPE.users.columns.find((row) => row[0] === 'id')?.[6]).toMatch(/ start=2 /);
  }, 120_000);

  it('(a) 迁移建的未登记库：dry-run 零写入 → --apply 只建记账表登记 v1–v3 → db:check:prod 退出 0 → migrate 已是最新', async () => {
    const pg = await migratedUnledgered();
    const client = createPGliteClient(pg);
    const list = await load();
    expect(await main({ argv: ['check', '--database-url-env=PROD_DATABASE_URL'], env: { PROD_DATABASE_URL: FAKE_URL },
      open: async () => client, migrations: list, log: () => {} })).toBe(2);

    const before = await fingerprint(pg);
    const dry = await runProdBaseline(client, list, 'dry-run');
    expect(dry).toMatchObject({ status: 'dry-run', problems: [] });
    // auth v5–v7 给 download_tasks / users 加的列、约束、索引不在 0001–0003 里：只报告，不拒绝。
    expect(new Set(dry.extra.map((item: { table: string }) => item.table))).toEqual(new Set(['download_tasks', 'users']));
    expect(dry.checked).toEqual({ tables: 20, columns: 154, constraints: 48, indexes: 35, absent: 4, data: 10 });
    expect(dry.ledgerWrites).toEqual(list.map(({ version, name, checksum }) => ({ table: 'schema_migrations', version, name, checksum })));
    expect(await fingerprint(pg)).toEqual(before);
    expect(await ledgerPresent(pg)).toBe(false);

    const out = capture();
    expect(await main({ argv: baselineArgv(true), env: { PROD_DATABASE_URL: FAKE_URL }, open: async () => client, probe: okProbe,
      migrations: list, ...out })).toBe(0);
    const applied = JSON.parse(out.lines.at(-1)!);
    expect(applied).toMatchObject({ status: 'applied', after: { ok: true, checksumOk: true, authVersionOk: true, missingTables: [] } });
    expect(out.lines.join('\n')).not.toContain('not-a-secret-marker');

    const ledger = (await pg.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows;
    expect(ledger.map((row) => [row.version, row.name, String(row.checksum).trim()])).toEqual(list.map((item) => [item.version, item.name, item.checksum]));
    // 除新建的记账表外，库里一个字节不变（结构、行数、auth 记账行含 applied_at）。
    const after = await fingerprint(pg);
    expect({ ...after, shape: { ...after.shape, columns: after.shape.columns.filter((row) => row.table_name !== 'schema_migrations'),
      constraints: after.shape.constraints.filter((row) => row.table_name !== 'schema_migrations'),
      indexes: after.shape.indexes.filter((row) => row.table_name !== 'schema_migrations') },
    counts: Object.fromEntries(Object.entries(after.counts).filter(([table]) => table !== 'schema_migrations')) }).toEqual(before);

    expect(await main({ argv: ['check', '--database-url-env=PROD_DATABASE_URL'], env: { PROD_DATABASE_URL: FAKE_URL },
      open: async () => client, migrations: list, log: () => {} })).toBe(0);
    expect((await runProdMigrate(client, list, 'dry-run')).status).toBe('up-to-date');

    // (c) 登记之后再跑 baseline：已有记账表 → 拒绝，退出码 2，记账不变。
    const again = await runProdBaseline(client, list, 'apply');
    expect(again.status).toBe('refused');
    expect(again.refusals.join('\n')).toMatch(/已有 schema_migrations（登记了 3 个版本）/);
    expect((await pg.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(3);
  }, 180_000);

  it('按生产演化路径建的库（旧应用表 → auth v1–v7 → 运行期 DDL → 手工 0002 → artifact → 用量表）：baseline 通过，登记后 check 退出 0', async () => {
    const pg = await productionEvolved();
    const client = createPGliteClient(pg);
    const list = await load();
    const before = await fingerprint(pg);
    const dry = await runProdBaseline(client, list, 'dry-run');
    expect(dry.refusals).toBeUndefined();
    expect(dry.problems).toEqual([]);
    expect(dry.status).toBe('dry-run');
    // 运行期与 auth v5–v7 / artifact 后加的东西只报告不拒绝。
    expect(dry.extra).toEqual(expect.arrayContaining([
      { kind: 'column', table: 'download_tasks', name: 'user_id' },
      { kind: 'index', table: 'feedback', name: 'feedback_user_book_idx' },
      { kind: 'constraint', table: 'users', name: 'users_created_via_invite_fk' },
    ]));
    expect(await fingerprint(pg)).toEqual(before);

    // 同一个库上 migrate:prod 拒绝（未登记的已有库不许重跑 0001），也零写入。
    for (const mode of ['dry-run', 'apply'] as const) {
      const refused = await runProdMigrate(client, list, mode);
      expect(refused.status, mode).toBe('refused');
      expect(refused.refusals.join('\n'), mode).toMatch(/从未登记的已有库.*db:baseline:prod/);
    }
    expect(await fingerprint(pg)).toEqual(before);

    const applied = await runProdBaseline(client, list, 'apply');
    expect(applied).toMatchObject({ status: 'applied', after: { ok: true } });
    expect((await runProdCheck(client, list)).ok).toBe(true);
    expect((await runProdMigrate(client, list, 'apply')).status).toBe('unchanged');
  }, 180_000);

  describe('(b) 任一效果不成立 → 拒绝、零写入、退出码 2', () => {
    async function expectRefused(pg: PGliteLike, pattern: RegExp, list?: Migration[]) {
      const client = createPGliteClient(pg);
      const migrations = list ?? await load();
      const before = await fingerprint(pg);
      for (const mode of ['dry-run', 'apply'] as const) {
        const report = await runProdBaseline(client, migrations, mode);
        expect(report.status, mode).toBe('refused');
        expect(report.refusals.join('\n'), mode).toMatch(pattern);
        expect(report.ledgerWrites, mode).toBeUndefined();
      }
      const out = capture();
      expect(await main({ argv: baselineArgv(true), env: { PROD_DATABASE_URL: FAKE_URL }, open: async () => client, probe: okProbe,
        migrations, ...out })).toBe(2);
      expect(out.lines.join('\n')).not.toContain('not-a-secret-marker');
      expect(await fingerprint(pg)).toEqual(before);
    }

    it.each([
      ['缺列', 'ALTER TABLE labeled_books DROP COLUMN quality', /"kind":"missing-column","table":"labeled_books","column":"quality"/],
      ['类型不同', 'ALTER TABLE books ALTER COLUMN douban_rating TYPE real', /"column":"douban_rating","diff":\{"type"/],
      ['profile.id 默认值未去除（0001:66）', 'ALTER TABLE profile ALTER COLUMN id SET DEFAULT 1', /"table":"profile","column":"id","diff":\{"column_default"/],
      ['recommendations.user_id 默认值未去除（0001:96）', 'ALTER TABLE recommendations ALTER COLUMN user_id SET DEFAULT 1',
        /"table":"recommendations","column":"user_id","diff":\{"column_default"/],
      ['download_tasks 默认值不同（0001:168-177）', "ALTER TABLE download_tasks ALTER COLUMN status SET DEFAULT 'queued'",
        /"table":"download_tasks","column":"status","diff":\{"column_default"/],
      ['生成列表达式不同（0002:26-28）', `DROP INDEX books_identity_idx; ALTER TABLE books DROP COLUMN title_key;
        ALTER TABLE books ADD COLUMN title_key text GENERATED ALWAYS AS (lower(title)) STORED;
        CREATE UNIQUE INDEX books_identity_idx ON books (title_key, author_key)`, /"column":"title_key","diff":\{"generated"/],
      ['缺约束', 'ALTER TABLE users DROP CONSTRAINT users_check1', /"kind":"missing-constraint","table":"users","name":"users_check1"/],
      ['约束定义不同', 'ALTER TABLE auth_rate_limits DROP CONSTRAINT auth_rate_limits_attempts_check; ALTER TABLE auth_rate_limits ADD CONSTRAINT auth_rate_limits_attempts_check CHECK (attempts >= -1)',
        /"kind":"constraint-mismatch","table":"auth_rate_limits"/],
      ['外键改了名（0001:97-102 按名核）', 'ALTER TABLE feedback RENAME CONSTRAINT feedback_user_fk TO feedback_owner_fk',
        /"kind":"constraint-renamed","table":"feedback","name":"feedback_user_fk","actualName":"feedback_owner_fk"/],
      ['缺索引', 'DROP INDEX recommendations_user_book_query_idx', /"kind":"missing-index","table":"recommendations","name":"recommendations_user_book_query_idx"/],
      ['索引定义不同', 'DROP INDEX sessions_expires_idx; CREATE INDEX sessions_expires_idx ON sessions (expires_at DESC)', /"kind":"index-mismatch","table":"sessions"/],
      ['缺表', 'DROP TABLE cron_health', /"kind":"missing-table","table":"cron_health"/],
      ['旧全局唯一约束仍在（0001:103-105）', 'ALTER TABLE recommendations ADD CONSTRAINT recommendations_book_id_query_key UNIQUE (book_id, query)',
        /recommendations-global-unique-constraint → recommendations_book_id_query_key/],
      ['旧全局唯一索引仍在（0001:106-108）', 'CREATE UNIQUE INDEX recommendations_book_query_idx ON recommendations (book_id, query)',
        /recommendations-global-unique-index → recommendations_book_query_idx/],
      ['旧表达式索引仍在（0002:46）', 'CREATE UNIQUE INDEX books_title_author_idx ON books (lower(title), lower(author))',
        /books-title-author-idx → books_title_author_idx/],
      ['旧表达式索引仍在（0002:47）', 'CREATE UNIQUE INDEX labeled_books_title_author_idx ON labeled_books (lower(title), lower(author))',
        /labeled-books-title-author-idx → labeled_books_title_author_idx/],
      ['recommendations 有 NULL user_id（0001:94-95）', `ALTER TABLE recommendations ALTER COLUMN user_id DROP NOT NULL;
        INSERT INTO books (title, author) VALUES ('t', 'a'); INSERT INTO recommendations (book_id, query) VALUES (1, 'q')`,
        /数据不符（0001:94-95）：recommendations\.user_id 无 NULL；样本 id \/ 值 1/],
      ['feedback 有 NULL user_id（0001:119-120）', `ALTER TABLE feedback ALTER COLUMN user_id DROP NOT NULL;
        INSERT INTO books (title, author) VALUES ('t', 'a'); INSERT INTO feedback (book_id, status) VALUES (1, 'liked')`,
        /数据不符（0001:119-120）：feedback\.user_id 无 NULL/],
      // book_id=1 需先有 labeled_books id=1 行：artifact v2（41-bookidfk）起 download_tasks.book_id
      // 有指向 labeled_books(id) 的外键，migratedUnledgered 已跑过 initializeArtifactSchema。本用例只关心
      // title 的 NULL，故先垫一行父表；id 显式给 1（serial 默认从 1 起，显式写更稳）。
      ['download_tasks 必填列有 NULL（0001:159-167）', `ALTER TABLE download_tasks ALTER COLUMN title DROP NOT NULL, ALTER COLUMN user_id DROP NOT NULL;
        INSERT INTO labeled_books (id, title, author) VALUES (1, 't', 'a');
        INSERT INTO download_tasks (book_id, title, requested_by) VALUES (1, NULL, 'system')`, /数据不符（0001:159-167）/],
      ['shuyuan_meta 缺 id=1 行（0001:139）', 'DELETE FROM shuyuan_meta', /数据不符（0001:139）/],
      ['auth_settings 缺 id=1 行（0001:41）', 'DELETE FROM auth_settings', /数据不符（0001:41）/],
      ['app_settings 缺 id=1 行（0003:26）', 'DELETE FROM app_settings', /数据不符（0003:26）/],
      ['profile 缺 id=1 行（0001:78）', 'DELETE FROM profile', /数据不符（0001:78）/],
      ['auth 记账缺 v2（0001:210）', 'DELETE FROM auth_schema_migrations WHERE version = 2', /数据不符（0001:210）/],
      ['auth 记账缺最高版本 v7（max 判据放行、连续性判据拒绝）', 'DELETE FROM auth_schema_migrations WHERE version = 7', /auth 记账缺版本 7（需 1\.\.7 全部在册）/],
      // F2-2：中间缺号（max 仍是 7，旧 max<7 判据会放行）。这里删 v5——不在 auth-ledger-1-4 数据核对（只看 1..4）
      // 覆盖范围内，故唯一触发的就是入场核对的连续性判据，直接证明「缺中间版本被拒」。
      ['auth 记账缺中间版本 v5（F2-2：唯连续性判据能挡）', 'DELETE FROM auth_schema_migrations WHERE version = 5', /auth 记账缺版本 5（需 1\.\.7 全部在册）/],
      ['空记账表但形状与 runner 建的不同（复审 #1）', 'CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
        /schema_migrations 为空但结构与 runner 建的不同.*"column":"checksum"/],
      ['空记账表多一列可空列（复审 #N1：extra 也算形状不同）', `${SCHEMA_MIGRATIONS_DDL}; ALTER TABLE schema_migrations ADD COLUMN note text`,
        /schema_migrations 为空但结构与 runner 建的不同，不能直接登记进去：\[\]；多出 column note；先查明这张表的来历/],
      ['空记账表多一个索引（复审 #N1 同类）', `${SCHEMA_MIGRATIONS_DDL}; CREATE INDEX schema_migrations_name_idx ON schema_migrations (name)`,
        /schema_migrations 为空但结构与 runner 建的不同，不能直接登记进去：\[\]；多出 index schema_migrations_name_idx/],
      ['serial 序列参数被改（复审 #2 同类）', 'ALTER SEQUENCE books_id_seq INCREMENT BY 2', /"table":"books","column":"id","diff":\{"sequence"/],
      ['identity START WITH 被改（复审 #2，0001:5）', `ALTER TABLE users ALTER COLUMN id DROP IDENTITY;
        ALTER TABLE users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1)`, /"table":"users","column":"id","diff":\{"sequence"/],
      ['恒真 WHERE 的部分全局唯一索引仍在（复审 #3，0001:106-108 同口径）',
        "CREATE UNIQUE INDEX rec_partial_global_idx ON recommendations (book_id, query) WHERE status <> '@@never@@'",
        /recommendations-global-unique-index → rec_partial_global_idx/],
    ])('%s', async (_label, mutation, pattern) => {
      const pg = await migratedUnledgered();
      await pg.exec(mutation);
      await expectRefused(pg, pattern);
    }, 120_000);

    it('缺列时依赖该列的数据核对判「无法核对」而不是让事务 25P02', async () => {
      const pg = await migratedUnledgered();
      await pg.exec('ALTER TABLE feedback DROP COLUMN user_id CASCADE');
      await expectRefused(pg, /数据不符（0001:119-120）：feedback\.user_id 无 NULL；无法核对：缺列 feedback\.user_id/);
    }, 120_000);

    it('迁移文件字节与契约登记的摘要不一致', async () => {
      const pg = await migratedUnledgered();
      const tampered = (await load()).map((item) => item.version === 3 ? { ...item, checksum: 'e'.repeat(64) } : item);
      await expectRefused(pg, /迁移文件 v3 的摘要与 baseline 契约登记的 81957051de3f… 不一致/, tampered);
    }, 120_000);
  });

  it('锁内复核：dry-run 通过之后库被改，applyBaseline 在锁内发现并整批回滚，不建记账表', async () => {
    const pg = await migratedUnledgered();
    const client = createPGliteClient(pg);
    expect((await runProdBaseline(client, await load(), 'dry-run')).status).toBe('dry-run');
    await pg.exec('ALTER TABLE users DROP CONSTRAINT users_check2');
    const result = await applyBaseline(client, await load());
    expect(result.status).toBe('refused');
    expect(result.verdict.refusals.join('\n')).toMatch(/users_check2/);
    expect(await ledgerPresent(pg)).toBe(false);
  }, 120_000);

  it('锁内复核失败经 db:baseline:prod --apply 报 refused、退出码 2（不能被当成 applied）', async () => {
    const pg = await migratedUnledgered();
    const inner = createPGliteClient(pg);
    // 前置只读核对通过之后、拿到迁移锁的那一刻库被改（模拟并发改动）。
    const client = {
      async query(text: string, params?: unknown[]) {
        if (text.startsWith('SELECT pg_advisory_xact_lock')) await pg.exec('ALTER TABLE users DROP CONSTRAINT users_check2');
        return await inner.query(text, params);
      },
    };
    const out = capture();
    expect(await main({ argv: baselineArgv(true), env: { PROD_DATABASE_URL: FAKE_URL }, open: async () => client, probe: okProbe,
      migrations: await load(), ...out })).toBe(2);
    const result = JSON.parse(out.lines.at(-1)!);
    expect(result.status).toBe('refused');
    expect(result.refusals.join('\n')).toMatch(/users_check2/);
    expect(await ledgerPresent(pg)).toBe(false);
  }, 120_000);

  it('复审 #1：记账表存在但 0 行 + 已有业务表——migrate:prod 拒绝且零写入；baseline 视同未登记，核对通过后登记 v1–v3', async () => {
    const pg = await migratedUnledgered();
    await pg.exec(SCHEMA_MIGRATIONS_DDL);
    const client = createPGliteClient(pg);
    const list = await load();
    const before = await fingerprint(pg);
    for (const mode of ['dry-run', 'apply'] as const) {
      const refused = await runProdMigrate(client, list, mode);
      expect(refused.status, mode).toBe('refused');
      expect(refused.refusals.join('\n'), mode).toMatch(/schema_migrations 为空（0 行）.*db:baseline:prod/);
    }
    expect(await fingerprint(pg)).toEqual(before);

    const dry = await runProdBaseline(client, list, 'dry-run');
    expect(dry).toMatchObject({ status: 'dry-run', problems: [] });
    expect(await fingerprint(pg)).toEqual(before);
    expect(await runProdBaseline(client, list, 'apply')).toMatchObject({ status: 'applied', after: { ok: true } });
    expect((await runProdCheck(client, list)).ok).toBe(true);
    expect((await runProdMigrate(client, list, 'dry-run')).status).toBe('up-to-date');
  }, 180_000);

  it('空库（冷建库）不走 baseline：缺表拒绝；migrate:prod 对空库照常放行', async () => {
    const pg = new PGliteCtor!();
    const client = createPGliteClient(pg);
    const report = await runProdBaseline(client, await load(), 'dry-run');
    expect(report.status).toBe('refused');
    expect(report.refusals.join('\n')).toMatch(/auth 记账缺版本 1, 2, 3, 4, 5, 6, 7（需 1\.\.7 全部在册）/);
    expect(report.problems).toHaveLength(20);
    expect((await runProdMigrate(client, await load(), 'dry-run')).status).toBe('dry-run');
  }, 60_000);
});
