# 数据库迁移

数据库结构以 `migrations/*.sql` 和 `src/lib/schema-version.ts` 为唯一版本契约。迁移文件是一个**显式有序列表**（`scripts/db-migration-lib.mjs` 的 `MIGRATION_FILES`），不扫描目录：目录里多一个 `.sql` 不会在无人察觉时被执行。

| 文件 | version | 内容 |
| --- | --- | --- |
| `0001_baseline.sql` | 1 | 冻结应用提交 `f48299b` 的现有结构；记录**已有**表、列、约束与索引，不引入后续功能字段 |
| `0002_identity_key.sql` | 2 | 身份键从表达式索引升级为「生成列 + 唯一索引」（task-53 Phase 2） |
| `0003_runtime_tables.sql` | 3 | 把此前只有运行时 DDL 的 `app_settings` / `source_admission` / `profile_feedback_queue` / `cron_health` 纳入契约（MS-25）；语句逐字取自 `business-schema.ts`，`runtime-tables-migration.pglite.test.ts` 逐列比对两条路径 |

版本号取自文件名数字前缀，`SCHEMA_VERSION` 必须等于列表里的最大版本，否则 `loadMigrations()` 直接报错——常量与文件脱节不会被静默放过。**已发布的文件内容即其摘要**：`0001` 的 sha256 已记入生产 `schema_migrations`，改一个字节会让 `db:check` / `db:migrate` 在已有库上拒绝继续。`0002` 已由生产按同一文件手工执行过 DDL，同样不得再改。已发布摘要冻结在 `db-migration-lib.mjs` 的 `PUBLISHED_CHECKSUMS`，由 `cold-schema-rebuild.pglite.test.ts` 钉住（3c7a20f 曾改 `0001` 的一行记账，dr41 已恢复原字节）。

`0001` 只把 auth 记账到 4：auth 的 5/6/7 由 `initializeAuthSchema` 执行，冷建库须在 `db:migrate` 之后跑 `migrate:auth:prod`（见 `docs/auth-deployment.md`）。`db:check` 同时判 auth 记账版本，不足 `AUTH_SCHEMA_VERSION` 时退出码 2。

## 安全边界

- 命令只接受 `--target=test`，且只读取进程中显式提供的 `TEST_DATABASE_URL`；不会读取 `.env*`，也不会回退到 `DATABASE_URL`。
- 本轮只面向隔离测试库；**不应用到生产**。
- 整个待执行列表在单个事务内执行，所有版本的登记与 DDL 一起提交（原子）：要么全成，要么回滚且不登记任何版本。
- 用事务级 advisory lock（`schema_migrations` 同一把锁）串行化并发迁移，并设置 10 秒锁等待与 120 秒语句预算。
- `schema_migrations` 同时记录版本和 SHA-256；已登记版本对应的文件摘要变化会阻断执行，提示人工复核。
- **多版本记账**：逐条按 version 查 `schema_migrations`。已有行且摘要相符 → 跳过、不执行该文件的 SQL；无行 → 执行 SQL 并 INSERT 记账。因此对「DDL 已手工跑过但没记账」的库（生产当前状态），首次 `db:migrate` 只补记账、空转 DDL。
- **行尾归一**：读文件后先把 CRLF 归成 LF 再算摘要、再执行。生产已登记的 v1 摘要是 LF 版（`0001` 的 git blob 摘要），而 Windows 上 `core.autocrlf=true` 的 checkout 读到的是 CRLF；不归一会让同一份文件在不同平台得到两枚摘要，迁移被「摘要不匹配」整批拒绝。归一不改盘上文件，也不改已登记的行。
- SQL 文件作为整体交给 PostgreSQL，执行器不会按分号切割。
- worker 旧表中无法可靠推断的必填 NULL 会阻断迁移，错误包含 `download_tasks.id`；不会用假值补齐，也不会删除历史数据。

## 不依赖会话状态

池化端点（Neon `-pooler` / PgBouncer）会在连接之间复用后端，**会话级 `SET`（例如 `SET search_path`）不可靠**：实测中新建连接的 `SHOW search_path` 会带上别的会话残留的值。因此：

- 目标 schema 只在事务内用 `SET LOCAL search_path` 指定，事务内语句不会被路由到别的 schema。
- 只读盘点全部按 schema 限定（`information_schema.columns WHERE table_schema = $1`、`to_regclass('schema.table')`），不依赖 `current_schema()`。
- `db:migrate` 在真正执行前会实测端点性质：事务是否固定在后端（`SET LOCAL` + `SHOW` 往返），以及 advisory lock 是否跨连接互斥。任一条不成立就拒绝执行。

目标 schema 目前固定为 `public`（应用的业务表所在 schema）。

## 命令

在专用、可丢弃的隔离数据库中执行（shell 里临时读入，不要写进配置或日志）：

```bash
export TEST_DATABASE_URL="$(tr -d '\r\n' < <隔离库连接文件>)"
npm run db:check   -- --target=test   # 只读盘点
npm run db:migrate -- --target=test   # 执行迁移（幂等）
npm run test:db    -- --target=test   # 三类起点 + 并发 + 回滚验收
```

三点注意：

- 目标必须由 `-- --target=test` 显式给出；不加参数会直接报错退出（退出码 1）。脚本里没有内置默认目标。
- 缺少 `TEST_DATABASE_URL` 时立即失败（退出码 1），不会回退到业务 `DATABASE_URL`。
- `db:check` 会**逐个版本**核对 `schema_migrations` 里的 name 与 sha256：缺任一版本（例如只有 v1 的库）或摘要不符都退出码 2，参数/连接错误为 1。`db:migrate` 首次输出 `applied`，重复执行输出 `unchanged`；两者的 `versions[]` 逐条给出每个版本的 `applied` / `unchanged`。

`db:check` 只读，报告版本、缺表、危险记录、全部列（类型 / nullable / default）、索引与约束，供人工比对三类起点的差异。`db:migrate` 只在同一事务内写 `schema_migrations` 与结构。

`test:db` 在同一个显式测试库内创建随机命名的临时 schema，覆盖空库、旧主应用库、worker 先建库、**手工跑过 0002 的生产形态**（先只 apply 0001，再裸跑 0002 的 DDL 不记账，然后重跑迁移只补记 v2）、重复执行、并发串行、故障回滚和危险 NULL 阻断，结束时删除这些临时 schema。它同样不应指向生产数据库。

## 三类起点差异

| 起点 | 主要差异 | 迁移策略 |
| --- | --- | --- |
| 空库 | 无表、列、索引或版本 | 创建完整基线和固定 owner |
| 旧主应用 | `profile.id` 默认 1；推荐和反馈没有 `user_id`；推荐存在全局唯一键 | 将既有单用户数据归属 owner，移除全局唯一键，建立用户外键及用户范围索引 |
| worker 先建 | 只有宽松 `download_tasks`；业务列可空且多项无默认值 | 先列出含 NULL 的记录 ID 并阻断；无危险数据时收紧 nullable/default |

升级后四类起点（含「手工跑过 0002 的生产形态」）得到**同一份列 / 索引 / 约束集合**（验收脚本逐项比对，并断言四个 schema 的指纹全等）。唯一残留差异是物理列序：旧库的 `user_id` 由 `ALTER TABLE ADD COLUMN` 追加，必然排在表末尾。SQL 一律按列名访问，统一列序需要重建表，而本批不允许有损重建，因此列序不计入契约差异。

## 其他

当前契约还包含 `llm_usage`，因为它由 `src/lib/db.ts` 的延迟初始化路径创建。`labeled_books` 的扩展列与默认值来自 `scripts/import_labels.mjs` 的写入契约。`download_tasks` 的宽严差异来自 `zhaoshu-books` 的 `worker.mjs`；worker 仓库只用于核对，未被修改。

基线中的 `ALTER ... ADD COLUMN IF NOT EXISTS` 与 `DO $$` 块负责把更老的实例收敛到同一契约（例如给缺约束的 `llm_usage.total_tokens` 补上 CHECK）。
