// yield1030：选源扫描 host 优先分（source-selector 的 hostPriority 接缝）。开关 DOWNLOAD_SCAN_PRODUCTIVE_FIRST
// 缺省关 ⇒ 返回 undefined，selector 走池序原样（逐字同改前）。
//
// 动机（2026-10-30 生产只读）：下载池 622 可扫源，扫描上限 160 + 300s 预算两者同时卡（24h 选源 774 次中 691 次
// scanned=160 零候选）；池序按 search_checked_at DESC 逐小时轮转，与出书能力无关——30 天实收 135 本的
// quanwenyuedu 当时排在第 167 位，itxtbook 395、sto66 468，扫描窗口够不到。重排只把同样的额度先给近 30 天
// 真出过书的 host，不增出网。
//
// 读失败回空表（= 池序），不缓存失败；成功结果按 TTL 记忆，20 实例 × 每 10 分钟一次聚合查询。

import { productiveHostScores, type CandidateSql } from '../src/lib/download-source-candidates';

export const HOST_PRIORITY_TTL_MS = 10 * 60 * 1000;

export function productiveFirstEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_PRODUCTIVE_FIRST?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** rotate1030：DOWNLOAD_SCAN_ROTATE 开 ⇒ 重试按 attempt_count 轮转扫描窗口（见 source-selector rotate）。缺省关。 */
export function scanRotateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOWNLOAD_SCAN_ROTATE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function createHostPriority(
  sql: CandidateSql,
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): ((signal: AbortSignal) => Promise<ReadonlyMap<string, number>>) | undefined {
  if (!productiveFirstEnabled(env)) return undefined;
  let memo: { at: number; value: ReadonlyMap<string, number> } | null = null;
  return async () => {
    if (memo && now() - memo.at < HOST_PRIORITY_TTL_MS) return memo.value;
    try {
      const value = await productiveHostScores(sql);
      memo = { at: now(), value };
      return value;
    } catch {
      return new Map();
    }
  };
}
