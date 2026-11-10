// neverhit1110：选源跳过「从没搜到过书」的 host DOWNLOAD_SCAN_SKIP_NEVER_HIT（=1 开；缺省关，逐字同改前）。
//
// 动机（2026-11-10 phoenix 只读）：零产出出池（zeroskip1105）只认候选表里有失败行的 host；搜索从来搜不到书的
// host 根本进不了候选表，永远漏判。当时 scan-miss 记忆 24h 内 26.4 万次「确认无书」里，113 个近 30 天候选表
// 0 行的 host 占 10.1 万（38%），当天给这些站发了 13.3 万次请求，一本书都没选到。
//
// 判据：近 30 天候选表 0 行、无 done 任务（recentCandidateHosts），且 24h 记忆里 ≥ 门槛（DOWNLOAD_SCAN_NEVER_HIT_MIN，
// 缺省 200）本不同的书在该 host 确认无书 ⇒ 出池不扫。只认确认无书（异常/门拒绝不进记忆），新加的源至少先实探
// 门槛本书。自然回池：被跳过的 host 不再新增记忆，24h 内计数跌破门槛后重新被扫，稳态每天约「门槛」本书的
// 探测量；真开始收录了就会命中进候选表，下一次刷新起不再跳过。
// 读失败（库/记忆目录）一律回空集（不跳过，优化不是门）；候选表 30 天全空视为异常，同样不跳过。每实例 10 分钟
// 刷新一次（记忆目录约 2k 个小文件，读一遍百毫秒级）。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recentCandidateHosts, type CandidateSql } from '../src/lib/download-source-candidates';
import { SCAN_MISS_TTL_MS, scanMissKey } from './scan-miss-memo';

export const NEVER_HIT_TTL_MS = 10 * 60_000;
export const NEVER_HIT_MIN_BOOKS = 200;
/** 门槛下限：太低会让冷门站（收录窄但真有书）还没试几本就出池。 */
export const NEVER_HIT_MIN_FLOOR = 50;

export function skipNeverHitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_SKIP_NEVER_HIT?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** DOWNLOAD_SCAN_NEVER_HIT_MIN：24h 内确认无书的不同书数门槛。缺省/非法 = 200，低于 50 按 50。 */
export function neverHitMinBooks(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DOWNLOAD_SCAN_NEVER_HIT_MIN?.trim() ?? '';
  return /^\d+$/.test(raw) ? Math.max(NEVER_HIT_MIN_FLOOR, Number(raw)) : NEVER_HIT_MIN_BOOKS;
}

type PoolLike = { url: string };

const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

/** 24h 记忆里每个 host 确认无书的不同书数。键按当前池 URL 反查 host（同书同 host 多个 URL 只算一本；池外旧键不计）。 */
export async function missBooksByHost(dir: string, pool: readonly PoolLike[], now: number): Promise<Map<string, number>> {
  const hostOfKey = new Map<string, string>();
  for (const source of pool) {
    const host = hostOf(source.url);
    if (host) hostOfKey.set(scanMissKey(source.url), host);
  }
  const counts = new Map<string, number>();
  let names: string[];
  try { names = await readdir(dir); } catch { return counts; }
  const cutoff = now - SCAN_MISS_TTL_MS;
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // 写入中的 .tmp 不读
    let misses: unknown;
    try { misses = (JSON.parse(await readFile(join(dir, name), 'utf8')) as { misses?: unknown })?.misses; } catch { continue; }
    if (!misses || typeof misses !== 'object') continue;
    const hosts = new Set<string>();
    for (const [key, at] of Object.entries(misses)) {
      if (typeof at !== 'number' || at <= cutoff || at > now) continue;
      const host = hostOfKey.get(key);
      if (host) hosts.add(host);
    }
    for (const host of hosts) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
}

export function createNeverHit(
  sql: CandidateSql,
  dir: string,
  minBooks: number = NEVER_HIT_MIN_BOOKS,
  now: () => number = Date.now,
): (pool: readonly PoolLike[], signal: AbortSignal) => Promise<ReadonlySet<string>> {
  let memo: { at: number; value: ReadonlySet<string> } | null = null;
  return async pool => {
    if (memo && now() - memo.at < NEVER_HIT_TTL_MS) return memo.value;
    try {
      const [hit, misses] = await Promise.all([recentCandidateHosts(sql), missBooksByHost(dir, pool, now())]);
      if (!hit.size) return new Set();
      const value = new Set<string>();
      for (const [host, books] of misses) if (books >= minBooks && !hit.has(host)) value.add(host);
      memo = { at: now(), value };
      return value;
    } catch {
      return new Set();
    }
  };
}
