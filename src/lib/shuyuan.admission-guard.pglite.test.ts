// 复审 P3：shuyuan.ts writeAdmissionRows 的版本自洽守卫判别力，经 PGlite 真库钉 INSERT 路径。
// 守卫抽在 admission.ts（单一真源），与 scripts/seed-admission.mjs 共用同一判据。这里验证经过
// 真实写库路径的透传：同源行落库、伪造错配（engine_semantics_version ≠ rules_hash 版本前缀）
// 抛错且整批不落库——把「by construction」的一致性钉死在写库边界，不再只靠 --selftest 直调函数。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rulesHash, type AdmissionSourceRow } from './rule-engine/admission';
import { writeAdmissionRows } from './shuyuan';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';

type SqlTag = ReturnType<typeof createPGliteSql>;
const lease = { leaseName: 'admission_lease' as const, generation: '1' };


// 用真 rulesHash 产出带版本前缀的 rules_hash（形如 `<version>:<hash>`），避免测试自造前缀口径漂移。
const SEED_HASH = rulesHash({ bookSourceUrl: 'https://x.example', searchUrl: 's', ruleSearch: { name: 'h1' } });
const SEED_VERSION = Number(SEED_HASH.split(':', 1)[0]);

function row(overrides: Partial<AdmissionSourceRow> = {}): AdmissionSourceRow {
  return {
    source_url: 'https://x.example',
    tier: 'M1',
    compile_ok: true,
    core_field_mask: {},
    search_ok: true,
    search_verdict: 'ok',
    search_checked_at: null,
    rules_hash: SEED_HASH,
    engine_semantics_version: SEED_VERSION,
    host: 'x.example',
    error: '',
    compile_diagnostics: [],
    ...overrides,
  };
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('shuyuan writeAdmissionRows 版本自洽守卫（真库 INSERT 路径）', () => {
  let pg: PGliteLike;
  let sql: SqlTag;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = createPGliteSql(pg);
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
    await sql`INSERT INTO cron_health (name, last_success_at, lease_generation)
      VALUES ('admission_lease', now() + interval '1 hour', 1)`;
  }, 60_000);

  afterEach(async () => { await pg.close(); });

  const lost = { skipped: 'lease_lost', written: 0 };
  const write = (sql: SqlTag, rows: AdmissionSourceRow[], handle: unknown = lease) =>
    writeAdmissionRows(sql as never, rows, handle as never);

  it('运行期缺句柄、错误名称、非 canonical/越界/Number 代次全部拒绝且不发 SQL', async () => {
    const unexpectedSql = vi.fn(() => { throw new Error('invalid handle reached SQL'); });
    const invalid = [undefined, null, {}, { ...lease, leaseName: 'admission' },
      ...['0', '-1', '+1', '01', '1.0', '1e3', ' 1', '1 ', '', '9223372036854775808', 1, 9007199254740992]
        .map((generation) => ({ ...lease, generation }))];
    for (const handle of invalid) {
      expect(await writeAdmissionRows(unexpectedSql as never, [row()], handle as never)).toEqual(lost);
      expect(await writeAdmissionRows(unexpectedSql as never, [], handle as never)).toEqual(lost);
    }
    expect(unexpectedSql).not.toHaveBeenCalled();
  });

  it('空批次仍判权：有效是 written=0；旧代次、过期、丢行均明确 lease_lost', async () => {
    expect(await write(sql, [])).toEqual({ written: 0 });
    expect(await write(sql, [], { ...lease, generation: '2' })).toEqual(lost);
    await sql`UPDATE cron_health SET last_success_at = clock_timestamp() - interval '1 second'`;
    expect(await write(sql, [])).toEqual(lost);
    await sql`DELETE FROM cron_health`;
    expect(await write(sql, [row()])).toEqual(lost);
  });

  it('超 JS 安全整数的相邻代次不合并；BIGINT 上限仍可作为有效现有句柄', async () => {
    await sql`UPDATE cron_health SET lease_generation = 9007199254740993`;
    expect(await write(sql, [row()], { ...lease, generation: '9007199254740992' })).toEqual(lost);
    expect(await write(sql, [row()], { ...lease, generation: '9007199254740993' })).toEqual({ written: 1 });
    await sql`UPDATE cron_health SET lease_generation = 9223372036854775807`;
    expect(await write(sql, [row()], { ...lease, generation: '9223372036854775807' })).toEqual({ written: 1 });
  });

  it.each([
    ['phoenix_ok:', ''], ['', 'phoenix_ok:'],
  ])('迟到旧结果 %s 不能覆盖新结果 %s（单连接顺序反例）', async (oldError, newError) => {
    await sql`UPDATE cron_health SET lease_generation = 2`;
    expect(await write(sql, [row({ error: newError })], { ...lease, generation: '2' })).toEqual({ written: 1 });
    expect(await write(sql, [row({ error: oldError })])).toEqual(lost);
    const rows = await sql`SELECT error FROM source_admission` as { error: string }[];
    expect(rows).toEqual([{ error: newError }]);
  });

  it('缺 generation 列按 SQL 错误拒绝，绝不退回无围栏写入', async () => {
    await sql`ALTER TABLE cron_health DROP COLUMN lease_generation`;
    await expect(write(sql, [row()])).rejects.toMatchObject({ code: '42703' });
    expect((await pg.query('SELECT * FROM source_admission')).rows).toEqual([]);
  });

  it('RETURNING 统计实际写数：触发器跳过一行时不能按输入两行记成功', async () => {
    await pg.exec(`CREATE FUNCTION skip_admission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_url = 'https://skip.example' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER skip_admission BEFORE INSERT ON source_admission FOR EACH ROW EXECUTE FUNCTION skip_admission();`);
    expect(await write(sql, [row(), row({ source_url: 'https://skip.example' })])).toEqual({ written: 1 });
    expect((await pg.query('SELECT * FROM source_admission')).rows).toHaveLength(1);
  });

  it('批中约束失败整批回滚；任意 22012 不冒充 lease_lost', async () => {
    await sql`ALTER TABLE source_admission ADD CHECK (host <> 'reject.example')`;
    await expect(write(sql, [row(), row({ source_url: 'https://second.example', host: 'reject.example' })]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await pg.query('SELECT * FROM source_admission')).rows).toEqual([]);
    await pg.exec(`CREATE FUNCTION fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM 1 / 0; RETURN NEW; END $$;
      CREATE TRIGGER fail_admission BEFORE INSERT ON source_admission FOR EACH ROW EXECUTE FUNCTION fail_admission();`);
    await expect(write(sql, [row()])).rejects.toMatchObject({ code: '22012' });
    expect((await pg.query('SELECT * FROM source_admission')).rows).toEqual([]);
  });

  it('同源行（engine_semantics_version = rules_hash 版本前缀）→ 落库', async () => {
    // 前置自证：版本前缀确实是整数，否则测试用例本身失去判别力。
    expect(Number.isInteger(SEED_VERSION)).toBe(true);
    expect(await writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [row()], lease)).toEqual({ written: 1 });
    const rows = await sql`SELECT source_url, engine_semantics_version, rules_hash FROM source_admission` as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_url: 'https://x.example',
      engine_semantics_version: SEED_VERSION,
      rules_hash: SEED_HASH,
    });
  });

  it('伪造错配行（engine_semantics_version ≠ 版本前缀）→ 抛错且整批不落库', async () => {
    const mismatched = row({ engine_semantics_version: SEED_VERSION + 99 });
    await expect(
      writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [mismatched], lease),
    ).rejects.toThrow(/版本自查失败/);
    const rows = await sql`SELECT count(*)::int AS n FROM source_admission` as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('rules_hash 无版本前缀 → 抛错且不落库', async () => {
    const noPrefix = row({ rules_hash: 'no-version-prefix' });
    await expect(
      writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [noPrefix], lease),
    ).rejects.toThrow(/版本自查失败/);
    const rows = await sql`SELECT count(*)::int AS n FROM source_admission` as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  // 对抗性：钉「严格等值」而非「子串包含」。判据若退化成 includes（版本值只要出现在前缀里就放行），
  // 以下用例仍必须转红。前缀是版本的**超串**（前缀 "12" 含版本 "1"）：strict 应拒、includes 会误放。
  it('版本值是版本前缀的真子串（前缀 12 vs 版本 1）→ 抛错且不落库', async () => {
    const subset = row({ rules_hash: '12:deadbeef', engine_semantics_version: 1 });
    await expect(
      writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [subset], lease),
    ).rejects.toThrow(/版本自查失败/);
    const rows = await sql`SELECT count(*)::int AS n FROM source_admission` as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  // 反方向：版本值是前缀的**超串**（版本 "12" 含前缀 "1"），钉住 versionStr.includes(prefixStr) 式退化。
  it('版本值是版本前缀的超串（前缀 1 vs 版本 12）→ 抛错且不落库', async () => {
    const superset = row({ rules_hash: '1:deadbeef', engine_semantics_version: 12 });
    await expect(
      writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [superset], lease),
    ).rejects.toThrow(/版本自查失败/);
    const rows = await sql`SELECT count(*)::int AS n FROM source_admission` as { n: number }[];
    expect(rows[0].n).toBe(0);
  });
});
