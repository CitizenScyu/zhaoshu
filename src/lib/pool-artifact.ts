// 源池每日产物（41-poolimpl，设计见 poolart-41-report §2）：把池合成的四份 DB 输入行（engineHosts / 探测快照投影 /
// builtin 行 / 引擎行）快照成一份 JSON，消费方「产物优先、失败回退库」，让阅读/换源/打标的放量不再与库流量挂钩。
//
// 产物只存**输入行**，不存合成后的池：入池判定、排序、同站去重、host 门、http→https 升级全部仍由 shuyuan.ts 现行代码
// 在 JS 里重算，开关开/关两条路径的池结论逐条相同。数据库仍是唯一事实源，产物是写库成功后重生成的派生只读副本。
//
// 开关 SHUYUAN_POOL_ARTIFACT 默认关：关时本模块不读路径/URL、不碰文件与网络，shuyuan.ts 逐字回到现行为。
// 读坏（缺失/过期/JSON 损坏/版本不符/hash 不符/超大/非 https）一律回退库读并 console.warn，不引入新的失败模式。
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isRecord } from '@/lib/sanitize';
import { shuyuanReadCacheTtlMs } from '@/lib/read-cache-ttl';

export const POOL_ARTIFACT_SCHEMA_VERSION = 1;
export const DEFAULT_POOL_ARTIFACT_MAX_AGE_HOURS = 36;
const MAX_POOL_ARTIFACT_MAX_AGE_HOURS = 24 * 14;
/** 产物体积硬上限：现网预计 200–400 KB，16 MB 足够余量；超限视为损坏，防止误配 URL 把函数内存打爆。 */
export const MAX_POOL_ARTIFACT_BYTES = 16 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 5_000;

/** 与 shuyuan.ts 池合成读到的 DB 行同形（列名不改，消费侧直接喂现有代码）。 */
export interface PoolArtifactSourceRow {
  source_url: string;
  name: string;
  source: Record<string, unknown>;
  disabled_at: string | null;
  last_error: string;
}
export interface PoolArtifactEngineRow extends PoolArtifactSourceRow {
  tier: string;
  search_checked_at: string | null;
}

export interface PoolArtifactBody {
  schemaVersion: number;
  /** shuyuan_meta.refreshed_at（上游合集最近一次整表刷新）；null = 从未刷新。 */
  refreshedAt: string | null;
  /** source_admission ok 态 host（compile_ok ∧ search_ok IS TRUE），即运行时 host 门的引擎部分。 */
  hosts: string[];
  builtin: PoolArtifactSourceRow[];
  engine: PoolArtifactEngineRow[];
  /** shuyuan_meta.collections[0].probeSnapshot 里 builtin ∪ engine 行 URL 对应的条目（原序、含重复）。 */
  probe: { version: unknown; entries: unknown[] };
}

export interface PoolArtifact extends PoolArtifactBody {
  /** 生成时刻（ISO）；不进 contentHash——同内容重生成 hash 不变。 */
  generatedAt: string;
  /** sha256(稳定序列化(body))，hex。 */
  contentHash: string;
}

/** 开关：只有显式 1/true/on 才开（与 READING_ENGINE_SOURCES 同口径）。 */
export function poolArtifactEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SHUYUAN_POOL_ARTIFACT?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** 过期阈值（毫秒）：env SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS（可带小数），非法/≤0/缺失回落 36h，上限 14 天。 */
export function poolArtifactMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SHUYUAN_POOL_ARTIFACT_MAX_AGE_HOURS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  const hours = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_POOL_ARTIFACT_MAX_AGE_HOURS) : DEFAULT_POOL_ARTIFACT_MAX_AGE_HOURS;
  return Math.round(hours * 3_600_000);
}

/** 键排序的稳定序列化：jsonb 读回的对象键序不稳定，hash 不能随之漂移（数组顺序照旧有意义）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item);
}

export function poolArtifactHash(body: PoolArtifactBody): string {
  const { schemaVersion, refreshedAt, hosts, builtin, engine, probe } = body;
  return createHash('sha256')
    .update(stableStringify({ schemaVersion, refreshedAt, hosts, builtin, engine, probe }))
    .digest('hex');
}

export function createPoolArtifact(body: Omit<PoolArtifactBody, 'schemaVersion'>, now = Date.now()): PoolArtifact {
  const full: PoolArtifactBody = { schemaVersion: POOL_ARTIFACT_SCHEMA_VERSION, ...body };
  return { ...full, generatedAt: new Date(now).toISOString(), contentHash: poolArtifactHash(full) };
}

export type PoolArtifactRejection =
  | 'invalid_json' | 'schema' | 'hash_mismatch' | 'stale' | 'future' | 'too_large';

export type PoolArtifactParse = { ok: true; artifact: PoolArtifact } | { ok: false; reason: PoolArtifactRejection };

function isSourceRow(row: unknown): row is PoolArtifactSourceRow {
  return isRecord(row) && typeof row.source_url === 'string' && typeof row.name === 'string'
    && isRecord(row.source) && (row.disabled_at === null || typeof row.disabled_at === 'string')
    && typeof row.last_error === 'string';
}

function isEngineRow(row: unknown): row is PoolArtifactEngineRow {
  if (!isSourceRow(row)) return false;
  const { tier, search_checked_at: checkedAt } = row as Partial<PoolArtifactEngineRow>;
  return typeof tier === 'string' && (checkedAt === null || typeof checkedAt === 'string');
}

/** 形状与版本校验（不含新鲜度）。 */
function shapeOk(value: unknown): value is PoolArtifact {
  if (!isRecord(value) || value.schemaVersion !== POOL_ARTIFACT_SCHEMA_VERSION) return false;
  if (typeof value.generatedAt !== 'string' || typeof value.contentHash !== 'string') return false;
  if (value.refreshedAt !== null && typeof value.refreshedAt !== 'string') return false;
  if (!Array.isArray(value.hosts) || !value.hosts.every((host) => typeof host === 'string')) return false;
  if (!Array.isArray(value.builtin) || !value.builtin.every(isSourceRow)) return false;
  if (!Array.isArray(value.engine) || !value.engine.every(isEngineRow)) return false;
  return isRecord(value.probe) && Array.isArray(value.probe.entries);
}

/**
 * 解析并校验产物：JSON → 形状/版本 → contentHash → 新鲜度（generatedAt 距 now 超过 maxAgeMs 即过期；
 * 超前 5 分钟以上视为时钟异常，同样拒收）。任何一步不过都返回原因，由调用方回退库读。
 */
export function parsePoolArtifact(text: string, now: number, maxAgeMs: number): PoolArtifactParse {
  if (text.length > MAX_POOL_ARTIFACT_BYTES) return { ok: false, reason: 'too_large' };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: 'invalid_json' }; }
  if (!shapeOk(value)) return { ok: false, reason: 'schema' };
  if (poolArtifactHash(value) !== value.contentHash) return { ok: false, reason: 'hash_mismatch' };
  return freshness(value, now, maxAgeMs);
}

function freshness(artifact: PoolArtifact, now: number, maxAgeMs: number): PoolArtifactParse {
  const generated = Date.parse(artifact.generatedAt);
  if (!Number.isFinite(generated)) return { ok: false, reason: 'schema' };
  if (generated - now > 300_000) return { ok: false, reason: 'future' };
  if (now - generated > maxAgeMs) return { ok: false, reason: 'stale' };
  return { ok: true, artifact };
}

// —— 消费：产物来源 = 本地文件（phoenix：labeler / download）或 https URL（Vercel）——

export type PoolArtifactLoadFailure =
  | PoolArtifactRejection | 'not_configured' | 'missing' | 'bad_url' | 'fetch_failed' | 'http_status';

type LoadOutcome = { ok: true; artifact: PoolArtifact } | { ok: false; reason: PoolArtifactLoadFailure };

type Memo = { expiresAt: number; value: Promise<PoolArtifact | null> };
let memo: Memo | null = null;
/** URL 来源上次成功的响应：下次带 If-None-Match（nginx 静态文件自带 ETag），未变时 304 只回几百字节。 */
let lastUrlHit: { url: string; etag: string; artifact: PoolArtifact } | null = null;

/** 本实例最近一次写库的时刻：generatedAt 早于它的产物本实例不采信（读己之写，见 noteLocalPoolWrite）。 */
let localWriteAt = 0;

/** 丢弃进程内产物记忆（本实例写路径发布新产物后、测试之间）。ETag 记忆一并清掉。 */
export function resetPoolArtifactMemo(): void {
  memo = null;
  lastUrlHit = null;
}

/**
 * 本实例写过库（refresh 提交、准入写回、禁用/启用；shuyuan.ts invalidateShuyuanReadCache 调用）：此后只采信
 * generatedAt 不早于此刻的产物，更早的一律回退库读——改前本实例写后立即可见，产物化不能把它变成「晚一个生成周期」。
 * 其他实例的可见延迟与改前同量级（改前晚一个读缓存 TTL，改后晚一个产物生成周期，见 poolimpl-41-report §4）。
 */
export function noteLocalPoolWrite(now = Date.now()): void {
  localWriteAt = Math.max(localWriteAt, now);
  memo = null;
}

/**
 * 当前可用的产物；开关关 ⇒ null（不读任何 env 路径、不碰文件与网络）。不可用 ⇒ null 并 console.warn 原因，
 * 由调用方回退库读。结果按池合成读缓存同一 TTL 记忆（SHUYUAN_READ_CACHE_TTL_MS；0 = 每次重读），同一窗口内
 * 四个池合成键共用一次加载；失败同样记忆一个 TTL，库读回退路径另有自己的 TTL 缓存，不会放大成每请求读文件/发请求。
 * 加载不绑调用方信号（与 cachedRead 同理：首个调用方断开不能连坐同批等待者），URL 取数自带 5s 超时。
 */
export function currentPoolArtifact(): Promise<PoolArtifact | null> {
  if (!poolArtifactEnabled()) return Promise.resolve(null);
  const ttl = shuyuanReadCacheTtlMs();
  const now = Date.now();
  if (ttl <= 0) return loadPoolArtifact().then(notOlderThanLocalWrite);
  if (!memo || memo.expiresAt <= now) memo = { expiresAt: now + ttl, value: loadPoolArtifact() };
  return memo.value.then(notOlderThanLocalWrite);
}

function notOlderThanLocalWrite(artifact: PoolArtifact | null): PoolArtifact | null {
  return artifact && Date.parse(artifact.generatedAt) >= localWriteAt ? artifact : null;
}

async function loadPoolArtifact(): Promise<PoolArtifact | null> {
  const path = process.env.SHUYUAN_POOL_ARTIFACT_PATH?.trim();
  const url = process.env.SHUYUAN_POOL_ARTIFACT_URL?.trim();
  const now = Date.now();
  const maxAgeMs = poolArtifactMaxAgeMs();
  let outcome: LoadOutcome;
  try {
    outcome = path ? await readArtifactFile(path, now, maxAgeMs)
      : url ? await fetchArtifactUrl(url, now, maxAgeMs)
        : { ok: false, reason: 'not_configured' };
  } catch {
    outcome = { ok: false, reason: path ? 'missing' : 'fetch_failed' };
  }
  if (outcome.ok) return outcome.artifact;
  // 只记原因枚举与来源类别：路径/URL 不是秘密，但日志里不需要它们。
  console.warn('shuyuan pool artifact unavailable, falling back to db', {
    reason: outcome.reason, from: path ? 'file' : url ? 'url' : 'none',
  });
  return null;
}

async function readArtifactFile(path: string, now: number, maxAgeMs: number): Promise<LoadOutcome> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  return parsePoolArtifact(text, now, maxAgeMs);
}

async function fetchArtifactUrl(url: string, now: number, maxAgeMs: number): Promise<LoadOutcome> {
  let target: URL;
  try { target = new URL(url); } catch { return { ok: false, reason: 'bad_url' }; }
  if (target.protocol !== 'https:') return { ok: false, reason: 'bad_url' };
  const previous = lastUrlHit?.url === url ? lastUrlHit : null;
  let response: Response;
  try {
    response = await fetch(target, {
      redirect: 'error',
      headers: previous ? { 'If-None-Match': previous.etag } : {},
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
  if (response.status === 304 && previous) {
    void response.body?.cancel().catch(() => {});
    return freshness(previous.artifact, now, maxAgeMs);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return { ok: false, reason: 'http_status' };
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_POOL_ARTIFACT_BYTES) {
    void response.body?.cancel().catch(() => {});
    return { ok: false, reason: 'too_large' };
  }
  const text = await readCapped(response);
  if (text === null) return { ok: false, reason: 'too_large' };
  const result = parsePoolArtifact(text, now, maxAgeMs);
  const etag = response.headers.get('etag');
  lastUrlHit = result.ok && etag ? { url, etag, artifact: result.artifact } : null;
  return result;
}

/** 边读边计字节，超 MAX_POOL_ARTIFACT_BYTES 即中止（content-length 可缺失/说谎）。 */
async function readCapped(response: Response): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_POOL_ARTIFACT_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// —— 生成侧写文件（phoenix cron 脚本与本机写路径钩子共用）——

/** 心跳：内容未变时，文件里的 generatedAt 超过此龄才重写（让 36h 过期阈值能识别生成器停摆，又不让 ETag 每轮都变）。 */
export const DEFAULT_POOL_ARTIFACT_HEARTBEAT_MS = 6 * 3_600_000;

/**
 * 原子写产物文件（临时文件 + rename，并发读者不会读到半截）：已有文件 contentHash 相同且 generatedAt 未超心跳 ⇒ 不写
 * （'unchanged'）。权限 0644：nginx 静态分发需要可读；内容只是公开书源规则、准入结论与 host，不含凭据。
 * 写失败抛给调用方（生成脚本退非零；写路径钩子吞错告警）。
 */
export async function writePoolArtifactFile(
  path: string, artifact: PoolArtifact, { heartbeatMs = DEFAULT_POOL_ARTIFACT_HEARTBEAT_MS, now = Date.now() } = {},
): Promise<'written' | 'unchanged'> {
  try {
    const existing = parsePoolArtifact(await readFile(path, 'utf8'), now, heartbeatMs);
    if (existing.ok && existing.artifact.contentHash === artifact.contentHash) return 'unchanged';
  } catch { /* 不存在/读不了 ⇒ 照写 */ }
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(artifact), { mode: 0o644 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return 'written';
}
