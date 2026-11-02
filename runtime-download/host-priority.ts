// yield1030：选源扫描 host 优先分（source-selector 的 hostPriority 接缝）。开关 DOWNLOAD_SCAN_PRODUCTIVE_FIRST
// 缺省关 ⇒ 返回 undefined，selector 走池序原样（逐字同改前）。
//
// 动机（2026-10-30 生产只读）：下载池 622 可扫源，扫描上限 160 + 300s 预算两者同时卡（24h 选源 774 次中 691 次
// scanned=160 零候选）；池序按 search_checked_at DESC 逐小时轮转，与出书能力无关——30 天实收 135 本的
// quanwenyuedu 当时排在第 167 位，itxtbook 395、sto66 468，扫描窗口够不到。重排只把同样的额度先给近 30 天
// 真出过书的 host，不增出网。
//
// 读失败回空表（= 池序），不缓存失败；成功结果按 TTL 记忆，20 实例 × 每 10 分钟一次聚合查询。
//
// zeroyield1102：DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD（缺省关）把零产出 host（近 30 天候选失败 ≥ 5 本书、同站无 done，
// 见 zeroYieldHosts）记为 -1 分：selector 稳定排序后落到池尾（在默认 0 分之后），轮转窗口照旧覆盖，只降序不剔除。
// 动机（2026-11-01 phoenix 只读，近 3 天）：zzxsa 131 次、17k 系 103 次、m.qidian 40、hongxiu 20 等下载恒败，
// 选源命中后每本书各白耗一次下载尝试（temporary 记忆 48h 过期后再耗一次）。

import { productiveHostScores, zeroYieldHosts, type CandidateSql } from '../src/lib/download-source-candidates';

export const HOST_PRIORITY_TTL_MS = 10 * 60 * 1000;

export function productiveFirstEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_PRODUCTIVE_FIRST?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** zeroyield1102：零产出 host 降到池尾。缺省关；1/true/on 开。 */
export function demoteZeroYieldEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_DEMOTE_ZERO_YIELD?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** rotate1030：DOWNLOAD_SCAN_ROTATE 开 ⇒ 重试按 attempt_count 轮转扫描窗口（见 source-selector rotate）。缺省关。 */
export function scanRotateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_ROTATE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** toctgate1030：DOWNLOAD_SCAN_SKIP_STRICT_TOC 开 ⇒ 选源跳过 strict 目录必拒的源（见 source-selector skipStrictToc）。缺省关。 */
export function skipStrictTocEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_SKIP_STRICT_TOC?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function createHostPriority(
  sql: CandidateSql,
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): ((signal: AbortSignal) => Promise<ReadonlyMap<string, number>>) | undefined {
  const productive = productiveFirstEnabled(env);
  const demote = demoteZeroYieldEnabled(env);
  if (!productive && !demote) return undefined;
  let memo: { at: number; value: ReadonlyMap<string, number> } | null = null;
  return async () => {
    if (memo && now() - memo.at < HOST_PRIORITY_TTL_MS) return memo.value;
    try {
      const [scores, zero] = await Promise.all([
        productive ? productiveHostScores(sql) : new Map<string, number>(),
        demote ? zeroYieldHosts(sql) : new Map<string, number>(),
      ]);
      const value = new Map(scores);
      for (const host of zero.keys()) if (!value.has(host)) value.set(host, -1);
      memo = { at: now(), value };
      return value;
    } catch {
      return new Map();
    }
  };
}
