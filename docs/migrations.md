# 数据库迁移

数据库结构以 `migrations/*.sql` 和 `src/lib/schema-version.ts` 为唯一版本契约。`0001_baseline.sql` 冻结应用提交 `f48299b` 的现有结构：它记录**已有**表、列、约束与索引，不引入任何后续功能字段。

## 安全边界

- 命令只接受 `--target=test`，且只读取进程中显式提供的 `TEST_DATABASE_URL`；不会读取 `.env*`，也不会回退到 `DATABASE_URL`。
- 本轮只面向隔离测试库；**不应用到生产**。
- 迁移在单个事务内执行，版本登记与 DDL 一起提交（原子）：要么全成，要么回滚且不登记。
- 用事务级 advisory lock（`schema_migrations` 同一把锁）串行化并发迁移，并设置 10 秒锁等待与 120 秒语句预算。
- `schema_migrations` 同时记录版本和 SHA-256；已登记版本对应的文件摘要变化会阻断执行，提示人工复核。
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
- `db:check` 未迁移或摘要不符时退出码为 2，参数/连接错误为 1；`db:migrate` 首次输出 `applied`，重复执行输出 `unchanged`。

`db:check` 只读，报告版本、缺表、危险记录、全部列（类型 / nullable / default）、索引与约束，供人工比对三类起点的差异。`db:migrate` 只在同一事务内写 `schema_migrations` 与结构。

`test:db` 在同一个显式测试库内创建随机命名的临时 schema，覆盖空库、旧主应用库、worker 先建库、重复执行、并发串行、故障回滚和危险 NULL 阻断，结束时删除这些临时 schema。它同样不应指向生产数据库。

## 三类起点差异

| 起点 | 主要差异 | 迁移策略 |
| --- | --- | --- |
| 空库 | 无表、列、索引或版本 | 创建完整基线和固定 owner |
| 旧主应用 | `profile.id` 默认 1；推荐和反馈没有 `user_id`；推荐存在全局唯一键 | 将既有单用户数据归属 owner，移除全局唯一键，建立用户外键及用户范围索引 |
| worker 先建 | 只有宽松 `download_tasks`；业务列可空且多项无默认值 | 先列出含 NULL 的记录 ID 并阻断；无危险数据时收紧 nullable/default |

升级后三类起点得到**同一份列 / 索引 / 约束集合**（验收脚本逐项比对）。唯一残留差异是物理列序：旧库的 `user_id` 由 `ALTER TABLE ADD COLUMN` 追加，必然排在表末尾。SQL 一律按列名访问，统一列序需要重建表，而本批不允许有损重建，因此列序不计入契约差异。

## 其他

当前契约还包含 `llm_usage`，因为它由 `src/lib/db.ts` 的延迟初始化路径创建。`labeled_books` 的扩展列与默认值来自 `scripts/import_labels.mjs` 的写入契约。`download_tasks` 的宽严差异来自 `zhaoshu-books` 的 `worker.mjs`；worker 仓库只用于核对，未被修改。

基线中的 `ALTER ... ADD COLUMN IF NOT EXISTS` 与 `DO $$` 块负责把更老的实例收敛到同一契约（例如给缺约束的 `llm_usage.total_tokens` 补上 CHECK）。
