-- repothresh44：切仓口径从「台账逻辑字节」换成「GitHub 压缩 pack 字节」。
--
-- version = 8（文件名前缀即版本号），由 scripts/db-migration-lib.mjs 的 loadMigrations()
-- 按有序列表执行并写入 schema_migrations。
--
-- 为什么（用户 2026-10-19 裁定「尽量仓少一点，平衡一点」）：
--   旧判据 `registered_bytes + reserved_bytes + 本次 logicalBytes <= target_bytes`（1e9 **逻辑**字节）
--   比 GitHub 实际的压缩 pack 口径早约 2.6 倍触发（书仓 TXT 实测压缩≈逻辑 40%：books-2 逻辑
--   1,000,307,484 B 对应压缩 397,520,896 B）。GitHub 的容量限制与 clone/push 性能都按压缩 pack 算，
--   按逻辑字节切仓会在远未触到真实限制时就开新仓。新判据统一为
--   `github_size_bytes + 1 <= target_compressed_bytes`（默认 2GiB = 2147483648），
--   对 5GB 硬限留约 2.5 倍余量，仓数量约降为旧口径的 1/5。
--
-- 本文件**不建表**：repository_capacity_ledger 的 DDL 在 src/lib/artifact-capacity-schema.ts
-- （initializeArtifactCapacitySchema），且它外键引用 storage_repositories——后者由
-- migrate:artifacts:prod 建，同样不在 0001–0007 里。只跑过 db:migrate 的冷库上这张表还不存在，
-- 而迁移在 runner 的**单个事务**里执行，任何一句报错都会整批回滚（连带 0001–0007 的登记）。故：
--   - ALTER TABLE **IF EXISTS**：表不在即空转；
--   - 回填用 to_regclass 守卫（下方 DO 块），表不在即 RETURN。
--   运行时 DDL 已同步加这两列（artifact-capacity-schema.ts），冷建库靠它补齐——两处必须同构。
--
-- 语义边界：
--   - target_bytes 保留只读作历史（旧逻辑口径），不再参与任何切仓判定；
--   - admission_* 一律不碰（F1 准入续期语义归 scripts/sync-ledger-capacity.mjs）；
--   - 回填**不推进 updated_at**：该列的语义是「最近一轮成功核对的时刻」（F1 用它做时间戳），
--     迁移种值不是一次核对，推进它等于伪造核对证据。
--
-- 回填值出处（2026-10-19 实测，非估算）：phoenix 上以只读方式调 GitHub REST
-- `GET /repos/CitizenScyu/<repo>` 取 size 字段（单位 KiB，压缩 pack），×1024 得字节；
-- owner/repo 与 id 的对应取自生产 storage_repositories 只读查询（id 1/2/3，三行 state='ready'）。
--   id 1 CitizenScyu/zhaoshu-books    sizeKib=756360 → 774512640
--   id 2 CitizenScyu/zhaoshu-books-2  sizeKib=388204 → 397520896
--   id 3 CitizenScyu/zhaoshu-books-3  sizeKib=8084   →   8278016
-- 回填按 (owner, repo) 关联而非写死 id：id 由各库自己的 identity 分配，仓名才是跨库稳定标识。
-- 只写 github_size_bytes = 0 的行（尚未种值才填），已有观测值不覆盖——迁移重跑或先跑过
-- sync-ledger-capacity 都不会把新值倒退回 2026-10-19 的快照。
--
-- Executed as one statement inside the runner's transaction; do not add BEGIN/COMMIT here.

ALTER TABLE IF EXISTS repository_capacity_ledger
  ADD COLUMN IF NOT EXISTS github_size_bytes bigint NOT NULL DEFAULT 0 CHECK (github_size_bytes >= 0),
  ADD COLUMN IF NOT EXISTS target_compressed_bytes bigint NOT NULL DEFAULT 2147483648 CHECK (target_compressed_bytes > 0);

DO $$ BEGIN
  IF to_regclass('public.repository_capacity_ledger') IS NULL THEN
    RETURN;
  END IF;
  UPDATE repository_capacity_ledger AS l
  SET github_size_bytes = v.bytes
  FROM (VALUES
    ('CitizenScyu', 'zhaoshu-books',   774512640::bigint),
    ('CitizenScyu', 'zhaoshu-books-2', 397520896::bigint),
    ('CitizenScyu', 'zhaoshu-books-3',   8278016::bigint)
  ) AS v(owner, repo, bytes)
  JOIN storage_repositories AS r
    ON lower(r.owner) = lower(v.owner) AND lower(r.repo) = lower(v.repo)
  WHERE l.repository_id = r.id
    AND l.github_size_bytes = 0;
END $$;
