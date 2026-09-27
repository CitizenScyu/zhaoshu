// 41-poolimpl：池合成「产物优先、失败回退库」与写路径发布时序（shuyuan.ts artifactOr / publishPoolArtifact）。
// 钉住：开关关逐字回到库读；产物可用时池/扇出/引擎池/门零 DB 读且与库读结论逐条相同；缺失/过期/损坏/早于本实例写库 ⇒
// 回退库读；写库成功（disable/enable 命中行、refresh 事务提交）才发布，失败/未命中不发布。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  buildShuyuanPoolArtifact, disableShuyuanSource, enableShuyuanSource, getEngineSources, getFanoutPool,
  getPoolEngineHosts, getReadingSources, getSourcePools, invalidateShuyuanReadCache, publishPoolArtifact, refreshShuyuan,
} from './shuyuan';
import { createPoolArtifact, resetPoolArtifactMemo, type PoolArtifact } from './pool-artifact';
import { refreshSupportedHosts, supportedHostList } from './source-policy';

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
const CHECKED = '2026-09-25T00:00:00Z';
const metaWith = (entries: unknown[]) => ({
  collections: [{ id: 1, title: '合集', count: 1, probeSnapshot: { version: 1, entries } }],
  refreshed_at: '2026-09-24T00:00:00Z',
});

const db = {
  hosts: [] as unknown[], meta: metaWith([]) as unknown, builtin: [] as unknown[], engine: [] as unknown[],
  updateHits: 1,
};
function kind(text: string): string {
  if (text.startsWith('SELECT DISTINCT host FROM source_admission')) return 'hosts';
  if (text.startsWith('UPDATE shuyuan_sources')) return 'update';
  if (text.includes('FROM shuyuan_meta') && text.includes('probeSnapshot')) return 'poolMeta';
  if (text.startsWith('SELECT refreshed_at::text AS refreshed_at FROM shuyuan_meta')) return 'refreshedAt';
  if (text.includes('FROM shuyuan_meta')) return 'fullMeta';
  if (text.includes('JOIN source_admission')) return 'engineRows';
  if (text.includes('FROM source_admission')) return 'funnel';
  if (text.startsWith('SELECT count(*)::int AS total')) return 'counts';
  if (text.includes('FROM shuyuan_sources')) return 'builtinRows';
  return 'other';
}
const dbReads = () => execute.mock.calls.map(([query]) => kind(query.text)).filter((k) => k !== 'update');
const signal = () => new AbortController().signal;
const urls = (sources: { url: string }[]) => sources.map((source) => source.url);

let dir: string;
let path: string;

/** 从当前假库生成一份产物写到 path（等价 phoenix 定时生成）；生成时的库读不计入之后的断言。 */
async function seedArtifact(at?: number): Promise<PoolArtifact> {
  const built = await buildShuyuanPoolArtifact(signal());
  const artifact = at === undefined ? built : createPoolArtifact(built, at);
  writeFileSync(path, JSON.stringify(artifact));
  resetPoolArtifactMemo();
  execute.mockClear();
  return artifact;
}

/** 同一场景下开关关（纯库读）得出的各池，作为逐条相同的对照。 */
async function dbBaseline() {
  vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '0');
  refreshSupportedHosts([]);
  const out = {
    reading: urls(await getReadingSources(signal())),
    fanout: (await getFanoutPool(signal())).map((s) => [s.url, s.readable]),
    selectable: urls(await getSourcePools(signal()).then((p) => [...p.selectable])),
    engine: urls(await getEngineSources(signal())),
    gate: supportedHostList(),
  };
  vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
  refreshSupportedHosts([]);
  execute.mockClear();
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'poolimpl41-shuyuan-'));
  path = join(dir, 'pool-artifact.json');
  vi.stubEnv('READING_ENGINE_SOURCES', '1');
  vi.stubEnv('READING_POOL_LIMIT', '10');
  vi.stubEnv('SOURCE_FANOUT_LIMIT', '10');
  vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
  vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', path);
  invalidateShuyuanReadCache();
  resetPoolArtifactMemo();
  refreshSupportedHosts([]);
  db.hosts = [{ host: 'a.example' }, { host: 'b.example' }, { host: 'c.example' }];
  db.meta = metaWith([
    { url: 'https://a.example', status: 'failed', checked_at: CHECKED, error: 'x', consecutive_failures: 3 },
    { url: 'https://c.example', status: 'reachable', checked_at: CHECKED, error: null },
    { url: 'https://unrelated.example', status: 'failed', checked_at: CHECKED, error: 'x' },
  ]);
  db.builtin = [];
  db.engine = [engineRowAt('a.example'), engineRowAt('b.example'), engineRowAt('c.example', { tier: 'T7' })];
  db.updateHits = 1;
  execute.mockReset().mockImplementation(async (query) => {
    switch (kind(query.text)) {
      case 'hosts': return db.hosts;
      case 'poolMeta': case 'fullMeta': case 'refreshedAt': return [db.meta];
      case 'engineRows': return db.engine;
      case 'builtinRows': return db.builtin;
      case 'update': return Array.from({ length: db.updateHits }, (_, id) => ({ id }));
      case 'funnel': return [{ ok: 3, deferred: 0, rejected: 0, url_defaulted: 0, miss_chapter_list: 0,
        miss_chapter_name: 0, rejection_codes: {} }];
      case 'counts': return [{ total: 0, active: 0, enabled: 0, disabled: 0, unprobed: 0, pending: 0, reachable: 0, failed: 0 }];
      default: return [];
    }
  });
  transaction.mockReset().mockResolvedValue([]);
  getSql.mockReturnValue(Object.assign(sql, {
    transaction: (queries: Query[], options?: TransactionOptions) => options?.readOnly
      ? Promise.all(queries.map((query) => execute(query))) : transaction(queries, options),
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateShuyuanReadCache();
  resetPoolArtifactMemo();
  refreshSupportedHosts([]);
  rmSync(dir, { recursive: true, force: true });
});

describe('生成：字段取自库，探测条目只留池行 URL', () => {
  it('hosts 排序、行原样、probe 只留 builtin ∪ engine 行的条目（门外无关条目不带）', async () => {
    const artifact = await buildShuyuanPoolArtifact(signal());
    expect(artifact.hosts).toEqual(['a.example', 'b.example', 'c.example']);
    expect(artifact.engine).toEqual(db.engine);
    expect(artifact.builtin).toEqual([]);
    expect(artifact.refreshedAt).toBe('2026-09-24T00:00:00Z');
    expect(artifact.probe.version).toBe(1);
    expect((artifact.probe.entries as { url: string }[]).map((e) => e.url)).toEqual(['https://a.example', 'https://c.example']);
  });

  it('同一库态两次生成 contentHash 相同', async () => {
    const a = await buildShuyuanPoolArtifact(signal());
    const b = await buildShuyuanPoolArtifact(signal());
    expect(b.contentHash).toBe(a.contentHash);
  });
});

describe('消费：产物优先', () => {
  it('产物可用 ⇒ 取书池/扇出/selectable/引擎池/门与库读逐条相同，且零 DB 读', async () => {
    const baseline = await dbBaseline();
    expect(baseline.reading).toEqual(['https://book15.net/', 'https://c.example/', 'https://b.example/']);
    await seedArtifact();
    expect(urls(await getReadingSources(signal()))).toEqual(baseline.reading);
    expect((await getFanoutPool(signal())).map((s) => [s.url, s.readable])).toEqual(baseline.fanout);
    expect(urls(await getSourcePools(signal()).then((p) => [...p.selectable]))).toEqual(baseline.selectable);
    expect(urls(await getEngineSources(signal()))).toEqual(baseline.engine);
    expect(supportedHostList()).toEqual(baseline.gate);
    expect(await getPoolEngineHosts(signal())).toEqual(['a.example', 'b.example', 'c.example']);
    expect(dbReads()).toEqual([]);
  });

  it('开关关 ⇒ 不采信产物，逐字走库读（产物内容与库不同也不影响）', async () => {
    await seedArtifact();
    db.engine = [engineRowAt('b.example')];
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '0');
    expect(urls(await getReadingSources(signal()))).toEqual(['https://book15.net/', 'https://b.example/']);
    expect(dbReads()).toEqual(expect.arrayContaining(['hosts', 'poolMeta', 'builtinRows', 'engineRows']));
    expect(await getPoolEngineHosts(signal())).toEqual(['a.example', 'b.example', 'c.example']);
    expect(dbReads().filter((k) => k === 'hosts')).toHaveLength(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', () => rmSync(path)],
    ['invalid_json', () => writeFileSync(path, '{"schemaVersion":1')],
    ['hash_mismatch', () => {
      const tampered = JSON.parse(readFileSync(path, 'utf8'));
      tampered.hosts.push('evil.example');
      writeFileSync(path, JSON.stringify(tampered));
    }],
    ['schema', () => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), schemaVersion: 2 }))],
  ])('产物 %s ⇒ 回退库读并告警，池结论与库读相同', async (reason, breakIt) => {
    const baseline = await dbBaseline();
    await seedArtifact();
    breakIt();
    resetPoolArtifactMemo();
    expect(urls(await getReadingSources(signal()))).toEqual(baseline.reading);
    expect(dbReads()).toEqual(expect.arrayContaining(['hosts', 'poolMeta', 'builtinRows', 'engineRows']));
    expect(console.warn).toHaveBeenCalledWith('shuyuan pool artifact unavailable, falling back to db', { reason, from: 'file' });
  });

  it('产物过期（默认 36h）⇒ 回退库读；调大 SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS 后照常采信', async () => {
    await seedArtifact(Date.now() - 37 * 3_600_000);
    db.engine = [engineRowAt('b.example')];
    expect(urls(await getReadingSources(signal()))).toEqual(['https://book15.net/', 'https://b.example/']);
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), { reason: 'stale', from: 'file' });
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS', '48');
    execute.mockClear();
    expect(urls(await getReadingSources(signal()))).toEqual(['https://book15.net/', 'https://c.example/', 'https://b.example/']);
    expect(dbReads()).toEqual([]);
  });

  it('本实例写库后（未能本机发布）⇒ 早于写库的产物不采信、回退库读，读己之写不变', async () => {
    await seedArtifact(Date.now() - 60_000);
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', '');
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_URL', 'https://pool.example/p.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(artifact))));
    expect(urls(await getReadingSources(signal()))).toContain('https://c.example/');
    expect(dbReads()).toEqual([]);
    db.engine = [engineRowAt('a.example'), engineRowAt('b.example'), engineRowAt('c.example', { disabled_at: CHECKED })];
    expect(await disableShuyuanSource('https://c.example', '人工禁用')).toBe(true);
    expect(urls(await getReadingSources(signal()))).toEqual(['https://book15.net/', 'https://b.example/']);
    expect(dbReads()).toContain('engineRows');
  });
});

describe('写路径时序：写库成功才发布', () => {
  it('disable 命中行 ⇒ 发布新产物（含禁用标记），之后本实例零 DB 读且被禁用源出池', async () => {
    await seedArtifact();
    const before = JSON.parse(readFileSync(path, 'utf8')).contentHash;
    db.engine = [engineRowAt('a.example'), engineRowAt('b.example'), engineRowAt('c.example', { disabled_at: CHECKED })];
    expect(await disableShuyuanSource('https://c.example', '人工禁用')).toBe(true);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.contentHash).not.toBe(before);
    expect(after.engine.find((row: { source_url: string }) => row.source_url === 'https://c.example').disabled_at).toBe(CHECKED);
    execute.mockClear();
    expect(urls(await getReadingSources(signal()))).toEqual(['https://book15.net/', 'https://b.example/']);
    expect(dbReads()).toEqual([]);
  });

  it('enable 命中行 ⇒ 发布；URL 不在库（0 行）⇒ 不发布、不生成（零生成读）', async () => {
    db.engine = [engineRowAt('a.example'), engineRowAt('b.example'), engineRowAt('c.example', { disabled_at: CHECKED })];
    await seedArtifact();
    db.engine = [engineRowAt('a.example'), engineRowAt('b.example'), engineRowAt('c.example')];
    expect(await enableShuyuanSource('https://c.example')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).engine[2].disabled_at).toBeNull();
    rmSync(path);
    db.updateHits = 0;
    execute.mockClear();
    expect(await disableShuyuanSource('https://nope.example', 'x')).toBe(false);
    expect(await enableShuyuanSource('https://nope.example')).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(dbReads()).toEqual([]);
  });

  it('UPDATE 抛错 ⇒ 不发布（错误照旧抛给调用方）', async () => {
    execute.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(disableShuyuanSource('https://c.example', 'x')).rejects.toThrow('db down');
    expect(existsSync(path)).toBe(false);
  });

  it('开关关或未配路径 ⇒ publish skipped，不读库不写文件', async () => {
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '0');
    expect(await publishPoolArtifact()).toBe('skipped');
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', '');
    expect(await publishPoolArtifact()).toBe('skipped');
    expect(dbReads()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('生成失败 ⇒ failed + 脱敏告警，不抛（写路径不受影响）', async () => {
    execute.mockImplementation(async () => { throw new Error('connect postgresql://u:secret@h/db failed'); });
    expect(await publishPoolArtifact()).toBe('failed');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret');
    expect(existsSync(path)).toBe(false);
  });

  describe('refreshShuyuan', () => {
    const stubUpstream = () => {
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
    };

    it('全量替换事务提交 ⇒ 发布产物（内容 = 提交后库态）', async () => {
      stubUpstream();
      await refreshShuyuan();
      expect(transaction).toHaveBeenCalledTimes(1);
      const artifact = JSON.parse(readFileSync(path, 'utf8'));
      expect(artifact.hosts).toEqual(['a.example', 'b.example', 'c.example']);
      const txOrder = transaction.mock.invocationCallOrder[0];
      const lastEngineRead = execute.mock.calls.map(([q], i) => [kind(q.text), execute.mock.invocationCallOrder[i]] as const)
        .filter(([k]) => k === 'engineRows').at(-1)![1];
      expect(lastEngineRead).toBeGreaterThan(txOrder);
    });

    it('事务失败（快照守卫 22012）⇒ 不发布', async () => {
      stubUpstream();
      transaction.mockRejectedValueOnce(Object.assign(new Error('division by zero'), { code: '22012' }));
      await expect(refreshShuyuan()).rejects.toThrow('书源在刷新期间发生变化');
      expect(existsSync(path)).toBe(false);
    });
  });
});
