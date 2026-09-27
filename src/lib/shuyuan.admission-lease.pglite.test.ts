// 42-admbudget：准入租约（cron_health 行 admission_lease）在 PGlite 真库上的语义。
// mock 测试只钉语句形状；ON CONFLICT … WHERE 的「未过期不抢、过期才抢」要真 Postgres 才看得见。
// 走 runAdmissionRound 的真实入口（getSql 换成 PGlite 惰性标签），不复述 SQL。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';

type Statement = { text: string; params: unknown[] };

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));

import { ADMISSION_LEASE_ROW, ADMISSION_LEASE_TTL_MS, runAdmissionRound } from './shuyuan';
import { readCronSuccessTimes } from './source-health';

/** neon 形状的惰性标签：`sql\`\`` 只描述语句，await 或 transaction([...]) 时才执行（同 shuyuan.pool-meta.pglite.test.ts）。 */
function lazySql(pg: PGliteLike) {
  const run = async ({ text, params }: Statement) => (await pg.query(text, params)).rows;
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    const statement = { text, params };
    return { ...statement, then: (ok: (rows: unknown[]) => unknown, fail: (e: unknown) => unknown) => run(statement).then(ok, fail) };
  };
  return Object.assign(tag, {
    transaction: async (queries: Statement[]) => {
      const out: unknown[][] = [];
      for (const query of queries) out.push(await run(query));
      return out;
    },
  });
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('42-admbudget 准入租约（PGlite 真库）', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, (statement) => pg.exec(statement));
    getSql.mockReturnValue(lazySql(pg));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }, 120_000);

  async function leaseRemainingMs(): Promise<number> {
    const rows = (await pg.query(
      `SELECT extract(epoch FROM last_success_at - now()) * 1000 AS ms FROM cron_health WHERE name = $1`, [ADMISSION_LEASE_ROW],
    )).rows as { ms: number | string }[];
    return Number(rows[0].ms);
  }

  it('首次领取插入行；未过期再领被拒；过期后可再领', async () => {
    // 源表空 ⇒ 领到租约后 no_candidates；领不到 ⇒ lease。两种返回区分出「领没领到」。
    expect(await runAdmissionRound()).toEqual({ skipped: 'no_candidates' });
    const remaining = await leaseRemainingMs();
    expect(remaining).toBeGreaterThan(ADMISSION_LEASE_TTL_MS - 60_000);
    expect(remaining).toBeLessThanOrEqual(ADMISSION_LEASE_TTL_MS);

    expect(await runAdmissionRound()).toEqual({ skipped: 'lease' });
    // 被拒的一次不得续期（WHERE 不成立 ⇒ UPDATE 不执行）。
    expect(await leaseRemainingMs()).toBeLessThanOrEqual(remaining);

    await pg.query(`UPDATE cron_health SET last_success_at = now() - interval '1 second' WHERE name = $1`, [ADMISSION_LEASE_ROW]);
    expect(await runAdmissionRound()).toEqual({ skipped: 'no_candidates' });
    expect(await leaseRemainingMs()).toBeGreaterThan(ADMISSION_LEASE_TTL_MS - 60_000);
  });

  it('同时发起两轮：恰好一轮领到', async () => {
    const results = await Promise.all([runAdmissionRound(), runAdmissionRound()]);
    expect(results.map((result) => 'skipped' in result && result.skipped).sort()).toEqual(['lease', 'no_candidates']);
  });

  it('借用的租约行不污染 cron 健康读数（readCronSuccessTimes 只认已知行名）', async () => {
    await runAdmissionRound();
    const times = await readCronSuccessTimes();
    expect(Object.keys(times)).not.toContain(ADMISSION_LEASE_ROW);
    expect(Object.values(times).every((value) => value === null)).toBe(true);
  });
});
