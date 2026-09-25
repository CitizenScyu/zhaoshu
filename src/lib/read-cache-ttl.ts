// 读库缓存 TTL 旋钮（xfer41）：池合成读缓存（shuyuan.ts）与目录会话读缓存（source-reader.ts）共用。
// 单独成模块：source-reader 的测试整模块 mock 掉 ./shuyuan，旋钮不能跟着消失。
// 默认 300s 的理由见 shuyuan.ts「池合成读缓存」一节；env SHUYUAN_READ_CACHE_TTL_MS，0 = 关闭，非法回落默认，上限 3600s。
export const DEFAULT_SHUYUAN_READ_CACHE_TTL_MS = 300_000;
const MAX_SHUYUAN_READ_CACHE_TTL_MS = 3_600_000;

export function shuyuanReadCacheTtlMs(): number {
  const raw = process.env.SHUYUAN_READ_CACHE_TTL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_SHUYUAN_READ_CACHE_TTL_MS) : DEFAULT_SHUYUAN_READ_CACHE_TTL_MS;
}
