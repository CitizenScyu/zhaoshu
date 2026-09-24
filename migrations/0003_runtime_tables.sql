-- MS-25（dr41）：把此前只由运行时 initializeBusinessSchema 建立的四张业务表纳入版本化契约：
-- app_settings / source_admission / profile_feedback_queue / cron_health。
--
-- version = 3（文件名前缀即版本号），由 scripts/db-migration-lib.mjs 的 loadMigrations()
-- 按有序列表执行并写入 schema_migrations。
--
-- 为什么需要：0001/0002 都不建这四张表，而 db:check 的 EXPECTED_TABLES 也不列它们——
-- 冷建库缺表时 db:check 仍报通过。补进迁移后 EXPECTED_TABLES 同步列入，缺表即退出码 2。
--
-- 同构约束：每条语句都逐字取自 src/lib/business-schema.ts 的同名表 DDL，**语句顺序也一致**
-- （先 CREATE、再按运行时的先后 ADD COLUMN），所以「迁移建出的表」与「运行时建出的表」
-- 连物理列序都相同。src/lib/runtime-tables-migration.pglite.test.ts 在真库上逐列比对两条路径，
-- 运行时 DDL 以后再加列而忘了同步这里，那条测试会红。
--
-- 对已有库（生产）：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING，表已由运行时建好时只空转，
-- 真正的副作用只有 INSERT schema_migrations(version=3)。
-- 运行时 DDL 仍保留在 business-schema.ts：老实例靠它补列，本文件不替代它。
--
-- Executed as one statement inside the runner's transaction; do not add BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS app_settings (
  id integer PRIMARY KEY DEFAULT 1,
  llm_model text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS llm_reasoning text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS label_model text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS label_model_updated_at timestamptz;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_model text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_model_reasoning text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_model_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS source_admission (
  id serial PRIMARY KEY,
  source_url text NOT NULL UNIQUE,
  tier text NOT NULL,
  compile_ok boolean NOT NULL,
  core_field_mask jsonb NOT NULL,
  search_ok boolean,
  search_verdict text NOT NULL DEFAULT '',
  search_checked_at timestamptz,
  rules_hash text NOT NULL,
  engine_semantics_version integer NOT NULL DEFAULT 0,
  host text NOT NULL,
  error text NOT NULL DEFAULT '',
  compile_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE source_admission ADD COLUMN IF NOT EXISTS engine_semantics_version integer NOT NULL DEFAULT 0;
ALTER TABLE source_admission ADD COLUMN IF NOT EXISTS compile_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS source_admission_host_idx ON source_admission (host);

CREATE TABLE IF NOT EXISTS profile_feedback_queue (
  user_id int PRIMARY KEY CONSTRAINT profile_feedback_queue_user_fk REFERENCES users(id),
  pending_feedback_id int,
  absorbed_feedback_id int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unchanged',
  attempts int NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE profile_feedback_queue
  ADD COLUMN IF NOT EXISTS lease_token text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS fail_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz;

CREATE TABLE IF NOT EXISTS cron_health (
  name text PRIMARY KEY,
  last_success_at timestamptz NOT NULL DEFAULT now()
);
