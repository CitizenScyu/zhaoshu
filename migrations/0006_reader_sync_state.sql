-- readsync42：阅读进度 / 阅读设置的云端同步（每用户一行一「项」）。
--
-- version = 6（文件名前缀即版本号），由 scripts/db-migration-lib.mjs 的 loadMigrations()
-- 按有序列表执行并写入 schema_migrations。
--
-- 表：reader_sync_state（user_id, item_key）主键，payload 是 ReadingProgress / ReaderSettings
-- 的 JSON 序列化，client_updated_at 是**客户端**的 epoch 毫秒，作为 last-write-wins 版本号。
-- 刻意不拿服务器时间做版本：两台设备的时钟没有共同基准，用服务器 now() 落版本会让「后写的
-- 客户端」未必是「云端较新的一方」，跨设备来回覆盖。服务端只维护 updated_at（谁最后碰过这行，
-- 运维用），比较一律用 client_updated_at。
--
-- item_key = '<kind>:<本地存储键>'（kind ∈ progress|settings），解析见 src/lib/reader-sync.ts。
-- 进度一项一行（换书源 / 换任务各一行），设置只有一项（key 固定 'default'）。
--
-- 对已有库（生产）：全部 IF NOT EXISTS，表已由运行时 initializeBusinessSchema 建好时只空转，
-- 真正的副作用只有 INSERT schema_migrations(version=6)。运行时 DDL 仍保留在 business-schema.ts：
-- 老实例靠它补建。两处必须逐字同构，见 src/lib/runtime-tables-migration.pglite.test.ts。
--
-- Executed as one statement inside the runner's transaction; do not add BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS reader_sync_state (
  user_id int NOT NULL CONSTRAINT reader_sync_state_user_fk REFERENCES users(id),
  item_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  client_updated_at bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key)
);
