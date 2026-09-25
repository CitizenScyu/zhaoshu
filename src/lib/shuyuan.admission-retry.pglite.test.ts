// 41-B1-RETRY（pglite 真库）：conn_fail 一次 8s 超时不再永久拒——7 天衰减后回到复探队列，
// 站点恢复即回池。本文件把 runAdmissionBatch 的衰减语义钉在**真实 source_admission 表**上：
// 读回路径（readAdmissionRows 同款 SELECT）→ runAdmissionBatch → writeAdmissionRows upsert
// → 再读回，验证「写下去的行在下一轮真的会被复探」。桩测试（admission.test.ts）已覆盖
// 纯逻辑；这里补的是 pglite 真库上的往返：timestamptz 列经 PG 序列化/反序列化后
// search_checked_at 仍能被 Date.parse 复原（isRetestDue 依赖它），且 upsert 不清错列。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAdmissionBatch, rulesHash, type AdmissionSourceRow, type AdmissionTransport } from './rule-engine/admission';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';
import type { RawSource } from './rule-engine/compile-smoke';

type SqlTag = ReturnType<typeof createPGliteSql>;

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };
const page = (body: string, status = 200) => new Response(body, { status, headers: HTML_HEADERS });
const okHtml = '<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>';

const URL_UNDER_TEST = 'https://b1pg.example.com';
const HOST = 'b1pg.example.com';

function syntheticSource(): RawSource {
  return {
    bookSourceUrl: `${URL_UNDER_TEST}/`, bookSourceName: 'B1真库源',
    searchUrl: `${URL_UNDER_TEST}/s?q={{key}}`,
    checkKeyWord: '测试关键字',
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
    ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.c' },
  } as RawSource;
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('41-B1-RETRY：conn_fail 衰减复测（pglite 真库往返）', () => {
  let pg: PGliteLike;
  let sql: SqlTag;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = createPGliteSql(pg);
    // 先建 users 底座（business-schema 的部分表有 users 外键，pglite 空库没有 auth schema）。
    await createProductionSchema(sql as never, statement => pg.exec(statement));
  }, 120_000);

  /** 与 shuyuan.ts readAdmissionRows 同款读回（timestamptz::text）。 */
  async function readRows(): Promise<Map<string, AdmissionSourceRow>> {
    const rows = (await pg.query(
      `SELECT source_url, tier, compile_ok, core_field_mask, search_ok,
              search_verdict, search_checked_at::text AS search_checked_at, rules_hash,
              engine_semantics_version, host, error, compile_diagnostics
       FROM source_admission`,
    )).rows as unknown as AdmissionSourceRow[];
    return new Map(rows.map((row) => [row.source_url, row]));
  }

  /** 直插一条既有 conn_fail 行（模拟上一轮写下的终态），daysAgo 控制 checked_at。 */
  async function seedConnFailRow(daysAgo: number): Promise<void> {
    const source = syntheticSource();
    const hash = rulesHash(source);
    const version = Number(hash.split(':', 1)[0]);
    await pg.query(
      `INSERT INTO source_admission
         (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict,
          search_checked_at, rules_hash, engine_semantics_version, host, error)
       VALUES ($1, 'M1', true, '{}'::jsonb, false, 'conn_fail',
               now() - ($2 || ' days')::interval, $3, $4, $5, 'fetch failed')`,
      [URL_UNDER_TEST, String(daysAgo), hash, version, HOST],
    );
  }

  const runBatch = async (fetchPage: AdmissionTransport, existing: Map<string, AdmissionSourceRow>) =>
    runAdmissionBatch({
      candidates: [{ url: URL_UNDER_TEST, source: syntheticSource() }],
      declaredHosts: new Set([HOST]),
      existing, fetchPage, signal: new AbortController().signal, throttleMs: 0,
    });

  it('真库判据自证：PG 序列化的 search_checked_at 能被 Date.parse 复原（isRetestDue 的前提）', async () => {
    await seedConnFailRow(8);
    const row = (await readRows()).get(URL_UNDER_TEST)!;
    expect(row.search_verdict).toBe('conn_fail');
    // PG timestamptz::text 形如 '2026-09-15 08:38:00.123+00'，Date.parse 必须吃得下，
    // 否则 isRetestDue 的衰减判据在真库数据上恒 false（!Number.isFinite 分支救不了它——
    // 那会让所有 conn_fail 行每轮都到期，衰减退化为 20h 级风暴）。
    const parsed = Date.parse(row.search_checked_at!);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeLessThan(Date.now() - 7 * 24 * 3_600_000); // 8 天前 > 7 天窗：应判到期
  });

  it('①首次超时落终态（1 天前）：下一轮不重探、行原样保留', async () => {
    await seedConnFailRow(1);
    const existing = await readRows();
    const fetchPage = vi.fn<AdmissionTransport>();
    const result = await runBatch(fetchPage, existing);
    expect(result.probed).toBe(0);
    expect(result.rows).toHaveLength(0);
    // 库里行没被改动（search_ok 仍 false、verdict 仍 conn_fail）。
    const after = (await readRows()).get(URL_UNDER_TEST)!;
    expect(after.search_ok).toBe(false);
    expect(after.search_verdict).toBe('conn_fail');
  });

  it('②衰减到期（8 天前）+ 站点恢复 → 真探改写 ok，写库后入池谓词恢复（回池闭环）', async () => {
    await seedConnFailRow(8);
    const existing = await readRows();
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValue(page(okHtml));
    const result = await runBatch(fetchPage, existing);
    expect(result.probed).toBe(1);
    expect(result.verdicts).toEqual({ ok: 1 });

    // 走生产写库路径 upsert（writeAdmissionRows 在 shuyuan.ts，此处用同款 SQL 形状直写会
    // 引入第二份副本；直接 import writeAdmissionRows 即单一真源）。
    const { writeAdmissionRows } = await import('./shuyuan');
    await writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], result.rows);

    const after = (await readRows()).get(URL_UNDER_TEST)!;
    expect(after.search_ok).toBe(true); // 入池谓词 compile_ok ∧ search_ok IS TRUE 恢复
    expect(after.search_verdict).toBe('ok');
    expect(Date.parse(after.search_checked_at!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('③衰减到期但站点仍挂 → conn_fail 复写并刷新 checked_at（衰减窗重算，死站每 7 天才吃一次名额）', async () => {
    await seedConnFailRow(8);
    const existing = await readRows();
    const fetchPage = vi.fn<AdmissionTransport>().mockRejectedValue(new TypeError('fetch failed'));
    const result = await runBatch(fetchPage, existing);
    expect(result.verdicts).toEqual({ conn_fail: 1 });

    const { writeAdmissionRows } = await import('./shuyuan');
    await writeAdmissionRows(sql as unknown as Parameters<typeof writeAdmissionRows>[0], result.rows);

    const after = (await readRows()).get(URL_UNDER_TEST)!;
    expect(after.search_ok).toBe(false);
    expect(after.search_verdict).toBe('conn_fail');
    // checked_at 已刷到当下：下一轮（哪怕立即跑）不再判到期。
    expect(Date.parse(after.search_checked_at!)).toBeGreaterThan(Date.now() - 60_000);
    // 且立即再跑一轮：衰减窗内、不再重探（名额不被死站反复吃）。
    const second = await runBatch(vi.fn<AdmissionTransport>(), await readRows());
    expect(second.probed).toBe(0);
  });
});
