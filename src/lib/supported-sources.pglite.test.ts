// 41-srcfix 孤儿准入行（pglite 真库）：shuyuan_sources 每轮整表替换、source_admission 只 upsert 不删，
// 合集删掉的源留下孤儿 ok 行。取书池（engineReadingSources）是 shuyuan_sources JOIN source_admission，
// 孤儿早已出池；engineHosts 改前只查 source_admission，孤儿 host 仍在运行时 host 门里。
// 这里在真表上钉住「门 ⊆ 当前源表」：SQL 语义（EXISTS 半连接、DISTINCT）桩测试验证不了。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';

const db = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('./db', () => ({ getSql: () => db.sql }));

import { engineHosts } from './supported-sources';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('engineHosts：孤儿准入行不进 host 门（pglite 真库）', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    const tag = createPGliteSql(pg);
    await createProductionSchema(tag as never, (statement) => pg.exec(statement));
    // engineHosts 用 neon 的数组形 transaction([query], opts)；PGlite 标签是即发的，逐条等结果即可。
    db.sql = Object.assign(
      (parts: TemplateStringsArray, ...values: unknown[]) => tag(parts, ...values),
      { transaction: async (queries: Promise<unknown>[]) => Promise.all(queries) },
    );
  }, 120_000);

  async function seedSource(url: string) {
    await pg.query(`INSERT INTO shuyuan_sources (source_url, source) VALUES ($1, '{}'::jsonb)`, [url]);
  }
  async function seedAdmission(url: string, host: string, over: { compile_ok?: boolean; search_ok?: boolean | null } = {}) {
    await pg.query(
      `INSERT INTO source_admission (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, rules_hash, host)
       VALUES ($1, 'M1', $2, '{}'::jsonb, $3, 'ok', '1:x', $4)`,
      [url, over.compile_ok ?? true, over.search_ok === undefined ? true : over.search_ok, host],
    );
  }

  it('反例（改前放行）：源已从 shuyuan_sources 删除的 ok 准入行，其 host 不在门里', async () => {
    await seedSource('https://live.example');
    await seedAdmission('https://live.example', 'live.example');
    await seedAdmission('https://orphan.example', 'orphan.example'); // 合集删源后遗留
    expect((await engineHosts()).sort()).toEqual(['live.example']);
  });

  it('同 host 一份孤儿一份在表 ⇒ host 仍在门里（按源判存在，按 host 去重）', async () => {
    await seedSource('https://same.example/a');
    await seedAdmission('https://same.example/a', 'same.example');
    await seedAdmission('https://same.example/b', 'same.example');
    expect(await engineHosts()).toEqual(['same.example']);
  });

  it('ok 判据不变：在表但 compile 拒 / 未测 / search 失败的不进门', async () => {
    for (const [url, over] of [
      ['https://t7.example', { compile_ok: false, search_ok: null }],
      ['https://untested.example', { search_ok: null }],
      ['https://failed.example', { search_ok: false }],
    ] as const) {
      await seedSource(url);
      await seedAdmission(url, new URL(url).hostname, over);
    }
    expect(await engineHosts()).toEqual([]);
  });
});
