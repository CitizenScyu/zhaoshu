// engine-fetch.mjs 的引擎源池跨进程文件缓存（xfer41）。
//
// 为什么要跨进程：labeler 每个子命令（search / toc / 每一章 content）都 shell 出一个新的 node 进程，
// 改前每个进程都从 DB 重读一遍源池（engineHosts + 探测快照 + 全部准入源的整份规则），09-21～09-24
// 约 1.1 万次调用、≈1.7 GB，是 Neon 免费档 5 GB/月传输额度的二号大户（dbquota-41-report §2.2）。
// 「一次进程只读一次」对单个子命令没有意义（每个进程本来就只读一次），真正要省的是进程之间的重复。
//
// 形态：池结果（host 门集合 + getEngineSources 的条目）写一份 JSON 到本机临时目录，TTL 内后续进程直接用。
// - TTL 默认 600s（env ENGINE_POOL_CACHE_TTL_MS；0 = 关闭；非法值回落默认；上限 3600s）。池数据一天只变一次
//   （cron 刷新 + 准入批次）；人工禁用源对打标线最多晚 10 分钟生效——该源的失败本就会被 giveup41 连败换源兜住。
// - 文件名带 DATABASE_URL 的 sha256 前缀：换库（Neon ↔ 临时自建库）绝不串池；连接串本身不落盘、不打印。
// - 目录 env ENGINE_POOL_CACHE_DIR，缺省 os.tmpdir()。写入走临时文件 + rename（并发进程不会读到半截文件），
//   文件权限 0600。内容只是公开书源规则与 host 名，不含凭据。
// - 读坏（不存在/损坏/过期/版本不符/时钟回拨）一律当未命中，重读 DB 并覆盖；写失败静默（缓存只是优化，
//   不能让取书失败）。DB 读失败不写缓存，照旧抛给调用方（engine-fetch 按子命令退 2）。
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ENGINE_POOL_CACHE_TTL_MS = 600_000;
const MAX_ENGINE_POOL_CACHE_TTL_MS = 3_600_000;
const CACHE_VERSION = 1;

export function enginePoolCacheTtlMs(env = process.env) {
  const raw = env.ENGINE_POOL_CACHE_TTL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_ENGINE_POOL_CACHE_TTL_MS) : DEFAULT_ENGINE_POOL_CACHE_TTL_MS;
}

/** 缓存文件路径；无连接串 ⇒ null（不缓存）。 */
export function enginePoolCachePath(env = process.env) {
  if (!env.DATABASE_URL) return null;
  const key = createHash('sha256').update(env.DATABASE_URL).digest('hex').slice(0, 16);
  return join(env.ENGINE_POOL_CACHE_DIR?.trim() || tmpdir(), `zhaoshu-engine-pool-${key}.json`);
}

function readFresh(path, ttlMs, now) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const age = now - data.savedAt;
    if (data.version !== CACHE_VERSION || !Number.isFinite(age) || age < 0 || age >= ttlMs) return null;
    if (!Array.isArray(data.hosts) || !Array.isArray(data.sources)) return null;
    return { hosts: data.hosts, sources: data.sources };
  } catch {
    return null;
  }
}

function writeAtomic(path, pool, now) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, savedAt: now, ...pool }), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* 写失败静默：缓存只是优化 */ }
  }
}

/**
 * 取引擎源池 { hosts, sources }：TTL 内命中文件缓存则不碰 DB，否则调 load() 读库并写回。
 * load 必须返回 { hosts: string[], sources: ReadingSource[] }（纯 JSON 数据）。
 */
export async function loadEnginePoolCached(load, { env = process.env, now = Date.now } = {}) {
  const ttlMs = enginePoolCacheTtlMs(env);
  const path = enginePoolCachePath(env);
  if (ttlMs <= 0 || !path) return await load();
  const cached = readFresh(path, ttlMs, now());
  if (cached) return cached;
  const pool = await load();
  writeAtomic(path, { hosts: pool.hosts, sources: pool.sources }, now());
  return pool;
}
