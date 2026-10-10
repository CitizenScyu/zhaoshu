-- bsrcfix-41（prefetch 生态）：引擎回退选源结果的持久化与跨实例占位/预取认领三表。
--
-- version = 5（文件名前缀即版本号），由 scripts/db-migration-lib.mjs 的 loadMigrations()
-- 按有序列表执行并写入 schema_migrations。
--
-- 三张新表，全部幂等（CREATE ... IF NOT EXISTS），不改任何既有表/列：
--   download_source_candidates：每本书（book_id）选出的引擎回退候选源（source_url/host/池序 position
--     与失败分类）。同一本书的多个任务/多轮重试共享同一份候选，命中即免再次出网搜索；
--     failure 分类 ''（可用）/ 'permanent'（身份不符——该源确定没有这本书，重试无意义）/
--     'temporary'（超时/不可达——源可能恢复，保序保留，由 host 健康记忆另行半开重试）。
--   download_host_occupancy：host 级原子占位（真实回退下载 host / 预取扫描 host）。既有 host 感知
--     领取排序（claimDownloadTask）读的是 download_tasks.source_url——builtin 任务行仍绑 book15，
--     排序键已失真；本表记「实际在用的 host」，选源/预取据此排除他书占用的源，占位即失效自动让出。
--   download_source_prefetch：预取按书的原子认领。多实例共享队列时同一本书只被一个实例预取
--     （PK + 未过期判据 + 过期接管，同 host_occupancy 的接管语义）。
--
-- 同构约束：每条语句都逐字取自 src/lib/business-schema.ts 的同名表 DDL，**语句顺序也一致**，
-- 所以「迁移建出的表」与「运行时建出的表」连物理列序都相同。src/lib/runtime-tables-migration.pglite.test.ts
-- 在真库上逐列比对两条路径，运行时 DDL 以后再加列而忘了同步这里，那条测试会红。
--
-- 对已有库（生产）：全部 IF NOT EXISTS，表已由运行时建好时只空转，真正的副作用只有
-- INSERT schema_migrations(version=5)。运行时 DDL 仍保留在 business-schema.ts：老实例靠它补建。
--
-- Executed as one statement inside the runner's transaction; do not add BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS download_source_candidates (
  book_id int NOT NULL CONSTRAINT download_source_candidates_book_fk REFERENCES labeled_books(id),
  source_url text NOT NULL,
  host text NOT NULL,
  position int NOT NULL DEFAULT 0,
  failure text NOT NULL DEFAULT '' CONSTRAINT download_source_candidates_failure_check
    CHECK (failure IN ('', 'permanent', 'temporary')),
  failure_reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, source_url)
);
CREATE INDEX IF NOT EXISTS download_source_candidates_book_pos_idx ON download_source_candidates (book_id, position);
CREATE INDEX IF NOT EXISTS download_source_candidates_host_idx ON download_source_candidates (host);

CREATE TABLE IF NOT EXISTS download_host_occupancy (
  host text PRIMARY KEY,
  holder text NOT NULL,
  kind text NOT NULL CONSTRAINT download_host_occupancy_kind_check CHECK (kind IN ('download', 'prefetch')),
  task_id int,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS download_source_prefetch (
  book_id int PRIMARY KEY CONSTRAINT download_source_prefetch_book_fk REFERENCES labeled_books(id),
  owner text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()
);
