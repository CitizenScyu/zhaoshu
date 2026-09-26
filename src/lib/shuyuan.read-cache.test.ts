// xfer41：池合成读缓存（shuyuan.ts cachedRead / poolProbeMeta）。Neon 免费档传输额度被池合成重复读库打爆，
// 这里钉住：同一进程重复合成只读一次库、写路径之后读到新值、TTL 到期重读、失败/降级不入缓存、
// 并发共用一次加载、调用方中止不连坐其他等待者、TTL=0 完全旁路（单测默认值，见 vitest.config.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { text: string; values: unknown[] };
type TransactionOptions = { readOnly?: boolean; fetchOptions?: { signal: AbortSignal } };

const { getSql, sql, execute, transaction } = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
    return {
      ...query,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected: (error: unknown) => unknown) {
        return execute(query).then(onFulfilled, onRejected);
      },
    };
  });
  return {
    getSql: vi.fn(), sql, execute,
    transaction: vi.fn<(queries: Query[], options?: TransactionOptions) => Promise<unknown[][]>>(),
  };
});

vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));

import {
  DEFAULT_SHUYUAN_READ_CACHE_TTL_MS, disableShuyuanSource, enableShuyuanSource, getEngineSources, getFanoutPool,
  getReadingSources, getShuyuanPoolHealth, invalidateShuyuanReadCache, refreshShuyuan, shuyuanReadCacheTtlMs,
  writeAdmissionRows,
} from './shuyuan';
import { refreshSupportedHosts, supportedHostList } from './source-policy';
import { resolveDownloadSource } from './download-source';
import { rulesHash, type AdmissionSourceRow } from './rule-engine/admission';

const engineItemAt = (host: string) => ({
  bookSourceUrl: `https://${host}/`, bookSourceName: host,
  searchUrl: `https://${host}/s?q={{key}}`,
  ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '.ch', chapterName: 'a@text' },
  ruleContent: { content: '.c' }, enabled: true,
});
const engineRowAt = (host: string, over: Record<string, unknown> = {}) => ({
  source_url: `https://${host}`, source: engineItemAt(host), name: host,
  disabled_at: null, last_error: '', tier: 'M1', search_checked_at: null, ...over,
});
const metaWith = (entries: unknown[]) => ({
  collections: [{ id: 1, title: '合集', count: 1, probeSnapshot: { version: 1, entries } }],
  refreshed_at: '2026-09-24T00:00:00Z',
});

/** 按 SQL 文本分派的假库；db 可在用例里改（模拟「库里的数据变了」）。 */
const db = {
  hosts: [{ host: 'a.example' }, { host: 'b.example' }] as unknown[],
  meta: metaWith([]) as unknown,
  builtin: [] as unknown[],
  engine: [engineRowAt('a.example'), engineRowAt('b.example')] as unknown[],
  engineError: null as Error | null,
};
function kind(text: string): string {
  if (text.startsWith('SELECT DISTINCT host FROM source_admission')) return 'hosts';
  if (text.startsWith('SELECT count(*)::int AS total')) return 'counts';
  if (text.includes('FROM shuyuan_meta') && text.includes('probeSnapshot')) return 'poolMeta';
  if (text.startsWith('SELECT refreshed_at::text AS refreshed_at FROM shuyuan_meta')) return 'refreshedAt';
  if (text.includes('FROM shuyuan_meta')) return 'fullMeta';
  if (text.includes('JOIN source_admission')) return 'engineRows';
  if (text.includes('FROM source_admission')) return 'funnel';
  if (text.includes('FROM shuyuan_sources')) return 'builtinRows';
  return 'other';
}
const counts = () => {
  const out: Record<string, number> = {};
  for (const [query] of execute.mock.calls) out[kind(query.text)] = (out[kind(query.text)] ?? 0) + 1;
  return out;
};
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '300000');
  vi.stubEnv('READING_ENGINE_SOURCES', '1');
  vi.stubEnv('READING_POOL_LIMIT', '10');
  invalidateShuyuanReadCache();
  refreshSupportedHosts([]);
  db.hosts = [{ host: 'a.example' }, { host: 'b.example' }];
  db.meta = metaWith([]);
  db.builtin = [];
  db.engine = [engineRowAt('a.example'), engineRowAt('b.example')];
  db.engineError = null;
  execute.mockReset().mockImplementation(async (query) => {
    switch (kind(query.text)) {
      case 'hosts': return db.hosts;
      case 'poolMeta': case 'fullMeta': case 'refreshedAt': return [db.meta];
      case 'engineRows': if (db.engineError) throw db.engineError; return db.engine;
      case 'builtinRows': return db.builtin;
      case 'counts': return [{ total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 }];
      case 'funnel': return [{ ok: 2, deferred: 0, rejected: 0, url_defaulted: 0, miss_chapter_list: 0,
        miss_chapter_name: 0, rejection_codes: {} }];
      default: return [];
    }
  });
  transaction.mockReset().mockResolvedValue([]);
  getSql.mockReturnValue(Object.assign(sql, {
    transaction: (queries: Query[], options?: TransactionOptions) => options?.readOnly
      ? Promise.all(queries.map((query) => execute(query))) : transaction(queries, options),
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateShuyuanReadCache();
  refreshSupportedHosts([]);
});

describe('shuyuanReadCacheTtlMs（env SHUYUAN_READ_CACHE_TTL_MS）', () => {
  it('缺失/非法回落默认 300s；0 关闭；超上限夹到 3600s', () => {
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '');
    expect(shuyuanReadCacheTtlMs()).toBe(DEFAULT_SHUYUAN_READ_CACHE_TTL_MS);
    expect(DEFAULT_SHUYUAN_READ_CACHE_TTL_MS).toBe(300_000);
    for (const bad of ['abc', '-1', '1.5']) {
      vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', bad);
      expect(shuyuanReadCacheTtlMs()).toBe(DEFAULT_SHUYUAN_READ_CACHE_TTL_MS);
    }
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    expect(shuyuanReadCacheTtlMs()).toBe(0);
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '99999999');
    expect(shuyuanReadCacheTtlMs()).toBe(3_600_000);
  });
});

describe('池合成读缓存', () => {
  it('反例：同一进程两次池合成只触发一次探测快照查询（hosts/builtin/engine 也各一次）', async () => {
    const first = await getReadingSources(signal());
    const second = await getReadingSources(signal());
    expect(second).toEqual(first);
    expect(first.map((source) => source.url)).toEqual(['https://book15.net/', 'https://a.example/', 'https://b.example/']);
    expect(counts()).toEqual({ hosts: 1, poolMeta: 1, builtinRows: 1, engineRows: 1 });
    // 改前是整列 SELECT collections；投影后不再出现整列读。
    expect(execute.mock.calls.some(([query]) => query.text.startsWith('SELECT collections'))).toBe(false);
  });

  it('取书池 / 扇出池 / 引擎池共用同一批缓存行；入池判定每次照常重算（返回新数组）', async () => {
    const a = await getReadingSources(signal());
    const fan = await getFanoutPool(signal());
    const eng = await getEngineSources(signal());
    expect(fan.map((source) => source.url)).toEqual(a.map((source) => source.url));
    expect(eng.map((source) => source.url)).toEqual(['https://a.example/', 'https://b.example/']);
    expect(counts()).toEqual({ hosts: 1, poolMeta: 1, builtinRows: 1, engineRows: 1 });
    const again = await getReadingSources(signal());
    expect(again).not.toBe(a);
    again.pop();
    expect(await getReadingSources(signal())).toHaveLength(3);
  });

  it('health：refreshed_at 单独小查询（不再整列读），池走缓存；一次 health 零整列读', async () => {
    await getShuyuanPoolHealth(signal());
    await getShuyuanPoolHealth(signal());
    expect(counts()).toEqual({ refreshedAt: 2, hosts: 1, poolMeta: 1, builtinRows: 1, engineRows: 1, funnel: 2 });
  });

  it('并发：同一批请求共用一次加载（single-flight）', async () => {
    const results = await Promise.all(Array.from({ length: 13 }, () => getFanoutPool(signal())));
    expect(new Set(results.map((pool) => pool.length))).toEqual(new Set([3]));
    expect(counts()).toEqual({ hosts: 1, poolMeta: 1, builtinRows: 1, engineRows: 1 });
  });

  it('调用方中止只影响它自己：同批其他等待者照常拿到结果，结果也入缓存', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = execute.getMockImplementation()!;
    execute.mockImplementation(async (query) => { await gate; return base(query); });
    const aborted = new AbortController();
    const a = getReadingSources(aborted.signal);
    const b = getReadingSources(signal());
    aborted.abort(new Error('client gone'));
    release();
    await expect(a).rejects.toBeTruthy();
    await expect(b).resolves.toHaveLength(3);
    await getReadingSources(signal());
    expect(counts()).toEqual({ hosts: 1, poolMeta: 1, builtinRows: 1, engineRows: 1 });
  });

  it('TTL 到期后重读', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
    await getReadingSources(signal());
    vi.setSystemTime(Date.now() + DEFAULT_SHUYUAN_READ_CACHE_TTL_MS - 1);
    await getReadingSources(signal());
    expect(counts().poolMeta).toBe(1);
    vi.setSystemTime(Date.now() + 2);
    await getReadingSources(signal());
    expect(counts()).toEqual({ hosts: 2, poolMeta: 2, builtinRows: 2, engineRows: 2 });
  });

  it('TTL=0：完全旁路，每次都读库（单测默认，vitest.config.ts）', async () => {
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    await getReadingSources(signal());
    await getReadingSources(signal());
    expect(counts()).toEqual({ hosts: 2, poolMeta: 2, builtinRows: 2, engineRows: 2 });
  });

  it('引擎行读失败 ⇒ 本次降级 builtin-only，但失败不入缓存：下个请求重读并恢复', async () => {
    db.engineError = new Error('relation "source_admission" does not exist');
    expect((await getReadingSources(signal())).map((source) => source.tier)).toEqual(['builtin']);
    db.engineError = null;
    expect(await getReadingSources(signal())).toHaveLength(3);
    expect(counts().engineRows).toBe(2);
    expect(counts().poolMeta).toBe(1);
  });

  it('host 门变化 ⇒ 探测快照投影换键重读（新准入 host 的条目不会被旧投影漏掉）', async () => {
    await getReadingSources(signal());
    invalidateShuyuanReadCache();
    db.hosts = [{ host: 'a.example' }, { host: 'b.example' }, { host: 'c.example' }];
    await getReadingSources(signal());
    const metaQueries = execute.mock.calls.map(([query]) => query).filter((query) => kind(query.text) === 'poolMeta');
    expect(metaQueries).toHaveLength(2);
    // 投影参数就是当时的门集合（字典序）：第二次带上了 c.example。
    expect(JSON.parse(metaQueries[1].values.at(-1) as string)).toContain('c.example');
    expect(JSON.parse(metaQueries[0].values.at(-1) as string)).not.toContain('c.example');
  });

  it('41-xferfix N2：条目有硬上限（引擎开关关时门变化不经整体作废），超限淘汰最旧的门投影', async () => {
    vi.stubEnv('READING_ENGINE_SOURCES', '0');
    const gates = Array.from({ length: 70 }, (_, i) => [`g${i}.example`]);
    for (const gate of gates) { refreshSupportedHosts(gate); await getReadingSources(signal()); }
    expect(counts().poolMeta).toBe(70);
    refreshSupportedHosts(gates[69]);
    await getReadingSources(signal()); // 最新的门仍命中
    expect(counts().poolMeta).toBe(70);
    refreshSupportedHosts(gates[0]);
    await getReadingSources(signal()); // 最旧的已被淘汰 ⇒ 重读
    expect(counts().poolMeta).toBe(71);
  });
});

// 41-xferfix B1：host 门是模块级全局态，池合成每次按 engineHosts 整集重置它。缓存命中时拿的是旧 host 集，
// 会把调用方刚按最新准入态放行的 host 抹掉（门被「刷旧」），且缓存的引擎行也没有该源 ⇒ 池里丢源最长一个 TTL。
// 原则：缓存不得改变「未缓存时」的可见行为——同一场景在 TTL=0 与 TTL=300s 下结果必须一致。
describe('缓存不得改变未缓存时的可见行为（host 门，41-xferfix B1）', () => {
  /** 他实例/cron 准入了 c.example（本实例没走写路径，缓存未失效）。 */
  const admitElsewhere = () => {
    db.hosts = [...db.hosts, { host: 'c.example' }];
    db.engine = [...db.engine, engineRowAt('c.example')];
  };

  it('反例：download-source 刚按最新准入态放行的 host，不被池合成的旧缓存刷掉', async () => {
    await getReadingSources(signal()); // 缓存 hosts=[a,b] / engineRows=[a,b]
    admitElsewhere();
    await expect(resolveDownloadSource('https://c.example/book/1')).resolves
      .toMatchObject({ kind: 'engine', id: 'https://c.example/' });
    expect(supportedHostList()).toContain('c.example');
  });

  it('门未被外部改动时照常命中缓存（download-source 的鲜读与缓存一致 ⇒ 不作废）', async () => {
    await getReadingSources(signal());
    await expect(resolveDownloadSource('https://a.example/book/1')).resolves.toMatchObject({ kind: 'engine' });
    await getReadingSources(signal());
    expect(counts()).toEqual({ hosts: 2, poolMeta: 1, builtinRows: 1, engineRows: 1 });
  });

  async function scenario() {
    const out: unknown[] = [];
    await getReadingSources(signal());
    // 评审员场景：调用方放行一个库里并未准入的 host，随后池合成（未缓存时按 DB 实况重置门）。
    refreshSupportedHosts(['extra.example']);
    out.push((await getReadingSources(signal())).map((source) => source.url), supportedHostList());
    admitElsewhere();
    refreshSupportedHosts(['a.example', 'b.example', 'c.example']);
    out.push((await getEngineSources(signal())).map((source) => source.url), supportedHostList());
    return out;
  }

  it('差分：同一场景 TTL=0 与 TTL=300s 的池与门逐项相同', async () => {
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    const uncached = await scenario();
    db.hosts = [{ host: 'a.example' }, { host: 'b.example' }];
    db.engine = [engineRowAt('a.example'), engineRowAt('b.example')];
    refreshSupportedHosts([]);
    invalidateShuyuanReadCache();
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '300000');
    expect(await scenario()).toEqual(uncached);
    expect(uncached[2]).toContain('https://c.example/');
    expect(uncached[1]).not.toContain('extra.example');
  });
});

describe('写路径之后读到新值（本实例失效缓存）', () => {
  it('disableShuyuanSource ⇒ 下一次池合成重读，被禁用源出池', async () => {
    expect(await getReadingSources(signal())).toHaveLength(3);
    db.engine = [engineRowAt('a.example', { disabled_at: '2026-09-25T00:00:00Z' }), engineRowAt('b.example')];
    await disableShuyuanSource('https://a.example', '人工禁用');
    expect((await getReadingSources(signal())).map((source) => source.url))
      .toEqual(['https://book15.net/', 'https://b.example/']);
    expect(counts().engineRows).toBe(2);
  });

  it('enableShuyuanSource ⇒ 重读，恢复源回池', async () => {
    db.engine = [engineRowAt('a.example', { disabled_at: '2026-09-25T00:00:00Z' }), engineRowAt('b.example')];
    expect(await getReadingSources(signal())).toHaveLength(2);
    db.engine = [engineRowAt('a.example'), engineRowAt('b.example')];
    await enableShuyuanSource('https://a.example');
    expect(await getReadingSources(signal())).toHaveLength(3);
  });

  it('writeAdmissionRows ⇒ 重读（新准入 ok 源当次可见）', async () => {
    expect(await getReadingSources(signal())).toHaveLength(3);
    db.hosts = [...db.hosts, { host: 'c.example' }];
    db.engine = [...db.engine, engineRowAt('c.example')];
    const hash = rulesHash(engineItemAt('c.example'));
    const row: AdmissionSourceRow = {
      source_url: 'https://c.example', tier: 'M1', compile_ok: true, core_field_mask: {}, search_ok: true,
      search_verdict: 'ok', search_checked_at: null, rules_hash: hash,
      engine_semantics_version: Number(hash.split(':', 1)[0]), host: 'c.example', error: '', compile_diagnostics: [],
    };
    await writeAdmissionRows(getSql(), [row]);
    expect((await getReadingSources(signal())).map((source) => source.url)).toContain('https://c.example/');
  });

  it('refreshShuyuan 提交后 ⇒ 重读（探测快照换新，failed 源出池）', async () => {
    const responses = new Map<string, string>([
      ['https://www.yckceo.com/yuedu/shuyuans/index.html',
        [11, 12, 13].map((id) => `<a href="/yuedu/shuyuans/content/id/${id}.html">合集 ${id}</a>`).join('')],
      ...[11, 12, 13].map((id) => [`https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`,
        JSON.stringify(id === 11 ? [{ bookSourceUrl: 'https://x.invalid', bookSourceName: 'x' }] : [])] as [string, string]),
    ]);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const body = responses.get(String(input));
      if (body === undefined) throw new Error(`unexpected fetch ${String(input)}`);
      return new Response(body);
    }));
    expect(await getReadingSources(signal())).toHaveLength(3);
    await refreshShuyuan();
    expect(transaction).toHaveBeenCalledTimes(1);
    db.meta = metaWith([{ url: 'https://a.example', status: 'failed', checked_at: '2026-09-25T00:00:00Z' }]);
    expect((await getReadingSources(signal())).map((source) => source.url))
      .toEqual(['https://book15.net/', 'https://b.example/']);
  });
});
