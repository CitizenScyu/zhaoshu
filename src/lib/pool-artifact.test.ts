// 41-poolimpl：源池产物模块（pool-artifact.ts）——字段与 hash 稳定性、解析拒收、env 旋钮、文件/URL 加载（含 ETag 304）、
// 本实例写库后不采信旧产物、原子写与心跳。池合成层的消费/回退/写路径时序见 shuyuan.pool-artifact.test.ts。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPoolArtifact, currentPoolArtifact, DEFAULT_POOL_ARTIFACT_HEARTBEAT_MS, MAX_POOL_ARTIFACT_BYTES,
  noteLocalPoolWrite, parsePoolArtifact, poolArtifactEnabled, poolArtifactHash, poolArtifactMaxAgeMs,
  POOL_ARTIFACT_SCHEMA_VERSION, resetPoolArtifactMemo, stableStringify, writePoolArtifactFile,
} from './pool-artifact';

const HOUR = 3_600_000;
const body = () => ({
  refreshedAt: '2026-09-26T02:00:00.000Z',
  hosts: ['a.example', 'b.example'],
  builtin: [{ source_url: 'https://book15.net', name: 'book15', source: { b: 1, a: 2 }, disabled_at: null, last_error: '' }],
  engine: [{
    source_url: 'https://a.example', name: 'a', source: { searchUrl: 'https://a.example/s?q={{key}}', ruleSearch: { z: 1, y: 2 } },
    disabled_at: null, last_error: '', tier: 'M1', search_checked_at: '2026-09-26T02:10:00+00',
  }],
  probe: { version: 1, entries: [{ url: 'https://a.example', status: 'reachable', checked_at: '2026-09-26T01:00:00Z' }] },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poolimpl41-'));
  resetPoolArtifactMemo();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPoolArtifactMemo();
  rmSync(dir, { recursive: true, force: true });
});

describe('产物字段与 contentHash', () => {
  it('字段齐全：schemaVersion / generatedAt / refreshedAt / contentHash / hosts / builtin / engine / probe', () => {
    const artifact = createPoolArtifact(body(), Date.parse('2026-09-26T03:00:00Z'));
    expect(Object.keys(artifact).sort()).toEqual(
      ['builtin', 'contentHash', 'engine', 'generatedAt', 'hosts', 'probe', 'refreshedAt', 'schemaVersion']);
    expect(artifact.schemaVersion).toBe(POOL_ARTIFACT_SCHEMA_VERSION);
    expect(artifact.generatedAt).toBe('2026-09-26T03:00:00.000Z');
    expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash 稳定：同内容不同生成时刻 hash 相同；jsonb 对象键序不同 hash 相同', () => {
    const a = createPoolArtifact(body(), 1_000);
    const b = createPoolArtifact(body(), 9_000_000);
    expect(b.contentHash).toBe(a.contentHash);
    const reordered = body();
    reordered.builtin[0].source = { a: 2, b: 1 };
    reordered.engine[0].source = { ruleSearch: { y: 2, z: 1 }, searchUrl: 'https://a.example/s?q={{key}}' };
    expect(createPoolArtifact(reordered).contentHash).toBe(a.contentHash);
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('hash 敏感：规则、禁用标记、探测态、host、数组顺序任一变化都换 hash', () => {
    const base = createPoolArtifact(body()).contentHash;
    const variants = [
      (x: ReturnType<typeof body>) => { x.engine[0].source.searchUrl = 'https://a.example/t?q={{key}}'; },
      (x: ReturnType<typeof body>) => { (x.engine[0] as { disabled_at: string | null }).disabled_at = '2026-09-26T04:00:00Z'; },
      (x: ReturnType<typeof body>) => { x.probe.entries[0].status = 'failed'; },
      (x: ReturnType<typeof body>) => { x.hosts = ['b.example', 'a.example']; },
      (x: ReturnType<typeof body>) => { x.refreshedAt = '2026-09-27T02:00:00.000Z'; },
    ];
    for (const mutate of variants) {
      const changed = body();
      mutate(changed);
      expect(createPoolArtifact(changed).contentHash).not.toBe(base);
    }
  });
});

describe('parsePoolArtifact：拒收即回退', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  const fresh = () => createPoolArtifact(body(), now - HOUR);

  it('合法产物通过', () => {
    const parsed = parsePoolArtifact(JSON.stringify(fresh()), now, 36 * HOUR);
    expect(parsed.ok).toBe(true);
  });

  it('JSON 损坏 / 版本不符 / 缺字段 / 行形状不对 / hash 不符 / 过期 / 超前 / 超大', () => {
    const cases: [string, string][] = [
      ['{"schemaVersion":1,', 'invalid_json'],
      [JSON.stringify({ ...fresh(), schemaVersion: 2 }), 'schema'],
      [JSON.stringify({ ...fresh(), hosts: undefined }), 'schema'],
      [JSON.stringify({ ...fresh(), engine: [{ source_url: 'https://a.example' }] }), 'schema'],
      [JSON.stringify({ ...fresh(), hosts: ['evil.example'] }), 'hash_mismatch'],
      [JSON.stringify(createPoolArtifact(body(), now - 37 * HOUR)), 'stale'],
      [JSON.stringify(createPoolArtifact(body(), now + HOUR)), 'future'],
      ['x'.repeat(MAX_POOL_ARTIFACT_BYTES + 1), 'too_large'],
    ];
    for (const [text, reason] of cases) expect(parsePoolArtifact(text, now, 36 * HOUR)).toEqual({ ok: false, reason });
  });
});

describe('env 旋钮', () => {
  it('SHUYUAN_POOL_ARTIFACT：只有 1/true/on 开，缺失/0/其他一律关', () => {
    expect(poolArtifactEnabled({})).toBe(false);
    for (const off of ['0', 'false', 'off', 'yes', '']) expect(poolArtifactEnabled({ SHUYUAN_POOL_ARTIFACT: off })).toBe(false);
    for (const on of ['1', 'true', 'ON', ' on ']) expect(poolArtifactEnabled({ SHUYUAN_POOL_ARTIFACT: on })).toBe(true);
  });

  it('SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS：默认 36h；非法/≤0 回落；可带小数；上限 14 天', () => {
    expect(poolArtifactMaxAgeMs({})).toBe(36 * HOUR);
    for (const bad of ['x', '0', '-3']) expect(poolArtifactMaxAgeMs({ SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS: bad })).toBe(36 * HOUR);
    expect(poolArtifactMaxAgeMs({ SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS: '1.5' })).toBe(1.5 * HOUR);
    expect(poolArtifactMaxAgeMs({ SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS: '100000' })).toBe(14 * 24 * HOUR);
  });
});

describe('currentPoolArtifact：文件来源', () => {
  it('开关关 ⇒ null，不读文件（即使路径指向合法产物）', async () => {
    const path = join(dir, 'pool.json');
    writeFileSync(path, JSON.stringify(createPoolArtifact(body())));
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', path);
    expect(await currentPoolArtifact()).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('开关开 + 合法文件 ⇒ 产物；文件缺失 ⇒ null 并告警 missing；未配置来源 ⇒ not_configured', async () => {
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    const path = join(dir, 'pool.json');
    const artifact = createPoolArtifact(body());
    writeFileSync(path, JSON.stringify(artifact));
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', path);
    expect((await currentPoolArtifact())?.contentHash).toBe(artifact.contentHash);
    rmSync(path);
    expect(await currentPoolArtifact()).toBeNull();
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), { reason: 'missing', from: 'file' });
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', '');
    expect(await currentPoolArtifact()).toBeNull();
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), { reason: 'not_configured', from: 'none' });
  });

  it('TTL 内记忆：同一窗口多次取只读一次文件（文件换了也要等 TTL）', async () => {
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '300000');
    const path = join(dir, 'pool.json');
    const first = createPoolArtifact(body());
    writeFileSync(path, JSON.stringify(first));
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', path);
    expect((await currentPoolArtifact())?.contentHash).toBe(first.contentHash);
    writeFileSync(path, JSON.stringify(createPoolArtifact({ ...body(), hosts: ['c.example'] })));
    expect((await currentPoolArtifact())?.contentHash).toBe(first.contentHash);
    resetPoolArtifactMemo();
    expect((await currentPoolArtifact())?.hosts).toEqual(['c.example']);
  });

  it('本实例写库后：generatedAt 早于写库时刻的产物不采信，新发布的产物照常采信', async () => {
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '300000');
    const path = join(dir, 'pool.json');
    const now = Date.now();
    writeFileSync(path, JSON.stringify(createPoolArtifact(body(), now - 60_000)));
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', path);
    expect(await currentPoolArtifact()).not.toBeNull();
    noteLocalPoolWrite(now);
    expect(await currentPoolArtifact()).toBeNull();
    writeFileSync(path, JSON.stringify(createPoolArtifact(body(), now + 1_000)));
    resetPoolArtifactMemo();
    expect(await currentPoolArtifact()).not.toBeNull();
  });
});

describe('currentPoolArtifact：URL 来源', () => {
  beforeEach(() => {
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT', '1');
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
  });

  it('200 带 ETag ⇒ 产物；下次带 If-None-Match，304 复用上次产物（只回几百字节）', async () => {
    const artifact = createPoolArtifact(body());
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const inm = (init?.headers as Record<string, string>)['If-None-Match'];
      return inm === '"v1"' ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(artifact), { headers: { etag: '"v1"' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_URL', 'https://pool.example/pool-artifact.json');
    expect((await currentPoolArtifact())?.contentHash).toBe(artifact.contentHash);
    expect((await currentPoolArtifact())?.contentHash).toBe(artifact.contentHash);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({ 'If-None-Match': '"v1"' });
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('304 复用的产物照样判过期（生成器停摆 ⇒ 回退库）', async () => {
    const now = Date.now();
    const artifact = createPoolArtifact(body(), now - 35 * HOUR);
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) =>
      (init?.headers as Record<string, string>)['If-None-Match']
        ? new Response(null, { status: 304 }) : new Response(JSON.stringify(artifact), { headers: { etag: '"v1"' } })));
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_URL', 'https://pool.example/p.json');
    expect(await currentPoolArtifact()).not.toBeNull();
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS', '34');
    expect(await currentPoolArtifact()).toBeNull();
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), { reason: 'stale', from: 'url' });
  });

  it('非 https / HTTP 错误 / 网络失败 / 超大 ⇒ null 并告警对应原因', async () => {
    const cases: [string, () => Promise<Response>, string][] = [
      ['http://pool.example/p.json', async () => new Response('{}'), 'bad_url'],
      ['https://pool.example/p.json', async () => new Response('nope', { status: 404 }), 'http_status'],
      ['https://pool.example/p.json', async () => { throw new TypeError('fetch failed'); }, 'fetch_failed'],
      ['https://pool.example/p.json', async () => new Response('x', {
        headers: { 'content-length': String(MAX_POOL_ARTIFACT_BYTES + 1) } }), 'too_large'],
    ];
    for (const [url, respond, reason] of cases) {
      vi.stubGlobal('fetch', vi.fn(respond));
      vi.stubEnv('SHUYUAN_POOL_ARTIFACT_URL', url);
      expect(await currentPoolArtifact()).toBeNull();
      expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), { reason, from: 'url' });
    }
  });

  it('文件路径优先于 URL（phoenix 两者都配时不出网）', async () => {
    const path = join(dir, 'pool.json');
    writeFileSync(path, JSON.stringify(createPoolArtifact(body())));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_PATH', path);
    vi.stubEnv('SHUYUAN_POOL_ARTIFACT_URL', 'https://pool.example/p.json');
    expect(await currentPoolArtifact()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('writePoolArtifactFile：原子写 + 心跳', () => {
  it('首次写入；同 hash 且未超心跳 ⇒ unchanged（文件不动，ETag 不变）；超心跳 ⇒ 重写刷新 generatedAt', async () => {
    const path = join(dir, 'pool.json');
    const t0 = Date.now();
    expect(await writePoolArtifactFile(path, createPoolArtifact(body(), t0), { now: t0 })).toBe('written');
    const before = readFileSync(path, 'utf8');
    expect(await writePoolArtifactFile(path, createPoolArtifact(body(), t0 + HOUR), { now: t0 + HOUR })).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(before);
    const later = t0 + DEFAULT_POOL_ARTIFACT_HEARTBEAT_MS + HOUR;
    expect(await writePoolArtifactFile(path, createPoolArtifact(body(), later), { now: later })).toBe('written');
    expect(JSON.parse(readFileSync(path, 'utf8')).generatedAt).toBe(new Date(later).toISOString());
    expect(readdirSync(dir)).toEqual(['pool.json']);
  });

  it('内容变化 ⇒ 立即重写；已有文件损坏 ⇒ 覆盖', async () => {
    const path = join(dir, 'pool.json');
    writeFileSync(path, '{broken');
    expect(await writePoolArtifactFile(path, createPoolArtifact(body()))).toBe('written');
    const changed = createPoolArtifact({ ...body(), hosts: ['c.example'] });
    expect(await writePoolArtifactFile(path, changed)).toBe('written');
    expect(JSON.parse(readFileSync(path, 'utf8')).contentHash).toBe(changed.contentHash);
    expect(poolArtifactHash(JSON.parse(readFileSync(path, 'utf8')))).toBe(changed.contentHash);
  });

  it('写失败抛给调用方，不留临时文件', async () => {
    await expect(writePoolArtifactFile(join(dir, 'no-such-dir', 'pool.json'), createPoolArtifact(body()))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
