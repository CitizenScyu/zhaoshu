import { alternateSourceHost } from './source-policy';

// 41-M1.3 主机级健康记忆：进程内、按 host 记「连续传输层硬失败」，只用来给源排序（降序，不剔除）。
// 背景（read-smoke-41 §0/§5）：book15 自 09-21 起 Cloudflare 522，对它每调一次 page() 约 12.7s
// （2 次尝试 ×（3s 连接超时 + 0.35s 换 host + 3s））；建目录时 hint + 搜索两次白耗约 25s（软预算的 57%），
// 章节级换源时它又因「builtin 恒在前」恒排第一个候选，先白耗 min(14s, 余量)。
//
// 记录点只有一处：source-fetch.ts 的 fetchSourceText（builtin 与引擎两条腿唯一的 HTTP 出口）。
// - 只有传输层硬失败才计数：连接/请求超时、fetch failed、HTTP 5xx（含 522）。404 等 4xx、策略拒绝、
//   解码失败、预算/节流中止、调用方中止一律不计（既不加一，也不清零）。搜不到书、解析失败发生在 HTTP 成功之后，
//   对 host 而言是成功。
// - 任何一次成功（拿到 2xx 正文）立即清零。
// - 连续硬失败 ≥ HOST_SUSPECT_FAILURES 次且最近一次失败在窗口内 ⇒ suspect。窗口过期后自动恢复原位（半开）：
//   计数保留，恢复后再硬失败一次就重新判 suspect；成功一次才真正清零。
// 进程内记忆：冷启动即丢，各函数实例各记各的。这可以接受，不做 DB 持久化（任务书已定）：代价只是每个新实例
// 最多再为一个死源付一次全价，之后它就排到队尾。
// 已知局限：按「请求 URL 的 host」记、按「源 url 的 host」查。引擎源的 searchUrl 若在另一个 host 上，
// 那个 host 的失败不会让本源降序。

export type HostFailureKind = 'timeout' | 'network' | 'http_5xx';

/** 判 suspect 所需的连续传输层硬失败次数。 */
export const HOST_SUSPECT_FAILURES = 2;
/** suspect 窗口默认值：最近一次硬失败后 10 分钟内仍判 suspect，过期恢复原位。 */
export const SOURCE_HOST_SUSPECT_MS = 10 * 60_000;
const MIN_SUSPECT_MS = 60_000;
const MAX_SUSPECT_MS = 3_600_000;
/** 记忆表上限：满了淘汰最久没记过失败的 host，防止内存无界增长。 */
export const HOST_HEALTH_MAX_ENTRIES = 256;

interface HostHealth {
  failures: number;
  lastFailureAt: number;
}

// Map 的插入序就是淘汰序：每次记失败都先删再插，表头永远是最久没记过失败的 host（LRU）。
// 成功直接删掉条目，所以表里只有「最近失败过、还没成功过」的 host。
const hosts = new Map<string, HostHealth>();

/** suspect 窗口：env `SOURCE_HOST_SUSPECT_MS`，默认 600000，钳在 [60000, 3600000]；空串/非数字/≤0 回退默认。 */
export function sourceHostSuspectMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.SOURCE_HOST_SUSPECT_MS ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(Math.max(parsed, MIN_SUSPECT_MS), MAX_SUSPECT_MS)
    : SOURCE_HOST_SUSPECT_MS;
}

// 同站 apex ↔ www（book15.net ↔ www.book15.net）是一个站：fetch 层在两者间换 host 兜底，deprioritizeSource
// 也把它们当同站。键取两者中字典序小的那个，两边的记录落在同一条上。
function hostKey(host: string): string {
  const normalized = host.toLowerCase();
  const alternate = alternateSourceHost(normalized);
  return alternate && alternate < normalized ? alternate : normalized;
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

function suspect(entry: HostHealth | undefined, now: number): boolean {
  return !!entry && entry.failures >= HOST_SUSPECT_FAILURES && now - entry.lastFailureAt < sourceHostSuspectMs();
}

/** 记一次传输层硬失败。刚跨进 suspect 的那一次打一行 warn（每个 host 每进入一次 suspect 只打一行）。 */
export function recordHostFailure(host: string, kind: HostFailureKind, now = Date.now()): void {
  if (!host) return;
  const key = hostKey(host);
  const previous = hosts.get(key);
  const wasSuspect = suspect(previous, now);
  const entry = { failures: (previous?.failures ?? 0) + 1, lastFailureAt: now };
  hosts.delete(key);
  hosts.set(key, entry);
  if (hosts.size > HOST_HEALTH_MAX_ENTRIES) hosts.delete(hosts.keys().next().value!);
  if (!wasSuspect && suspect(entry, now)) {
    // 只有 host 与计数，不带 URL 路径和查询串。
    console.warn('[source-health] host_suspect', JSON.stringify({
      event: 'host_suspect', host: key, failures: entry.failures, kind, suspectMs: sourceHostSuspectMs(),
    }));
  }
}

/** 记一次成功：清零（删掉条目）。 */
export function recordHostSuccess(host: string): void {
  if (host) hosts.delete(hostKey(host));
}

export function isHostSuspect(host: string, now = Date.now()): boolean {
  return host ? suspect(hosts.get(hostKey(host)), now) : false;
}

/**
 * 把 suspect host 上的源挪到队尾，前后两段都保持原有相对顺序（稳定）；只降序、不剔除——其他源都失败且预算
 * 还够时仍会试到它。没有要挪的就原样返回同一个数组。记忆为空（冷启动或全都健康）时连时钟都不读，顺序与行为
 * 与改动前逐字节相同。
 */
export function orderByHostHealth<T extends { url: string }>(sources: T[], now?: number): T[] {
  if (!hosts.size || sources.length < 2) return sources;
  const at = now ?? Date.now();
  const healthy: T[] = [];
  const demoted: T[] = [];
  for (const source of sources) (isHostSuspect(hostnameOf(source.url), at) ? demoted : healthy).push(source);
  return demoted.length && healthy.length ? [...healthy, ...demoted] : sources;
}
