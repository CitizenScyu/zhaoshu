// 记账连续性判据（唯一口径）：运行期认证闸门 assertAuthSchema 与 db:check 的 evaluateSchema
// 共用本函数，避免「db:check 报 rc=0 却在运行期 503」的口径漂移（review-42 抓过的同型问题）。
//
// 返回 1..requiredVersion 中不在 present 里的版本（升序）。空数组 = 所需版本全部在册 = 通过。
// 只看「所需集合是否齐全」，不管 present 里有没有更高的版本——额外的高版本（灰度/回滚窗口里
// 库新代码旧）不在必需集里，不影响判定；前向保护另由迁移器在库版本超上限时 RAISE EXCEPTION 负责。
export function missingLedgerVersions(
  present: Iterable<number | null | undefined>,
  requiredVersion: number,
): number[] {
  const have = new Set(present);
  const missing: number[] = [];
  for (let version = 1; version <= requiredVersion; version += 1) if (!have.has(version)) missing.push(version);
  return missing;
}
