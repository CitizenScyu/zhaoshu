-- task-53 Phase 2：身份键从「表达式索引 lower(title),lower(author)」升级为
-- 「生成列 + 新唯一索引」，让 ON CONFLICT 指向确定性的键。
--
-- version = 2（文件名前缀即版本号），由 scripts/db-migration-lib.mjs 的
-- loadMigrations() 按有序列表执行并写入 schema_migrations。
--
-- 与 0001_baseline.sql 的关系：0001 里那两条旧 CREATE UNIQUE INDEX 保留原样，
-- 因为 0001 的 sha256 摘要记录在 schema_migrations 里（scripts/db-migration-lib.mjs
-- 的 loadMigrations 会用摘要拒绝重放被改过的基线），改一个字节就会让 db:check /
-- db:migrate 在已有库上直接失败。本文件按顺序接管：建新列/新索引 → 删旧索引。
--
-- 生产已按本文件手工执行过 DDL；首次由 runner 跑到这里时结构已存在，全部语句
-- 走 IF [NOT] EXISTS 空转，真正的副作用只有 INSERT schema_migrations(version=2)。
--
-- ⚠️ normalize() 第二参数是**关键字**：normalize(x, NFKC) 可以，
-- normalize(x, 'NFKC') 报 42601（生产实测）。
--
-- ⚠️ 绝不把这里的新索引 DDL 放进 ensureSchema / business-schema：
-- CREATE UNIQUE INDEX 抛 23505 会让 schemaPromise 重抛，全站 503。
--
-- 执行前提：无业务流量（llm_usage 静默、无 run-rounds 进程）。ALTER 触发表重写
-- 即自动回填，books / labeled_books 量级下为秒级。
-- 若 CREATE UNIQUE INDEX 抛 23505 ⇒ 库里存在归一分叉的重复行（Phase 3 应已清零），
-- 此时停下人工复核，不要清数。

ALTER TABLE books ADD COLUMN IF NOT EXISTS title_key text GENERATED ALWAYS AS (
  lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\1')))
) STORED;

ALTER TABLE books ADD COLUMN IF NOT EXISTS author_key text GENERATED ALWAYS AS (
  lower(btrim(normalize(author, NFKC)))
) STORED;

ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS title_key text GENERATED ALWAYS AS (
  lower(btrim(regexp_replace(btrim(normalize(title, NFKC)), '^《(.+)》$', '\1')))
) STORED;

ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS author_key text GENERATED ALWAYS AS (
  lower(btrim(normalize(author, NFKC)))
) STORED;

-- 先建新索引，再删旧索引：部署窗口内旧代码的 ON CONFLICT 旧目标必须仍然有效。
CREATE UNIQUE INDEX IF NOT EXISTS books_identity_idx ON books (title_key, author_key);
CREATE UNIQUE INDEX IF NOT EXISTS labeled_books_identity_idx ON labeled_books (title_key, author_key);

DROP INDEX IF EXISTS books_title_author_idx;
DROP INDEX IF EXISTS labeled_books_title_author_idx;
