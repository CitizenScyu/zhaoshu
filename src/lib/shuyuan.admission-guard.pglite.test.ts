// 复审 P3：shuyuan.ts writeAdmissionRows 的版本自洽守卫判别力，经 PGlite 真库钉 INSERT 路径。
// 守卫抽在 admission.ts（单一真源），与 scripts/seed-admission.mjs 共用同一判据。这里验证经过
// 真实写库路径的透传：同源行落库、伪造错配（engine_semantics_version ≠ rules_hash 版本前缀）
// 抛错且整批不落库——把「by construction」的一致性钉死在写库边界，不再只靠 --selftest 直调函数。

import { beforeEach, describe, expect, it } from 'vitest';
import { rulesHash, type AdmissionSourceRow } from './rule-engine/admission';
import { writeAdmissionRows } from './shuyuan';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

function adapter(pg: PGliteLike): SqlTag {
  return async (parts, ...values) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  };
}

// source_admission DDL（与 business-schema.ts 逐字一致；只建这一张表够钉写库路径）。
const SOURCE_ADMISSION_DDL = `
  CREATE TABLE source_admission (
    id serial PRIMARY KEY,
    source_url text NOT NULL UNIQUE,
    tier text NOT NULL,
    compile_ok boolean NOT NULL,
    core_field_mask jsonb NOT NULL,
    search_ok boolean,
    search_verdict text NOT NULL DEFAULT '',
    search_checked_at timestamptz,
    rules_hash text NOT NULL,
    engine_semantics_version integer NOT NULL DEFAULT 0,
    host text NOT NULL,
    error text NOT NULL DEFAULT '',
    compile_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb
  )`;

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
    sql = adapter(pg);
    await pg.exec(SOURCE_ADMISSION_DDL);
  }, 60_000);

  it('同源行（engine_semantics_version = rules_hash 版本前缀）→ 落库', async () => {
    // 前置自证：版本前缀确实是整数，否则测试用例本身失去判别力。
    expect(Number.isInteger(SEED_VERSION)).toBe(true);
    await writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [row()]);
    const rows = await sql`SELECT source_url, engine_semantics_version, rules_hash FROM source_admission`;
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
      writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [mismatched]),
    ).rejects.toThrow(/版本自查失败/);
    const rows = await sql`SELECT count(*)::int AS n FROM source_admission`;
    expect(rows[0].n).toBe(0);
  });

  it('rules_hash 无版本前缀 → 抛错且不落库', async () => {
    const noPrefix = row({ rules_hash: 'no-version-prefix' });
    await expect(
      writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], [noPrefix]),
    ).rejects.toThrow(/版本自查失败/);
    const rows = await sql`SELECT count(*)::int AS n FROM source_admission`;
    expect(rows[0].n).toBe(0);
  });
});
