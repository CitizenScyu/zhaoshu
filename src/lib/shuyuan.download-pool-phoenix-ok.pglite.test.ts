// bpool-normalize：下载池扩池（DOWNLOAD_POOL_INCLUDE_PHOENIX_OK）的谓词与委托语义，在 PGlite 真库上钉死。
// 两条硬要求：
//   (1) flag 缺省 = 零行为变化：getDownloadEngineSources / getDownloadPoolEngineHosts 与未扩池路径逐条相同；
//   (2) includePhoenixOk 谓词：含 phoenix_ok: 行时 true 含、false 不含（readEngineRows / engineHosts 各一例）。
// harness 照抄 shuyuan.phoenix-ok-predicate.pglite.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema } from './fixtures/production-schema';

type Statement = { text: string; params: unknown[] };

const isUnsafe = (value: unknown): value is { __pgliteUnsafe: true; raw: string } =>
  typeof value === 'object' && value !== null && '__pgliteUnsafe' in value;

const { getSql } = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));
vi.mock('./db', () => ({ ensureSchema: vi.fn(), getSql }));

import {
  downloadPoolIncludesPhoenixOk, getDownloadEngineSources, getDownloadPoolEngineHosts,
  getEngineSources, getPoolEngineHosts, invalidateShuyuanReadCache,
} from './shuyuan';
import { engineHosts } from './supported-sources-server';
import { refreshSupportedHosts } from './source-policy';
import { ADMISSION_PHOENIX_OK_PREFIX } from './rule-engine/admission';

/** neon 形状的惰性标签：`sql\`\`` 只描述语句，await 或 transaction([...]) 时才执行。
 * 另支持 `sql.unsafe(raw)`：neon 用它内联原始 SQL 片段（urlfix 的归一化表达式依赖它）。 */
function lazySql(pg: PGliteLike) {
  const run = async ({ text, params }: Statement) => (await pg.query(text, params)).rows;
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) {
        const value = values[index];
        if (isUnsafe(value)) { text += value.raw; } else { params.push(value); text += `$${params.length}`; }
      }
    });
    const statement = { text, params };
    return { ...statement, then: (ok: (rows: unknown[]) => unknown, fail: (e: unknown) => unknown) => run(statement).then(ok, fail) };
  };
  return Object.assign(tag, {
    unsafe: (raw: string) => ({ __pgliteUnsafe: true, raw } as unknown),
    transaction: async (queries: Statement[]) => {
      const out: unknown[][] = [];
      for (const query of queries) out.push(await run(query));
      return out;
    },
  });
}

// 纯函数真值表：不依赖 DB，随文件顶层一起跑。
describe('downloadPoolIncludesPhoenixOk 真值解析', () => {
  it('只有 1/true/on（忽略大小写/前后空白）才开，其余一律关', () => {
    const on = ['1', 'true', 'on', 'TRUE', 'On', ' true ', '1\n'];
    const off = ['0', 'false', 'off', '', '  ', 'yes', 'enabled', '2', undefined];
    for (const raw of on) expect(downloadPoolIncludesPhoenixOk({ DOWNLOAD_POOL_INCLUDE_PHOENIX_OK: raw })).toBe(true);
    for (const raw of off) expect(downloadPoolIncludesPhoenixOk({ DOWNLOAD_POOL_INCLUDE_PHOENIX_OK: raw })).toBe(false);
    expect(downloadPoolIncludesPhoenixOk({})).toBe(false);
  });
});

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

// 干净 ok（缺省进池）与 phoenix_ok:（缺省排除）各一，二者都是 ok 态行、都在 shuyuan_sources 里。
const CLEAN = 'https://clean.example/';
const PHOENIX = 'https://phoenix.example/';

maybe('bpool-normalize 下载池扩池（PGlite 真库）', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, (statement) => pg.exec(statement));
    const source = (url: string) => JSON.stringify({
      bookSourceUrl: url, bookSourceName: url, searchUrl: `${url}s?q={{key}}`,
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.ch', chapterName: 'a@text' }, ruleContent: { content: '.c' },
    });
    for (const url of [CLEAN, PHOENIX]) {
      await pg.query(`INSERT INTO shuyuan_sources (source_url, name, source) VALUES ($1, $1, $2::jsonb)`, [url, source(url)]);
    }
    const admit = (url: string, error: string) => pg.query(
      `INSERT INTO source_admission (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash, host, error)
       VALUES ($1, 'M1', true, '{}'::jsonb, true, 'ok', now(), '1:x', $2, $3)`,
      [url, new URL(url).hostname, error],
    );
    await admit(CLEAN, '');
    await admit(PHOENIX, ADMISSION_PHOENIX_OK_PREFIX);
    getSql.mockReturnValue(lazySql(pg));
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    invalidateShuyuanReadCache?.();
    // 两个 host 都放进运行时门，隔离出「SQL 谓词」这一唯一变量（否则 canProbe 会先滤掉 phoenix.example）。
    refreshSupportedHosts(['clean.example', 'phoenix.example']);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }, 120_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    refreshSupportedHosts([]);
    await pg.close();
  });

  it('flag 缺省（未设）：下载池路径与阅读池路径逐条相同，phoenix_ok: 行不进池、不放行 host', async () => {
    vi.stubEnv('DOWNLOAD_POOL_INCLUDE_PHOENIX_OK', undefined);
    const signal = new AbortController().signal;
    const downloadSources = await getDownloadEngineSources(signal);
    const readingSources = await getEngineSources(signal);
    expect(downloadSources.map((row) => row.url)).toEqual(readingSources.map((row) => row.url));
    expect(downloadSources.map((row) => row.url)).toEqual([CLEAN]);
    const downloadHosts = await getDownloadPoolEngineHosts(signal);
    const readingHosts = await getPoolEngineHosts(signal);
    expect(downloadHosts).toEqual(readingHosts);
    expect(downloadHosts).toEqual(['clean.example']);
  });

  it('flag 关（显式 0）：与缺省逐条相同，仍排除 phoenix_ok: 行/host', async () => {
    vi.stubEnv('DOWNLOAD_POOL_INCLUDE_PHOENIX_OK', '0');
    const signal = new AbortController().signal;
    expect((await getDownloadEngineSources(signal)).map((row) => row.url)).toEqual([CLEAN]);
    expect(await getDownloadPoolEngineHosts(signal)).toEqual(['clean.example']);
  });

  it('flag 开：下载池纳入 phoenix_ok: 行、下载门放行其 host；阅读池路径不受影响', async () => {
    vi.stubEnv('DOWNLOAD_POOL_INCLUDE_PHOENIX_OK', '1');
    const signal = new AbortController().signal;
    const downloadSources = await getDownloadEngineSources(signal);
    expect(downloadSources.map((row) => row.url).sort()).toEqual([CLEAN, PHOENIX].sort());
    const downloadHosts = await getDownloadPoolEngineHosts(signal);
    expect(downloadHosts.sort()).toEqual(['clean.example', 'phoenix.example']);
    // 阅读池/阅读门仍按原口径排除 phoenix_ok:。
    expect((await getEngineSources(signal)).map((row) => row.url)).toEqual([CLEAN]);
    expect(await getPoolEngineHosts(signal)).toEqual(['clean.example']);
  });

  it('engineHosts 谓词：includePhoenixOk=true 含 phoenix_ok: host，缺省 false 不含', async () => {
    expect(await engineHosts()).toEqual(['clean.example']);
    expect((await engineHosts(undefined, { includePhoenixOk: true })).sort()).toEqual(['clean.example', 'phoenix.example']);
  });
});
