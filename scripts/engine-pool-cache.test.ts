// xfer41：engine-fetch 源池跨进程文件缓存（engine-pool-cache.mjs）+ CLI 端到端。
// 反例：labeler 每个子命令一个进程，改前每个进程都读一遍 DB 源池；改后 TTL 内只有第一个进程读库。
// CLI 端到端用不可达的假连接串：改前 toc/search 必然「引擎源池不可用」退 2（errorKind=pool），
// 改后有新鲜缓存时根本不碰 DB，按缓存池正常得出结论（no_source / miss，退 1）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENGINE_POOL_CACHE_TTL_MS, enginePoolCachePath, enginePoolCacheTtlMs, loadEnginePoolCached,
} from './engine-pool-cache.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const hook = pathToFileURL(resolve(scriptsDir, 'ts-esm-loader.mjs')).href;
const cli = resolve(scriptsDir, 'engine-fetch.mjs');
// 假连接串：端口 1 不可达；只用于派生缓存文件名与「改前必失败」的对照，绝不是真凭据。
const FAKE_DB = 'postgresql://fake:fake@127.0.0.1:1/fake';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xfer41-pool-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = (over: Record<string, string> = {}) => ({ DATABASE_URL: FAKE_DB, ENGINE_POOL_CACHE_DIR: dir, ...over });
const pool = { hosts: ['a.example'], sources: [{ url: 'https://a.example/', name: 'a', searchUrl: '', rules: {}, tier: 'M1' }] };

describe('engine-pool-cache：跨进程只读一次源池', () => {
  it('TTL env：缺失/非法回落 600s；0 关闭；超上限夹到 3600s', () => {
    expect(enginePoolCacheTtlMs({})).toBe(DEFAULT_ENGINE_POOL_CACHE_TTL_MS);
    expect(DEFAULT_ENGINE_POOL_CACHE_TTL_MS).toBe(600_000);
    for (const bad of ['x', '-5', '2.5']) expect(enginePoolCacheTtlMs({ ENGINE_POOL_CACHE_TTL_MS: bad })).toBe(600_000);
    expect(enginePoolCacheTtlMs({ ENGINE_POOL_CACHE_TTL_MS: '0' })).toBe(0);
    expect(enginePoolCacheTtlMs({ ENGINE_POOL_CACHE_TTL_MS: '99999999' })).toBe(3_600_000);
  });

  it('反例：两次调用（模拟两个子命令进程）只读一次 DB，第二次拿到同一份池', async () => {
    const load = vi.fn(async () => pool);
    expect(await loadEnginePoolCached(load, { env: env() })).toEqual(pool);
    expect(await loadEnginePoolCached(load, { env: env() })).toEqual(pool);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('TTL 到期 / 时钟回拨 ⇒ 重读', async () => {
    const load = vi.fn(async () => pool);
    let t = 1_000_000;
    const now = () => t;
    await loadEnginePoolCached(load, { env: env(), now });
    t += DEFAULT_ENGINE_POOL_CACHE_TTL_MS - 1;
    await loadEnginePoolCached(load, { env: env(), now });
    expect(load).toHaveBeenCalledTimes(1);
    t += 1;
    await loadEnginePoolCached(load, { env: env(), now });
    expect(load).toHaveBeenCalledTimes(2);
    t -= 10_000; // 回拨：savedAt 在未来，不信任
    await loadEnginePoolCached(load, { env: env(), now });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('换库（连接串不同）不串池；无连接串不缓存', async () => {
    const load = vi.fn(async () => pool);
    await loadEnginePoolCached(load, { env: env() });
    await loadEnginePoolCached(load, { env: env({ DATABASE_URL: 'postgresql://other:x@127.0.0.1:1/other' }) });
    expect(load).toHaveBeenCalledTimes(2);
    expect(enginePoolCachePath({})).toBeNull();
    const path = enginePoolCachePath(env())!;
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('fake'); // 文件名只带哈希，不带连接串任何片段
    expect(readFileSync(path, 'utf8')).not.toContain(FAKE_DB);
  });

  it('TTL=0 完全旁路（不写文件）；load 失败不写缓存且照旧抛出', async () => {
    const load = vi.fn(async () => pool);
    await loadEnginePoolCached(load, { env: env({ ENGINE_POOL_CACHE_TTL_MS: '0' }) });
    await loadEnginePoolCached(load, { env: env({ ENGINE_POOL_CACHE_TTL_MS: '0' }) });
    expect(load).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir)).toEqual([]);
    await expect(loadEnginePoolCached(async () => { throw new Error('db down'); }, { env: env() })).rejects.toThrow('db down');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('损坏 / 版本不符的缓存文件当未命中并被覆盖；不留临时文件', async () => {
    const path = enginePoolCachePath(env())!;
    const load = vi.fn(async () => pool);
    for (const bad of ['{not json', JSON.stringify({ version: 99, savedAt: Date.now(), hosts: [], sources: [] }),
      JSON.stringify({ version: 1, savedAt: Date.now(), hosts: 'x', sources: [] })]) {
      writeFileSync(path, bad);
      expect(await loadEnginePoolCached(load, { env: env() })).toEqual(pool);
    }
    expect(load).toHaveBeenCalledTimes(3);
    expect(readdirSync(dir)).toEqual([path.slice(dir.length + 1)]);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

function runCli(args: string[], over: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', hook, cli, ...args, '--json'], {
    cwd: repoRoot, env: { ...process.env, ...env(over) }, encoding: 'utf8', timeout: 60_000,
  });
  const lines = r.stderr.split('\n').filter((line) => line.trim().startsWith('{'));
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr, kind: lines.length ? JSON.parse(lines.at(-1)!).errorKind : null };
}

function seed() {
  writeFileSync(enginePoolCachePath(env())!, JSON.stringify({ version: 1, savedAt: Date.now(), ...pool }));
}

describe('engine-fetch CLI 端到端：新鲜缓存 ⇒ 子命令不碰 DB', () => {
  it('对照：无缓存时假库不可达 ⇒ toc 退 2（errorKind=pool），也不写缓存', () => {
    const r = runCli(['toc', '--url', 'https://zzz.example/book/1']);
    expect(r.status).toBe(2);
    expect(r.kind).toBe('pool');
    expect(existsSync(enginePoolCachePath(env())!)).toBe(false);
    expect(r.stderr).not.toContain('fake:fake');
  }, 60_000);

  it('toc / content：命中缓存，按缓存池反查 host ⇒ no_source（退 1），不是 pool', () => {
    seed();
    for (const sub of ['toc', 'content']) {
      const r = runCli([sub, '--url', 'https://zzz.example/book/1']);
      expect(r.status).toBe(1);
      expect(r.kind).toBe('no_source');
    }
  }, 60_000);

  it('search --no-builtin --skip-host：命中缓存（池里唯一源被跳过）⇒ 无候选 miss（退 1），零网络零 DB', () => {
    seed();
    const r = runCli(['search', '--title', '不存在的书', '--no-builtin', '--skip-host', 'a.example']);
    expect(r.status).toBe(1);
    expect(r.kind).toBe('miss');
  }, 60_000);

  it('ENGINE_POOL_CACHE_TTL_MS=0 ⇒ 忽略缓存，照旧读 DB（假库 ⇒ pool 退 2）', () => {
    seed();
    const r = runCli(['toc', '--url', 'https://zzz.example/book/1'], { ENGINE_POOL_CACHE_TTL_MS: '0' });
    expect(r.status).toBe(2);
    expect(r.kind).toBe('pool');
  }, 60_000);
});
