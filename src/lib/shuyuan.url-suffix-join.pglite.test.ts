// urlfix：admission/规则表 URL 形态分裂（`https://x.com` vs `https://x.com#` / `#🎃` / `#一程`）的读路径修复，
// 在 PGlite 真库上钉死。桩测试只能验 SQL 文本，`regexp_replace` 的 fragment 语义、LATERAL LIMIT 1 的
// 防膨胀、同条目判据的取舍都只有真 Postgres 才看得见。harness 照抄 shuyuan.phoenix-ok-predicate.pglite.test.ts。
//
// 改动语义（shuyuan.ts readEngineRows + supported-sources-server.ts engineHosts 共用同款判据）：
//   JOIN/EXISTS := 精确等值
//               OR (归一化等值 AND 同条目判据 AND 供判行是旧形态孤儿)
//   归一化      := btrim + 剥 fragment（只剥 # 之后）+ 去尾斜杠
//   同条目判据  := norm(src.source->>'bookSourceUrl') = norm(ad.source_url)（admission 结论来自本条目）
//   旧形态孤儿  := NOT EXISTS(精确键仍在 shuyuan_sources)（区分「同条目旧形态」与「同 host 另一条目」）
//
// 注意 host 门：取书池 filter 里的 canProbe 会校验运行时门（supportedHosts），与本文件测的 SQL 谓词正交，
// 所以每个用例把种过的 host 放进门（openGate），隔离出「SQL 谓词」这一唯一变量。
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
  getDownloadEngineSources, getEngineSources, invalidateShuyuanReadCache,
} from './shuyuan';
import { engineHosts } from './supported-sources-server';
import { refreshSupportedHosts } from './source-policy';
import { ADMISSION_PHOENIX_OK_PREFIX } from './rule-engine/admission';

/** neon 形状的惰性标签：`sql\`\`` 只描述语句，await 或 transaction([...]) 时才执行。
 * 另支持 `sql.unsafe(raw)`：neon 用它内联**原始 SQL 片段**（不是参数绑定），归一化表达式依赖它。 */
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

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('urlfix URL 形态分裂 JOIN（PGlite 真库）', () => {
  let pg: PGliteLike;
  let seededHosts: string[];

  async function seedSource(url: string, bookSourceUrl = url) {
    const source = JSON.stringify({
      bookSourceUrl, bookSourceName: url, searchUrl: `${url}s?q={{key}}`,
      ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.ch', chapterName: 'a@text' }, ruleContent: { content: '.c' },
    });
    await pg.query(`INSERT INTO shuyuan_sources (source_url, name, source) VALUES ($1, $1, $2::jsonb)`, [url, source]);
  }
  async function seedAdmission(url: string, over: { host?: string; compile_ok?: boolean; search_ok?: boolean | null; error?: string } = {}) {
    const host = over.host ?? new URL(url).hostname;
    await pg.query(
      `INSERT INTO source_admission (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash, host, error)
       VALUES ($1, 'M1', $2, '{}'::jsonb, $3, 'ok', now(), '1:x', $4, $5)`,
      [url, over.compile_ok ?? true, over.search_ok === undefined ? true : over.search_ok, host, over.error ?? ''],
    );
    if (!seededHosts.includes(host)) seededHosts.push(host);
  }
  /** 把本用例种过的 host 全部放进行为门（隔离出 SQL 谓词这一唯一变量）。 */
  function openGate() { refreshSupportedHosts(seededHosts); }
  const poolUrls = async () => (await getEngineSources(new AbortController().signal)).map((s) => s.url).sort();
  const hosts = async () => (await engineHosts()).sort();

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createProductionSchema(createPGliteSql(pg) as never, (statement) => pg.exec(statement));
    getSql.mockReturnValue(lazySql(pg));
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    invalidateShuyuanReadCache?.();
    seededHosts = [];
    refreshSupportedHosts([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }, 120_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    refreshSupportedHosts([]);
    await pg.close();
  });

  // c1 精确等值：行为逐字不变——两表同键仍进池、进门。
  it('c1) 精确等值行为不变：两表同键的行进池、host 照常放行', async () => {
    await seedSource('https://exact.example/');
    await seedAdmission('https://exact.example/');
    openGate();
    expect(await poolUrls()).toEqual(['https://exact.example/']);
    expect(await hosts()).toEqual(['exact.example']);
  });

  // c2 孤儿救回：规则行与旧形态准入行 bookSourceUrl 归一化同条目 ⇒ 归一化路径接上（精确键已不在表）。
  it('c2) 孤儿救回：规则行 https://x.example + 旧形态准入行 https://x.example#🎃（同条目）⇒ 进池', async () => {
    await seedSource('https://x.example');            // 规则行新键（bookSourceUrl 无后缀）
    await seedAdmission('https://x.example#🎃');     // 准入行旧形态孤儿（精确键不在表）
    openGate();
    expect(await poolUrls()).toEqual(['https://x.example/']);
    expect(await hosts()).toEqual(['x.example']);
  });

  // c2b 尾斜杠差异与多种 fragment 形态都走归一化（query 串形态见 c8）。
  it('c2b) 归一化覆盖尾斜杠差异与多种 fragment 形态（#一程/##彩虹/#🚀）', async () => {
    for (const [url, legacy] of [
      ['https://a.example/', 'https://a.example#一程'],
      ['https://b.example/', 'https://b.example##彩虹'],
      ['https://c.example/read', 'https://c.example/read#🚀'],
    ] as const) {
      await seedSource(url);
      await seedAdmission(legacy);
    }
    openGate();
    expect(await poolUrls()).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/read']);
  });

  // c3 跨条目挡住（安全闸）：biquge001 型真反例——同 host 两条规则行 A（无后缀，在表）/ B（#🎃），
  // 供判准入行属 A（精确键仍在表）。B 借 A 的 ok 结论进池即绕过准入闸，必须挡住；A 自己照常进池。
  it('c3) 跨条目挡住：B（#🎃）不借 A（无后缀，在表）的结论进池；A 照常进池', async () => {
    await seedSource('https://www.biquge001.com');                            // 条目 A（无后缀，精确键在表）
    await seedSource('https://www.biquge001.com#🎃', 'https://www.biquge001.com#🎃'); // 条目 B（带后缀）
    await seedAdmission('https://www.biquge001.com');                         // 供判行属 A（精确键在表）
    openGate();
    expect(await poolUrls()).toEqual(['https://www.biquge001.com/']); // 只有 A，B 被挡
  });

  // c3b 同 host 新旧条目并存（旧形态那条也在表）：只有精确键那份进池，旧形态那份不借别家结论。
  it('c3b) 同 host 新旧条目并存：只有精确键那份进池，旧形态那份不借别家结论', async () => {
    await seedSource('https://mm.suffixjoin.example/#🚀'); // 条目 B（带后缀形态）
    await seedSource('https://mm.suffixjoin.example');     // 条目 A（无后缀）
    await seedAdmission('https://mm.suffixjoin.example');   // 供判行属条目 A（精确键仍在表）
    openGate();
    expect(await poolUrls()).toEqual(['https://mm.suffixjoin.example/']);
  });

  // c4 host 门：真孤儿不放行；形态分裂同条目旧形态放行（救回，与 c2 同口径）；精确在池放行。
  it('c4) host 门：真孤儿不放行、形态分裂同条目放行、精确在池放行', async () => {
    await seedSource('https://chuangshi.qq.com');        // 规则行新键
    await seedAdmission('https://chuangshi.qq.com#🎃'); // 同条目旧形态 ⇒ 放行
    await seedAdmission('https://gone.example', { host: 'gone.example' }); // 真孤儿（表里无对应规则行）
    await seedSource('https://live.example');
    await seedAdmission('https://live.example');        // 精确在池
    openGate();
    expect(await hosts()).toEqual(['chuangshi.qq.com', 'live.example']);
  });

  // c4b host 门与取书池口径一致：跨条目行（笔趣阁🎃#30 带后缀）被取书池挡，但其同 host 的合法条目（笔趣阁1 无后缀）仍放行 host。
  it('c4b) host 门与取书池口径一致：跨条目被挡，同 host 合法条目仍放行', async () => {
    await seedSource('https://www.biquge001.com');                           // 笔趣阁1（无后缀，合法）
    await seedSource('https://www.biquge001.com#🎃', 'https://www.biquge001.com#🎃'); // 笔趣阁🎃#30（跨条目）
    await seedAdmission('https://www.biquge001.com');                        // 供判行精确键 = 笔趣阁1（合法）
    openGate();
    expect(await poolUrls()).toEqual(['https://www.biquge001.com/']);        // 笔趣阁🎃#30 被挡
    expect(await hosts()).toEqual(['www.biquge001.com']);                    // 笔趣阁1 放行 host
  });

  // c5 includePhoenixOk 两态在归一化路径下不漂移：phoenix_ok: 旧形态孤儿缺省仍排除、下载腿开关开时仍收。
  it('c5) includePhoenixOk 两态在归一化路径下语义不漂移', async () => {
    await seedSource('https://phx.example');
    await seedAdmission('https://phx.example#🎃', { error: ADMISSION_PHOENIX_OK_PREFIX });
    openGate();
    expect(await poolUrls()).toEqual([]);
    expect(await hosts()).toEqual([]);
    vi.stubEnv('DOWNLOAD_POOL_INCLUDE_PHOENIX_OK', '1');
    invalidateShuyuanReadCache?.();
    expect((await getDownloadEngineSources(new AbortController().signal)).map((s) => s.url)).toEqual(['https://phx.example/']);
  });

  // c6 行数不膨胀：同 host 新旧键并存时，每条规则行至多一条 admission 匹配。
  it('c6) 行数不膨胀：每条规则行至多配一条 admission 行，精确优先', async () => {
    // 一条规则行 `https://dup.example`，同 host 下三条旧形态孤儿准入行都归一化命中它。
    await seedSource('https://dup.example');
    await seedAdmission('https://dup.example#a');
    await seedAdmission('https://dup.example#b');
    await seedAdmission('https://dup.example#🎃');
    openGate();
    expect(await poolUrls()).toEqual(['https://dup.example/']); // LATERAL LIMIT 1 ⇒ 仍只 1 行，未翻倍
  });

  // c8 query 串保留：归一化只剥 # 之后部分，query（?id=1）完整。
  it('c8) query 串保留：https://x.com/read?id=1 归一化后 query 完整（不误剥）', async () => {
    const norm = "regexp_replace(regexp_replace(btrim(COALESCE(%s, '')), '#.*$', ''), '/+$', '')";
    const stripped = await pg.query(`SELECT ${norm.replace('%s', '$1')} AS out`, ['https://x.com/read?id=1#frag']);
    expect((stripped.rows[0] as { out: string }).out).toBe('https://x.com/read?id=1');
    const kept = await pg.query(`SELECT ${norm.replace('%s', '$1')} AS out`, ['https://x.com/read?id=1']);
    expect((kept.rows[0] as { out: string }).out).toBe('https://x.com/read?id=1');
  });
});