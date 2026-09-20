// T8 接线：发布目标仓定位。T3 WorkerOptions 要 repositoryId/branch（storage_repositories 主键），
// 而运行环境给的是 GITHUB_REPOSITORY=owner/repo。按 T2 registry 的可写判据反查主键。
// 不新造 registry 语义：与 reserveArtifactPath 的 WHERE 判据同一条（enabled ∧ is_private ∧
// ¬read_only ∧ sealed_at IS NULL）。

import type { DownloadSql } from './storage';

export interface RepositoryKey { owner: string; repo: string; branch: string }

export async function resolveRepositoryId(sql: DownloadSql, key: RepositoryKey): Promise<number> {
  const rows = await sql`
    SELECT id FROM storage_repositories
    WHERE lower(owner) = lower(${key.owner}) AND lower(repo) = lower(${key.repo})
      AND branch = ${key.branch}
      AND enabled AND is_private AND NOT read_only AND sealed_at IS NULL
    LIMIT 1` as unknown as { id: number | string }[];
  const id = rows[0] ? Number(rows[0].id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    // 只报键名级信息，不带连接串/凭据。
    throw new Error('no writable storage_repositories row for GITHUB_REPOSITORY/branch');
  }
  return id;
}
