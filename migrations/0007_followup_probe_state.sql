-- zhuigeng42：追更/增量更新的探测状态（每本书一行）。
--
-- version = 7（文件名前缀即版本号），由 scripts/db-migration-lib.mjs 的 loadMigrations()
-- 按有序列表执行并写入 schema_migrations。
--
-- 表：followup_probe_state（book_id 主键，book_id → labeled_books(id)）
-- 记「这本书的目录我们已经知道到什么程度」：
--   last_chapter_count / last_toc_prefix_hash —— 上一次探测到的目录章数与「前 N 章标题」指纹
--     （src/lib/followup.ts 的 followupPrefixKey，FNV+djb2 双哈希，与客户端
--     reader-preferences.ts 的 catalogPrefixKey 同算法）。下一轮新目录「章数变多且前 N 章
--     指纹逐字未变」⇒ 纯追加，可入队重抓；站方改写旧章标题 ⇒ 指纹断 ⇒ 不入队（保守正确）。
--   consecutive_no_new —— 连续多少轮没有新章，用于退避（完结书无可靠信号，只能软退避）。
--   next_probe_at —— 下次可探测时刻（无行视为到期）；也是重叠调用的行级抢占点。
--   last_enqueued_task_id —— 上次因检测到新章而入队的任务（排查用，外键悬空即置 NULL）。
--
-- 对已有库（生产）：全部 IF NOT EXISTS，表已由运行时 initializeBusinessSchema 建好时只空转，
-- 真正的副作用只有 INSERT schema_migrations(version=7)。运行时 DDL 仍保留在 business-schema.ts：
-- 老实例靠它补建。两处必须逐字同构，见 src/lib/runtime-tables-migration.pglite.test.ts。
--
-- Executed as one statement inside the runner's transaction; do not add BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS followup_probe_state (
  book_id int NOT NULL PRIMARY KEY
    CONSTRAINT followup_probe_state_book_fk REFERENCES labeled_books(id),
  last_probe_at timestamptz,
  last_chapter_count int,
  last_toc_prefix_hash text NOT NULL DEFAULT '',
  consecutive_no_new int NOT NULL DEFAULT 0,
  next_probe_at timestamptz,
  last_enqueued_task_id int
    CONSTRAINT followup_probe_state_task_fk REFERENCES download_tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followup_probe_state_due_idx ON followup_probe_state (next_probe_at);
