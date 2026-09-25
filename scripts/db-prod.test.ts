// 41-DBPROD（N1/N2）：业务 schema 生产入口 db:check:prod / db:migrate:prod。
// 参数闸门、连接变量不回退、输出不含连接串用纯函数 + main 注入测；dry-run 零写入、apply 记账、
// 重复 apply 空转、摘要被改 / 版本倒退 / 未知版本拒绝、列类型漂移拒绝都在 PGlite 真库上跑真 SQL。
import { describe, expect, it } from 'vitest';
import { initializeArtifactSchema } from '../src/lib/artifact-schema';
import { initializeBusinessSchema } from '../src/lib/business-schema';
import { loadPGlite, type PGliteLike } from '../src/lib/fixtures/pglite';
import { createPGliteClient, createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import { ARTIFACT_TABLES, applyMigration, checkRuntimeColumns, EXPECTED_RUNTIME_COLUMNS, loadMigrations, planMigrations } from './db-migration-lib.mjs';
import { main, parseProdArgs, plannedLedgerWrites, runProdCheck, runProdMigrate, unadoptedRefusal } from './db-prod.mjs';
import { runArtifactMigration } from './migrate-artifacts-prod.mjs';
import { runAuthMigration } from './migrate-auth-prod.mjs';

type Migration = Awaited<ReturnType<typeof loadMigrations>>[number];
const FAKE_URL = 'postgresql://u:not-a-secret-marker@ep-fake-123.example.test/db';

describe('参数闸门', () => {
  it.each([
    [[], /check、migrate 或 baseline/],
    [['--database-url-env=PROD_URL'], /check、migrate 或 baseline/],
    [['status', '--database-url-env=PROD_URL'], /check、migrate 或 baseline/],
    [['check'], /--database-url-env/],
    [['migrate', '--apply'], /--database-url-env/],
    [['migrate', '--database-url-env='], /--database-url-env/],
    [['migrate', '--database-url-env=prod_url'], /大写变量名/],
    [['migrate', '--database-url-env=DATABASE_URL'], /不能是 DATABASE_URL/],
    [['check', '--database-url-env=TEST_DATABASE_URL'], /不能是 TEST_DATABASE_URL/],
    [['check', '--database-url-env=PROD_URL', '--apply'], /check 只读/],
    [['check', '--database-url-env=PROD_URL', '--dry-run'], /check 只读/],
    [['migrate', '--database-url-env=PROD_URL', '--apply', '--dry-run'], /不能同时给/],
    [['migrate', '--database-url-env=PROD_URL', '--yes'], /未知参数/],
    [['migrate', '--database-url-env=A', '--database-url-env=B'], /只能给一次/],
  ])('%j 被拒绝', (argv, message) => {
    expect(() => parseProdArgs(argv)).toThrow(message);
  });

  it('合法组合：migrate 默认 dry-run，--apply 才写', () => {
    expect(parseProdArgs(['check', '--database-url-env=PROD_URL'])).toEqual({ command: 'check', envName: 'PROD_URL', mode: 'read-only' });
    expect(parseProdArgs(['migrate', '--database-url-env=PROD_URL'])).toEqual({ command: 'migrate', envName: 'PROD_URL', mode: 'dry-run' });
    expect(parseProdArgs(['migrate', '--dry-run', '--database-url-env=PROD_URL']).mode).toBe('dry-run');
    expect(parseProdArgs(['migrate', '--database-url-env=PROD_URL', '--apply']).mode).toBe('apply');
  });
});

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => { lines.push(line); }, logError: (line: string) => { lines.push(line); } };
}

describe('main：连接变量只读指定名，不回退、不外泄', () => {
  it('指定变量缺失时拒绝（退出码 1），不回退 DATABASE_URL / TEST_DATABASE_URL，也不连库', async () => {
    const out = capture();
    let opened = 0;
    const code = await main({
      argv: ['check', '--database-url-env=PROD_DATABASE_URL'],
      env: { DATABASE_URL: FAKE_URL, TEST_DATABASE_URL: FAKE_URL },
      open: async () => { opened += 1; throw new Error('不该连库'); },
      ...out,
    });
    expect(code).toBe(1);
    expect(opened).toBe(0);
    expect(out.lines.join('\n')).toMatch(/PROD_DATABASE_URL 为空；不会回退到 DATABASE_URL/);
    expect(out.lines.join('\n')).not.toContain('not-a-secret-marker');
  });

  it('连接阶段报错时错误信息脱敏，不含连接串', async () => {
    const out = capture();
    const code = await main({
      argv: ['check', '--database-url-env=PROD_DATABASE_URL'], env: { PROD_DATABASE_URL: FAKE_URL },
      open: async (connectionString: string) => { throw new Error(`connect failed: ${connectionString}`); }, ...out,
    });
    expect(code).toBe(1);
    const text = out.lines.join('\n');
    expect(text).toContain('[REDACTED_DATABASE_URL]');
    expect(text).not.toContain('not-a-secret-marker');
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('apply 前端点探测不通过就拒绝，不连库执行', async () => {
    const out = capture();
    let opened = 0;
    const code = await main({
      argv: ['migrate', '--database-url-env=PROD_DATABASE_URL', '--apply'], env: { PROD_DATABASE_URL: FAKE_URL },
      probe: async () => ({ serializedLocks: false, transactionPinned: true }),
      open: async () => { opened += 1; throw new Error('不该连库'); }, ...out,
    });
    expect(code).toBe(1);
    expect(opened).toBe(0);
    expect(out.lines.join('\n')).toMatch(/serializedLocks=false/);
  });
});

describe('planMigrations（纯函数）', () => {
  const list = [
    { version: 1, name: '0001_a.sql', checksum: 'a'.repeat(64), sql: '' },
    { version: 2, name: '0002_b.sql', checksum: 'b'.repeat(64), sql: '' },
    { version: 3, name: '0003_c.sql', checksum: 'c'.repeat(64), sql: '' },
  ];
  const row = (version: number, name: string, checksum: string) => ({ version, name, checksum });

  it('空库全部待执行；全登记则 up-to-date；v1 已登记 v2 未登记（生产手工 0002 形态）不算乱序', () => {
    expect(planMigrations([], list).pending.map((item) => item.version)).toEqual([1, 2, 3]);
    expect(planMigrations(list.map((item) => row(item.version, item.name, item.checksum)), list).status).toBe('up-to-date');
    const manual0002 = planMigrations([row(1, '0001_a.sql', 'a'.repeat(64))], list);
    expect(manual0002).toMatchObject({ status: 'pending', errors: [] });
    expect(manual0002.pending.map((item) => item.version)).toEqual([2, 3]);
  });

  it('char(64) 右侧空白不算摘要不同', () => {
    expect(planMigrations([row(1, '0001_a.sql', `${'a'.repeat(64)}  `)], list).errors).toEqual([]);
  });

  it.each([
    ['摘要不同', [row(1, '0001_a.sql', 'f'.repeat(64))], 'checksum-mismatch'],
    ['名称不同', [row(1, '0001_x.sql', 'a'.repeat(64))], 'checksum-mismatch'],
    ['库版本高于代码', [row(1, '0001_a.sql', 'a'.repeat(64)), row(4, '0004_d.sql', 'd'.repeat(64))], 'newer-than-code'],
    ['乱序缺口', [row(1, '0001_a.sql', 'a'.repeat(64)), row(3, '0003_c.sql', 'c'.repeat(64))], 'out-of-order'],
  ])('%s → refused', (_label, rows, kind) => {
    const plan = planMigrations(rows, list);
    expect(plan.status).toBe('refused');
    expect(plan.errors.map((item) => item.kind)).toContain(kind);
  });

  it('库里有代码列表没有的中间版本 → unknown-version', () => {
    const plan = planMigrations([row(1, '0001_a.sql', 'a'.repeat(64)), row(2, '0002_b.sql', 'b'.repeat(64))], [list[0], list[2]]);
    expect(plan.errors.map((item) => item.kind)).toEqual(['unknown-version']);
  });

  it('plannedLedgerWrites：每个待执行版本一行记账，0001 自带的 auth 记账 1–4 一并列出', async () => {
    const migrations = await loadMigrations();
    const writes = plannedLedgerWrites(planMigrations([], migrations).pending, migrations);
    expect(writes.filter((item) => item.table === 'schema_migrations').map((item) => item.version)).toEqual([1, 2, 3]);
    expect(writes.filter((item) => item.table === 'auth_schema_migrations')).toEqual([
      { table: 'auth_schema_migrations', byVersion: 1, values: '(1),(2),(3),(4)', onConflict: 'DO NOTHING' },
    ]);
  }, 60_000);
});

describe('unadoptedRefusal（纯函数，41-BASELINE）', () => {
  const report = (tables: string[], versions: { version: number }[] = []) =>
    ({ columns: tables.map((table_name) => ({ table_name, column_name: 'id' })), versions });
  it('空库放行（冷建库）；已登记（记账表有行）放行（交给记账比对）；只有业务表没有记账表 → 拒绝并指向 baseline', () => {
    expect(unadoptedRefusal(report([]))).toEqual([]);
    expect(unadoptedRefusal(report(['schema_migrations', 'users', 'books'], [{ version: 1 }]))).toEqual([]);
    expect(unadoptedRefusal(report(['unrelated_table']))).toEqual([]);
    const refused = unadoptedRefusal(report(['users', 'books']));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/没有 schema_migrations，却已有 2 张迁移管理的表（books, users）.*db:baseline:prod/);
  });

  it('复审 #1：记账表存在但 0 行 + 已有业务表 → 同样拒绝（修前放行，会把 0001 在在线表上重放）；只有空记账表的冷库仍放行', () => {
    const refused = unadoptedRefusal(report(['schema_migrations', 'users', 'books']));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/schema_migrations 为空（0 行），却已有 2 张迁移管理的表（books, users）.*db:baseline:prod/);
    expect(unadoptedRefusal(report(['schema_migrations']))).toEqual([]);
  });

  // 41-bookidfk N2：artifact 三表由 initializeArtifactSchema 单独建、不由 0001–0003 建，
  // 不该被算进「迁移管理的表」——否则只缺 artifact schema 的库会被这条拒绝拦下，且计数夸大。
  it('N2：artifact 三表不算「迁移管理的表」；只有它们（无业务表、无记账行）→ 放行', () => {
    expect(unadoptedRefusal(report(ARTIFACT_TABLES))).toEqual([]);
    // 与业务表混在一起时，计数只算业务表（books, users），不把三张 artifact 表算进去。
    const refused = unadoptedRefusal(report([...ARTIFACT_TABLES, 'users', 'books']));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/却已有 2 张迁移管理的表（books, users）/);
    expect(refused[0]).not.toMatch(/artifact_schema_migrations|book_artifacts|storage_repositories/);
  });
});

describe('checkRuntimeColumns（纯函数，N2）', () => {
  const rowsOf = () => Object.entries(EXPECTED_RUNTIME_COLUMNS).flatMap(([table, columns]) =>
    columns.map(([column_name, data_type, is_nullable, column_default]) => ({ table_name: table, column_name, data_type, is_nullable, column_default })));

  it('与契约一致 → ok；表整张不在只记 absentTables（0003 会建）；多出的列只报告', () => {
    expect(checkRuntimeColumns(rowsOf())).toEqual({ ok: true, problems: [], extra: [], absentTables: [] });
    expect(checkRuntimeColumns(rowsOf().filter((row) => row.table_name !== 'cron_health')))
      .toEqual({ ok: true, problems: [], extra: [], absentTables: ['cron_health'] });
    const extra = checkRuntimeColumns([...rowsOf(), { table_name: 'cron_health', column_name: 'note', data_type: 'text', is_nullable: 'YES', column_default: null }]);
    expect(extra).toMatchObject({ ok: true, extra: [{ table: 'cron_health', column: 'note' }] });
  });

  it.each([
    ['类型', { data_type: 'integer' }],
    ['可空', { is_nullable: 'YES' }],
    ['默认值', { column_default: "'x'::text" }],
  ])('只有%s不同也判不一致', (_label, patch) => {
    const rows = rowsOf().map((row) => row.table_name === 'source_admission' && row.column_name === 'search_verdict' ? { ...row, ...patch } : row);
    expect(checkRuntimeColumns(rows)).toMatchObject({ ok: false, problems: [{ table: 'source_admission', column: 'search_verdict', kind: 'mismatch' }] });
  });

  it('表在而列缺 → missing（0003 不会给已有表补 CREATE TABLE 里的列）', () => {
    const rows = rowsOf().filter((row) => !(row.table_name === 'source_admission' && row.column_name === 'search_verdict'));
    expect(checkRuntimeColumns(rows)).toMatchObject({ ok: false, problems: [{ column: 'search_verdict', kind: 'missing' }] });
  });
});

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('PGlite 真库', () => {
  let migrations: Migration[];
  const load = async () => (migrations ??= await loadMigrations());

  // 生产形态：v1/v2 由迁移登记，auth 已到 7，artifact schema 已建（生产本来就有，
  // t8-pilot-41-report.md:24），四张运行期表由 initializeBusinessSchema 建（v3 未登记）。
  // artifact 三表是 41-coldbuild 加的：db:check:prod 现在要求它们存在，旧形态会误报缺表。
  async function prodLike(): Promise<PGliteLike> {
    const pg = new PGliteCtor!();
    await applyMigration(createPGliteClient(pg), (await load()).filter((item) => item.version < 3));
    await runAuthMigration(createPGliteSql(pg), 'apply');
    await initializeArtifactSchema(createPGliteSql(pg) as never);
    await initializeBusinessSchema(createPGliteSql(pg) as never);
    return pg;
  }
  const ledgerOf = async (pg: PGliteLike) =>
    (await pg.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
  // 写入指纹：全部用户表的列形状 + 记账行 + 各表行数；dry-run 前后必须完全相同。
  async function fingerprint(pg: PGliteLike) {
    const columns = (await pg.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
    const tables = [...new Set(columns.map((row) => String(row.table_name)))];
    const counts: Record<string, unknown> = {};
    for (const table of tables) counts[table] = (await pg.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
    const ledger = tables.includes('schema_migrations') ? await ledgerOf(pg) : null;
    return { columns, counts, ledger };
  }

  it('运行期建的四表与迁移建的四表都满足列契约（生产形态不会误报）', async () => {
    const viaRuntime = await prodLike();
    const runtime = await runProdCheck(createPGliteClient(viaRuntime), await load());
    expect(runtime.runtimeColumns).toMatchObject({ ok: true, problems: [], extra: [], absentTables: [] });
    expect(checkRuntimeColumns(runtime.runtimeColumns.rows).ok).toBe(true);
    const viaMigration = new PGliteCtor!();
    await applyMigration(createPGliteClient(viaMigration), await load());
    const migrated = await runProdCheck(createPGliteClient(viaMigration), await load());
    expect(migrated.runtimeColumns).toMatchObject({ ok: true, problems: [], extra: [], absentTables: [] });
    expect(migrated.runtimeColumns.rows).toHaveLength(35);
  }, 120_000);

  it('dry-run 零写入：生产形态只列出 v3 与它的记账行，库指纹不变', async () => {
    const pg = await prodLike();
    const before = await fingerprint(pg);
    const report = await runProdMigrate(createPGliteClient(pg), await load(), 'dry-run');
    expect(report.status).toBe('dry-run');
    expect(report.ledger.pending.map((item: { version: number }) => item.version)).toEqual([3]);
    expect(report.ledgerWrites).toEqual([{ table: 'schema_migrations', version: 3, name: '0003_runtime_tables.sql',
      checksum: (await load()).find((item) => item.version === 3)!.checksum }]);
    expect(await fingerprint(pg)).toEqual(before);
  }, 120_000);

  it('dry-run 零写入：空库（冷建库）不建 schema_migrations、不建任何表', async () => {
    const pg = new PGliteCtor!();
    const report = await runProdMigrate(createPGliteClient(pg), await load(), 'dry-run');
    expect(report.ledger.pending.map((item: { version: number }) => item.version)).toEqual([1, 2, 3]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n).toBe(0);
  }, 60_000);

  it('apply：只补 v3 记账，v1/v2 行原样；随后 db:check:prod 退出码 0；再 apply 空转', async () => {
    const pg = await prodLike();
    const client = createPGliteClient(pg);
    const list = await load();
    const ledgerBefore = await ledgerOf(pg);
    expect((await main({ argv: ['check', '--database-url-env=PROD_DATABASE_URL'], env: { PROD_DATABASE_URL: FAKE_URL },
      open: async () => client, migrations: list, log: () => {} }))).toBe(2);

    const applied = await runProdMigrate(client, list, 'apply');
    expect(applied.status).toBe('applied');
    expect(applied.versions.map((item: { version: number; status: string }) => [item.version, item.status]))
      .toEqual([[1, 'unchanged'], [2, 'unchanged'], [3, 'applied']]);
    expect(applied.after).toMatchObject({ ok: true, checksumOk: true, authVersionOk: true, runtimeColumnsOk: true });
    const ledgerAfter = await ledgerOf(pg);
    expect(ledgerAfter.slice(0, 2)).toEqual(ledgerBefore);
    expect(ledgerAfter.map((row) => [row.version, row.name, String(row.checksum).trim()]))
      .toEqual(list.map((item) => [item.version, item.name, item.checksum]));
    expect((await main({ argv: ['check', '--database-url-env=PROD_DATABASE_URL'], env: { PROD_DATABASE_URL: FAKE_URL },
      open: async () => client, migrations: list, log: () => {} }))).toBe(0);

    const before = await fingerprint(pg);
    const again = await runProdMigrate(client, list, 'apply');
    expect(again.status).toBe('unchanged');
    expect(await fingerprint(pg)).toEqual(before);
    // 绕过前置短路直接走锁内 strict 路径也是空转。
    expect((await applyMigration(client, list, { strict: true })).status).toBe('unchanged');
    expect(await ledgerOf(pg)).toEqual(ledgerAfter);
  }, 120_000);

  it('冷建库全链：migrate:prod --apply → auth 只到 4 / artifact 未建（next 提示）→ 两个补迁移 → db:check:prod 通过', async () => {
    const pg = new PGliteCtor!();
    const client = createPGliteClient(pg);
    const applied = await runProdMigrate(client, await load(), 'apply');
    expect(applied.status).toBe('applied');
    expect(applied.after).toMatchObject({ checksumOk: true, missingTables: [...ARTIFACT_TABLES].sort(),
      authVersion: 4, authVersionOk: false, artifactVersion: null, artifactVersionOk: false, runtimeColumnsOk: true });
    expect(applied.next).toMatch(/migrate:auth:prod/);
    expect(applied.next).toMatch(/migrate:artifacts:prod/);
    // 只补 auth、没补 artifact 时仍不通过（冷建库的 artifact 缺口不能被 auth 步骤掩盖）。
    await runAuthMigration(createPGliteSql(pg), 'apply');
    expect((await runProdCheck(client, await load())).ok).toBe(false);
    const artifacts = await runArtifactMigration(createPGliteSql(pg), 'apply');
    expect(artifacts.status).toBe('applied');
    const check = await runProdCheck(client, await load());
    expect(check).toMatchObject({ ok: true, checksumOk: true, authVersionOk: true, artifactVersionOk: true, missingTables: [] });
  }, 180_000);

  it('反例：冷建库缺 artifact schema（没跑 migrate:artifacts:prod）时 db:check:prod 非 0，缺的恰是 artifact 三表', async () => {
    const pg = new PGliteCtor!();
    const client = createPGliteClient(pg);
    await runProdMigrate(client, await load(), 'apply');
    await runAuthMigration(createPGliteSql(pg), 'apply');
    const out = capture();
    // 改前（EXPECTED_TABLES 不含 artifact 表）这里会是 0，改后必须非 0（退出码 2）。
    expect(await main({ argv: ['check', '--database-url-env=PROD_DATABASE_URL'], env: { PROD_DATABASE_URL: FAKE_URL },
      open: async () => client, migrations: await load(), ...out })).toBe(2);
    const report = JSON.parse(out.lines.at(-1)!);
    expect(report.ok).toBe(false);
    expect([...report.missingTables].sort()).toEqual([...ARTIFACT_TABLES].sort());
    expect(report.artifactVersion).toBeNull();
    expect(report.artifactVersionOk).toBe(false);
  }, 120_000);

  describe('拒绝：未写库、退出码 2', () => {
    async function expectRefused(pg: PGliteLike, list: Migration[], pattern: RegExp) {
      const client = createPGliteClient(pg);
      const before = await fingerprint(pg);
      for (const mode of ['dry-run', 'apply'] as const) {
        const report = await runProdMigrate(client, list, mode);
        expect(report.status, mode).toBe('refused');
        expect(report.refusals.join('\n'), mode).toMatch(pattern);
      }
      const out = capture();
      expect(await main({ argv: ['migrate', '--database-url-env=PROD_DATABASE_URL', '--apply'], env: { PROD_DATABASE_URL: FAKE_URL },
        open: async () => client, probe: async () => ({ serializedLocks: true, transactionPinned: true }), migrations: list, ...out })).toBe(2);
      expect(out.lines.join('\n')).not.toContain('not-a-secret-marker');
      expect(await fingerprint(pg)).toEqual(before);
      expect((await runProdCheck(client, list)).ok).toBe(false);
    }

    it('库内登记的摘要被改', async () => {
      const pg = await prodLike();
      await pg.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, ['0'.repeat(64)]);
      await expectRefused(pg, await load(), /版本 1 的名称或摘要与库内登记不一致/);
    }, 120_000);

    it('迁移文件被改（摘要随之变化）', async () => {
      const pg = await prodLike();
      const tampered = (await load()).map((item) => item.version === 2 ? { ...item, checksum: 'e'.repeat(64) } : item);
      await expectRefused(pg, tampered, /版本 2 的名称或摘要与库内登记不一致/);
    }, 120_000);

    it('库版本高于代码（版本倒退）', async () => {
      const pg = await prodLike();
      await pg.query(`INSERT INTO schema_migrations(version, name, checksum) VALUES (4, '0004_future.sql', $1)`, ['d'.repeat(64)]);
      await expectRefused(pg, await load(), /库已登记版本 4，高于代码的最新版本 3/);
    }, 120_000);

    it('库里有代码不认识的版本', async () => {
      const pg = await prodLike();
      const withoutV2 = (await load()).filter((item) => item.version !== 2);
      await expectRefused(pg, withoutV2, /库已登记版本 2（0002_identity_key.sql）不在代码的迁移列表里/);
    }, 120_000);

    it('运行期表列类型与 0003 声明不一致（N2）', async () => {
      const pg = await prodLike();
      await pg.exec(`ALTER TABLE source_admission ALTER COLUMN search_verdict DROP DEFAULT;
        ALTER TABLE source_admission ALTER COLUMN search_verdict TYPE integer USING 0`);
      await expectRefused(pg, await load(), /source_admission\.search_verdict 与 0003 声明不一致/);
    }, 120_000);

    it('锁内复核：前置核对之后库里冒出更高版本，applyMigration strict 整批回滚', async () => {
      const pg = await prodLike();
      const client = createPGliteClient(pg);
      await pg.query(`INSERT INTO schema_migrations(version, name, checksum) VALUES (9, '0009_x.sql', $1)`, ['9'.repeat(64)]);
      const before = await ledgerOf(pg);
      await expect(applyMigration(client, await load(), { strict: true })).rejects.toThrow(/高于代码的最新版本/);
      expect(await ledgerOf(pg)).toEqual(before);
      // 默认（非 strict）保持旧行为：多出的高版本被忽略——回滚路径依赖这一点。
      expect((await applyMigration(client, await load())).versions.at(-1)).toMatchObject({ version: 3, status: 'applied' });
    }, 120_000);
  });
});
