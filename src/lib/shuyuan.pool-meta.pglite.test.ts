// xfer41：池合成的探测快照投影（shuyuan.ts poolProbeMeta）在 PGlite 真库上的等价性与字节量。
// 投影是 SQL 端的 jsonb 过滤，mock 测试钉不住；这里用真 Postgres 语义跑一遍：
// 1) 同一夹具下，取书池/扇出池结论与改前整列读逐条相同（本文件的第一个用例在改前代码上同样通过，见 xfer-41-report §4）；
// 2) 投影只带回「host 门内」与「authority 非常规、须交 JS 判」的条目，门外/非 https/非对象条目不回传；
// 3) 1200+ 条快照时回传字节远小于整列。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { initializeBusinessSchema } from './business-schema';

type Statement = { text: string; params: unknown[] };

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));

import { getFanoutPool, getReadingSources, invalidateShuyuanReadCache } from './shuyuan';
import { refreshSupportedHosts } from './source-policy';

/** neon 形状的惰性标签：`sql\`\`` 只描述语句，await 或 transaction([...]) 时才执行；执行结果记入 log。 */
function lazySql(pg: PGliteLike, log: { text: string; rows: unknown[] }[]) {
  const run = async ({ text, params }: Statement) => {
    const rows = (await pg.query(text, params)).rows;
    log.push({ text, rows });
    return rows;
  };
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

const CHECKED = '2026-09-20T00:00:00Z';
const ENGINE_URLS = [
  'https://a.example', // 探测 failed ⇒ 出池
  'https://B.example/path', // 大写 host：WHATWG 小写化后在门内；failed ⇒ 出池（投影须大小写不敏感）
  'https://c.example:443/x', // 显式 :443；reachable ⇒ 引擎段排第一
  'https://d.example', // 两条重复条目 ⇒ readMeta 作废该 URL 的探测态 ⇒ 视同未探测、留在池里
  'https://e%2Eexample', // 百分号编码 host（WHATWG 解码为 e.example）；failed ⇒ 出池（投影须保守带回）
];
const HOST_OF: Record<string, string> = {
  'https://a.example': 'a.example', 'https://B.example/path': 'b.example', 'https://c.example:443/x': 'c.example',
  'https://d.example': 'd.example', 'https://e%2Eexample': 'e.example',
};
const FILLER = 1_200;

function snapshotEntries(): unknown[] {
  const failed = (url: string) => ({ url, status: 'failed', checked_at: CHECKED, error: '连接超时', consecutive_failures: 3 });
  return [
    { url: 'https://book15.net', status: 'reachable', checked_at: CHECKED, error: null, consecutive_failures: 0 },
    failed('https://a.example'),
    failed('https://B.example/path'),
    { url: 'https://c.example:443/x', status: 'reachable', checked_at: CHECKED, error: null },
    failed('https://d.example'),
    failed('https://d.example'),
    failed('https://e%2Eexample'),
    { url: 'http://a.example', status: 'reachable', checked_at: CHECKED }, // 非 https：canProbe 必拒
    'junk', { url: 5, status: 'failed' }, // 非对象 / url 非字符串：readMeta 跳过
    ...Array.from({ length: FILLER }, (_, i) => i % 3 === 0
      ? failed(`https://filler-${i}.example/`)
      : { url: `https://filler-${i}.example/`, status: 'pending', checked_at: null, error: null }),
  ];
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('xfer41 池合成探测快照投影（PGlite 真库）', () => {
  let pg: PGliteLike;
  let log: { text: string; rows: unknown[] }[];

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await pg.exec('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY)');
    await initializeBusinessSchema(createPGliteSql(pg) as never);
    const source = (url: string) => JSON.stringify({ bookSourceUrl: url, bookSourceName: url, searchUrl: `${url}/s?q={{key}}` });
    await pg.query(`INSERT INTO shuyuan_sources (source_url, name, source) VALUES ($1, 'book15', $2::jsonb)`,
      ['https://book15.net', source('https://book15.net')]);
    for (const url of ENGINE_URLS) {
      await pg.query(`INSERT INTO shuyuan_sources (source_url, name, source) VALUES ($1, $1, $2::jsonb)`, [url, source(url)]);
      await pg.query(`INSERT INTO source_admission (source_url, tier, compile_ok, core_field_mask, search_ok, rules_hash, host)
        VALUES ($1, 'M1', true, '{}'::jsonb, true, 'x', $2)`, [url, HOST_OF[url]]);
    }
    await pg.query(`UPDATE shuyuan_meta SET collections = $1::jsonb, refreshed_at = now() WHERE id = 1`, [JSON.stringify([
      { id: 11, title: '合集', count: 1, probeSnapshot: { version: 1, entries: snapshotEntries() } }, { id: 12, title: '合集2', count: 0 },
    ])]);
    log = [];
    getSql.mockReturnValue(lazySql(pg, log));
    vi.stubEnv('READING_ENGINE_SOURCES', '1');
    vi.stubEnv('READING_POOL_LIMIT', '10');
    vi.stubEnv('SOURCE_FANOUT_LIMIT', '10');
    invalidateShuyuanReadCache?.();
    refreshSupportedHosts([]);
  }, 120_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    refreshSupportedHosts([]);
    await pg.close();
  });

  it('入池结论与整列读相同：failed（含大写 host / 百分号 host）出池、重复条目作废、reachable 排前', async () => {
    const pool = await getReadingSources(new AbortController().signal);
    expect(pool.map((source) => source.url)).toEqual([
      'https://book15.net/', 'https://c.example/x', 'https://d.example/',
    ]);
    const fanout = await getFanoutPool(new AbortController().signal);
    expect(fanout.map((source) => [source.url, source.readable])).toEqual([
      ['https://book15.net/', true], ['https://c.example/x', true], ['https://d.example/', true],
    ]);
  });

  it('投影只回传门内 + 非常规 authority 的条目（保持原序），字节远小于整列', async () => {
    await getReadingSources(new AbortController().signal);
    const projected = log.filter((entry) => entry.text.includes('FROM shuyuan_meta'));
    expect(projected).toHaveLength(1);
    const row = projected[0].rows[0] as { collections: { probeSnapshot: { version: number; entries: { url: string }[] } }[] };
    expect(row.collections[0].probeSnapshot.version).toBe(1);
    expect(row.collections[0].probeSnapshot.entries.map((entry) => entry.url)).toEqual([
      'https://book15.net', 'https://a.example', 'https://B.example/path', 'https://c.example:443/x',
      'https://d.example', 'https://d.example', 'https://e%2Eexample',
    ]);
    const full = (await pg.query(`SELECT collections FROM shuyuan_meta WHERE id = 1`)).rows[0];
    const fullBytes = JSON.stringify(full).length;
    const projectedBytes = JSON.stringify(row).length;
    expect(fullBytes).toBeGreaterThan(100_000);
    expect(projectedBytes).toBeLessThan(fullBytes / 50);
  });

  it('无快照 / 快照形状非法：投影与整列读一样得到「无探测态」，不报错', async () => {
    for (const collections of [[], [{ id: 1, title: 't', count: 0 }], [{ probeSnapshot: { version: 1, entries: 'x' } }], { a: 1 }]) {
      await pg.query(`UPDATE shuyuan_meta SET collections = $1::jsonb WHERE id = 1`, [JSON.stringify(collections)]);
      invalidateShuyuanReadCache?.();
      const pool = await getReadingSources(new AbortController().signal);
      // 无探测态 ⇒ 无 failed 可剔除、无 reachable 可前置 ⇒ 全部候选按 source_url localeCompare 升序（builtin 恒在前）。
      expect(pool.map((source) => source.url)).toEqual([
        'https://book15.net/', 'https://a.example/', 'https://b.example/path', 'https://c.example/x',
        'https://d.example/', 'https://e.example/',
      ]);
    }
  });
});
