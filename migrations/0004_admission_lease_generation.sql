-- fencefix42（2026-09-28）：准入租约显式代次列（fencing token）。
--
-- 依据 codex-fence-local-decision-20260928.md 裁定与 codex-lease-fix-options-20260928.md 方案：
-- cron_health 的 admission_lease 借行只存「到期时刻」，无持有者身份——已实证（rvadmlfix-42-report §2）
-- 过期持有者可在新持有者写入后迟到覆盖（两个方向）。本迁移给 cron_health 加显式 BIGINT 代次列：
-- 每次成功领取原子 +1 并 RETURNING，最终准入写在同一短事务里「锁租约行 + 代次等值 + 锁后
-- clock_timestamp() 有效期」三重门禁后才提交批次，阻断旧代次迟到写。
--
-- 增量列，不改写 0003（已发布字节冻结）。幂等：老库已有 cron_health 时只补列，既有行默认 0，
-- 第一次新版领取推进为 1；新库由运行时 initializeBusinessSchema 同款 DDL 建（两条路径由
-- runtime-tables-migration.pglite.test.ts 逐列比对同构）。
--
-- 代次防复用的生命周期前提（上线/回滚/备份恢复须遵守，详见 fencefix-42-report.md §6）：
-- 不得删除租约行重建、不得手工归零 generation、备份恢复后须排空全部旧 holder 再开放准入。
--
-- Executed as one statement inside the runner's transaction; do not add BEGIN/COMMIT here.

ALTER TABLE cron_health
  ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0;
