// capacity944 静态首片：独立容量账 + 预留账本的 DDL。
//
// 本文件**只导出**（不顶层运行、不调用生产建表、不分配迁移编号）。
//   - 权威逻辑账 repository_capacity_ledger 与旧观测列（storage_repositories.registered_bytes/
//     reserved_bytes/github_size_kib）隔离：默认 state='uninitialized'，未 ready 不放行任何预留。
//   - 预留账本 artifact_capacity_reservations 以不可变绑定（request_key/identity/blobSha40/目标元组/
//     path/logicalBytes）+ 当前 owner/generation/task_id 为幂等与 fencing 依据。
// 设计依据：reporeserve942-fix-original-report.md §6.4（冻结 SHA
// 383d980b1215f58c357b243b7a130c6ed38b639c7824df4daddc3dd4f3ac4b54），942/943 已收口。
//
// 迁移编号：本片不定，未来迁移任务分配；不得假定 0006 可用。此处不加 artifact_schema_migrations 行。
//
// 容量口径（repothresh44，2026-10-19 用户裁定「仓少一点、平衡一点」）：切仓判定用**压缩**口径
//   github_size_bytes（GitHub `GET /repos/{owner}/{repo}` 的 size×1024，由 sync-ledger-capacity
//   每小时回写）对 target_compressed_bytes（默认 1GiB=1073741824，贴合 GitHub 官方「仓 <1GB」
//   建议线，对 5GB 硬限留约 5 倍余量）。
//   target_bytes / registered_bytes / reserved_bytes 是旧**逻辑**字节口径，保留作观测与预留记账，
//   不再参与切仓判定（TXT 压缩≈逻辑 40%，按逻辑字节切仓比真实限制早约 2.6 倍触发）。
//   已建表的库靠 migrations/0008_capacity_compressed_threshold.sql 补这两列（CREATE TABLE
//   IF NOT EXISTS 不给既有表加列）；两处列定义必须同构。

import type { neon } from '@neondatabase/serverless';

export type CapacitySchemaSql = ReturnType<typeof neon>;

/** 初始化容量 schema 的事务级 advisory 锁（与 artifact schema 的 72402102 区分）。 */
export const ARTIFACT_CAPACITY_SCHEMA_LOCK_KEY = 72402103;

/** 幂等 DDL 语句（纯文本，供审阅与测试复用；按序执行）。 */
export const ARTIFACT_CAPACITY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repository_capacity_ledger (
     repository_id         integer PRIMARY KEY REFERENCES storage_repositories(id),
     state                 text NOT NULL DEFAULT 'uninitialized'
                             CHECK (state IN ('uninitialized','ready')),
     target_bytes          bigint NOT NULL CHECK (target_bytes > 0),
     registered_bytes      bigint NOT NULL DEFAULT 0 CHECK (registered_bytes >= 0),
     reserved_bytes        bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
     github_size_bytes     bigint NOT NULL DEFAULT 0 CHECK (github_size_bytes >= 0),
     target_compressed_bytes bigint NOT NULL DEFAULT 1073741824
                             CHECK (target_compressed_bytes > 0),
     baseline_epoch        text NOT NULL CHECK (length(baseline_epoch) > 0),
     admission_status      text NOT NULL DEFAULT 'unknown'
                             CHECK (admission_status IN ('granted','denied','unknown')),
     admission_version     text,
     admission_valid_until timestamptz,
     admission_target      jsonb,
     updated_at            timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS artifact_capacity_reservations (
     reservation_id  bigserial PRIMARY KEY,
     request_key     text NOT NULL UNIQUE CHECK (length(request_key) > 0),
     labeled_book_id integer NOT NULL REFERENCES labeled_books(id),
     identity_key    text NOT NULL CHECK (length(identity_key) > 0),
     blob_sha        text NOT NULL CHECK (blob_sha ~ '^[a-f0-9]{40}$'),
     repository_id   integer NOT NULL REFERENCES storage_repositories(id),
     branch          text NOT NULL CHECK (length(branch) > 0),
     canonical_path  text NOT NULL CHECK (length(canonical_path) > 0),
     logical_bytes   bigint NOT NULL CHECK (logical_bytes > 0),
     state           text NOT NULL DEFAULT 'reserved'
                       CHECK (state IN ('reserved','uncertain','committed','released')),
     owner           text NOT NULL CHECK (length(owner) > 0),
     generation      bigint NOT NULL,
     task_id         bigint NOT NULL,
     artifact_id     bigint REFERENCES book_artifacts(id),
     reserved_at     timestamptz NOT NULL DEFAULT now(),
     begun_at        timestamptz,
     resolved_at     timestamptz
   )`,
  // 同身份/同路径至多一个活动预留（reserved/uncertain）；terminal 行不占排他。
  `CREATE UNIQUE INDEX IF NOT EXISTS artifact_capacity_identity_active_idx
     ON artifact_capacity_reservations (identity_key)
     WHERE state IN ('reserved','uncertain')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS artifact_capacity_path_active_idx
     ON artifact_capacity_reservations (repository_id, branch, canonical_path)
     WHERE state IN ('reserved','uncertain')`,
  `CREATE INDEX IF NOT EXISTS artifact_capacity_owner_idx
     ON artifact_capacity_reservations (task_id, owner, generation)`,
];

/** 把纯文本包成 neon 标签可接受的 TemplateStringsArray（零插值、纯 DDL 文本）。 */
function asTemplateLiteral(statement: string): TemplateStringsArray {
  const parts = [statement] as unknown as string[] & { raw: string[] };
  parts.raw = [statement];
  return parts as unknown as TemplateStringsArray;
}

/**
 * 应用容量 schema（幂等）。**显式调用**：不在模块顶层运行，不被读者请求触发。
 * 只建表/索引，不插入迁移版本行（编号由未来迁移任务分配）。
 */
export async function initializeArtifactCapacitySchema(sql: CapacitySchemaSql): Promise<void> {
  await sql.transaction(tx => [
    tx`SELECT pg_advisory_xact_lock(${ARTIFACT_CAPACITY_SCHEMA_LOCK_KEY})`,
    ...ARTIFACT_CAPACITY_SCHEMA_STATEMENTS.map(statement => tx(asTemplateLiteral(statement))),
  ]);
}
