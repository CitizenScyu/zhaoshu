// admrunner42：phoenix_ok: 前缀行（phoenix runner 探 ok、Vercel 未确认）在 PGlite 真库上被**所有**池谓词排除。
// mock 测试只能钉 SQL 文本；`error NOT LIKE 'phoenix_ok:%'` 对空串/普通 error/前缀行的真实取舍要真 Postgres 才看得见。
// 三处消费者各一例：pool-artifact 的 engine/hosts（buildShuyuanPoolArtifact）、health 的 ok 计数（getShuyuanPoolHealth）、
// host 门（engineHosts）。harness 照抄 shuyuan.admission-lease.pglite.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';

type Statement = { text: string; params: unknown[] };

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));
vi.mock('./db', () => ({ ensureSchema: vi.fn(), getSql }));

import { buildShuyuanPoolArtifact, getShuyuanPoolHealth, invalidateShuyuanReadCache } from './shuyuan';
import { engineHosts } from './supported-sources';
import { refreshSupportedHosts } from './source-policy';
import { ADMISSION_PHOENIX_OK_PREFIX, ADMISSION_RECHECK_FAIL_PREFIX } from './rule-engine/admission';

/** neon 形状的惰性标签：`sql\`\`` 只描述语句，await 或 transaction([...]) 时才执行（同 shuyuan.admission-lease.pglite.test.ts）。 */
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

// 四种 ok 行：干净 ok（进池）、带 recheck_fail: strike 的 ok（仍进池——前缀语义是「留池」）、phoenix_ok:（不进池）、
// 一个失败行（不进池）。外加一个不在 shuyuan_sources 里的 phoenix_ok: 孤儿行（漏斗计数要数它，池 JOIN 不数）。
const CLEAN = 'https://clean.example/';
const STRIKE = 'https://strike.example/';
const PHOENIX = 'https://phoenix.example/';
const DEAD = 'https://dead.example/';
const ORPHAN = 'https://orphan.example/';

maybe('admrunner42 池谓词排除 phoenix_ok: 行（PGlite 真库）', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, (statement) => pg.exec(statement));
    const source = (url: string) => JSON.stringify({
      bookSourceUrl: url, bookSourceName: url, searchUrl: `${url}s?q={{key}}`,
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.ch', chapterName: 'a@text' }, ruleContent: { content: '.c' },
    });
    for (const url of [CLEAN, STRIKE, PHOENIX, DEAD]) {
      await pg.query(`INSERT INTO shuyuan_sources (source_url, name, source) VALUES ($1, $1, $2::jsonb)`, [url, source(url)]);
    }
    const admit = (url: string, searchOk: boolean, verdict: string, error: string) => pg.query(
      `INSERT INTO source_admission (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash, host, error)
       VALUES ($1, 'M1', true, '{}'::jsonb, $2, $3, now(), '1:x', $4, $5)`,
      [url, searchOk, verdict, new URL(url).hostname, error],
    );
    await admit(CLEAN, true, 'ok', '');
    await admit(STRIKE, true, 'ok', `${ADMISSION_RECHECK_FAIL_PREFIX}http_5xx`);
    await admit(PHOENIX, true, 'ok', ADMISSION_PHOENIX_OK_PREFIX);
    await admit(DEAD, false, 'http_5xx', '500');
    await admit(ORPHAN, true, 'ok', ADMISSION_PHOENIX_OK_PREFIX);
    getSql.mockReturnValue(lazySql(pg));
    invalidateShuyuanReadCache?.();
    refreshSupportedHosts([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }, 120_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    refreshSupportedHosts([]);
    await pg.close();
  });

  it('c1) pool-artifact 生成器：engine 行与 hosts 都不含 phoenix_ok: 源，含干净 ok 与 strike ok', async () => {
    const artifact = await buildShuyuanPoolArtifact(new AbortController().signal);
    expect(artifact.engine.map((row) => row.source_url).sort()).toEqual([CLEAN, STRIKE].sort());
    expect(artifact.hosts).toEqual(['clean.example', 'strike.example']);
  });

  it('c2) health 漏斗：ok 只数干净/strike ok（2），phoenix_ok: 行（含孤儿）落 deferred 桶，三桶互斥完备', async () => {
    const health = await getShuyuanPoolHealth(new AbortController().signal);
    expect(health.admission).toMatchObject({ ok: 2, deferred: 3, rejected: 0 });
    expect(health.admission.ok + health.admission.deferred + health.admission.rejected).toBe(5);
    expect(health.admission.url_defaulted).toBe(2); // ok 桶子集：core_field_mask 空 ⇒ chapterUrl 非 true，与 ok 同数
  });

  it('c3) host 门 engineHosts：不放行 phoenix_ok: 源的 host', async () => {
    expect((await engineHosts()).sort()).toEqual(['clean.example', 'strike.example']);
  });

  it('c4) Vercel 复测洗掉前缀后（error 置空）该源进池、进门、进 ok 桶', async () => {
    await pg.query(`UPDATE source_admission SET error = '' WHERE source_url = $1`, [PHOENIX]);
    invalidateShuyuanReadCache?.();
    expect((await engineHosts()).sort()).toEqual(['clean.example', 'phoenix.example', 'strike.example']);
    const artifact = await buildShuyuanPoolArtifact(new AbortController().signal);
    expect(artifact.engine.map((row) => row.source_url)).toContain(PHOENIX);
    const health = await getShuyuanPoolHealth(new AbortController().signal);
    expect(health.admission).toMatchObject({ ok: 3, deferred: 2 });
  });
});
