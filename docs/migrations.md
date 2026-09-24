# 数据库迁移

数据库结构以 `migrations/*.sql` 和 `src/lib/schema-version.ts` 为唯一版本契约。迁移文件是一个**显式有序列表**（`scripts/db-migration-lib.mjs` 的 `MIGRATION_FILES`），不扫描目录：目录里多一个 `.sql` 不会在无人察觉时被执行。

| 文件 | version | 内容 |
| --- | --- | --- |
| `0001_baseline.sql` | 1 | 冻结应用提交 `f48299b` 的现有结构；记录**已有**表、列、约束与索引，不引入后续功能字段 |
| `0002_identity_key.sql` | 2 | 身份键从表达式索引升级为「生成列 + 唯一索引」（task-53 Phase 2） |
| `0003_runtime_tables.sql` | 3 | 把此前只有运行时 DDL 的 `app_settings` / `source_admission` / `profile_feedback_queue` / `cron_health` 纳入契约（MS-25）；语句逐字取自 `business-schema.ts`，`runtime-tables-migration.pglite.test.ts` 逐列比对两条路径 |

版本号取自文件名数字前缀，`SCHEMA_VERSION` 必须等于列表里的最大版本，否则 `loadMigrations()` 直接报错——常量与文件脱节不会被静默放过。**已发布的文件内容即其摘要**：`0001` 的 sha256（`1b47f1ca…`）已记入隔离库 / 灾备演练库的 `schema_migrations`，`db:baseline:prod` 也按这三份字节登记生产；改一个字节会让 `db:check` / `db:migrate` 在已登记的库上拒绝继续。`0002` 已由生产按同一文件手工执行过 DDL，同样不得再改。

> **勘误（2026-09-24，prodmig41 只读实测）**：此前文档与代码注释写的「生产 `schema_migrations` 已登记 v1 = `1b47f1ca…`」是错的。那枚摘要出自 `codex-done-28.md:71`，是 12.2 节**隔离库**诊断里首次 `db:migrate` 的输出（同文件 12.3 节写明该批次只连 `TEST_DATABASE_URL`、从未指向生产）。生产库**根本没有 `schema_migrations` 表**：v1/v2/v3 都未登记，表由运行期 DDL 与 auth 迁移逐步建成，0002 手工执行过。所以生产要走下文的 `db:baseline:prod`（只核对、只补记账），不能走 `db:migrate:prod --apply`（那会把整份 0001 在在线表上重跑）。已发布摘要冻结在 `db-migration-lib.mjs` 的 `PUBLISHED_CHECKSUMS`，由 `cold-schema-rebuild.pglite.test.ts` 钉住（3c7a20f 曾改 `0001` 的一行记账，dr41 已恢复原字节）。

`0001` 只把 auth 记账到 4：auth 的 5/6/7 由 `initializeAuthSchema` 执行，冷建库须在 `db:migrate` 之后跑 `migrate:auth:prod`（见 `docs/auth-deployment.md`）。`db:check` 同时判 auth 记账版本，不足 `AUTH_SCHEMA_VERSION` 时退出码 2。

## 安全边界

- `db:check` / `db:migrate` 只接受 `--target=test`，且只读取进程中显式提供的 `TEST_DATABASE_URL`；不会读取 `.env*`，也不会回退到 `DATABASE_URL`。它们只面向隔离测试库，**不应用到生产**；生产与灾备冷建库用下文的 `db:check:prod` / `db:baseline:prod` / `db:migrate:prod`。
- 整个待执行列表在单个事务内执行，所有版本的登记与 DDL 一起提交（原子）：要么全成，要么回滚且不登记任何版本。
- 用事务级 advisory lock（`schema_migrations` 同一把锁）串行化并发迁移，并设置 10 秒锁等待与 120 秒语句预算。
- `schema_migrations` 同时记录版本和 SHA-256；已登记版本对应的文件摘要变化会阻断执行，提示人工复核。
- **多版本记账**：逐条按 version 查 `schema_migrations`。已有行且摘要相符 → 跳过、不执行该文件的 SQL；无行 → 执行 SQL 并 INSERT 记账。因此对「v1 已登记、后续版本的 DDL 手工跑过但没记账」的库，首次 `db:migrate` 只补记账、空转 DDL。**连 v1 都没登记的已有库（生产当前状态）不在此列**：runner 会把整份 0001 当成待执行，在在线表上重跑 ALTER COLUMN / UPDATE / SET NOT NULL；这种库走 `db:baseline:prod`，`db:migrate:prod` 会拒绝它。
- **行尾归一**：读文件后先把 CRLF 归成 LF 再算摘要、再执行。已登记的 v1 摘要是 LF 版（`0001` 的 git blob 摘要；隔离库首次 `db:migrate` 输出，见上文勘误），而 Windows 上 `core.autocrlf=true` 的 checkout 读到的是 CRLF；不归一会让同一份文件在不同平台得到两枚摘要，迁移被「摘要不匹配」整批拒绝。归一不改盘上文件，也不改已登记的行。
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

## 生产 / 灾备入口（`db:check:prod` / `db:baseline:prod` / `db:migrate:prod`）

`scripts/db-prod.mjs`，与 `migrate:auth:prod`（见 `docs/auth-deployment.md`）同一套约束；迁移本体就是上文的 runner（`applyMigration`），不另写 SQL。

- **目标显式给出**：`--database-url-env=<变量名>`，只读该变量；不读 `.env*`，不回退 `DATABASE_URL` / `TEST_DATABASE_URL`，也不接受这两个名字本身。与 `migrate:auth:prod` 用同一个变量即可。
- **`db:check:prod`（只读）**：整段在 `BEGIN READ ONLY` 事务里。逐版本核摘要、缺表、auth 记账版本（同 `db:check`），外加：
  - 严格记账比对：库里有摘要 / 名称不符的版本、高于代码最新版本的版本、代码不认识的版本、乱序缺口，都判不通过；
  - 四张运行期表（`app_settings` / `source_admission` / `profile_feedback_queue` / `cron_health`）的列类型 / 可空 / 默认值与 0003 的声明（`EXPECTED_RUNTIME_COLUMNS`）逐列比对，输出里附这四表的原始列行。`ADD COLUMN IF NOT EXISTS` 只看列名，列存在但类型不同时 0003 会空转、运行期 INSERT 才炸，所以迁移前必须先看这一项。
  - 退出码：0 通过；2 不通过；1 参数 / 连接错误。
- **`db:baseline:prod`**（从未登记的已有库「只补记账」，`scripts/db-baseline.mjs`）：**不执行任何迁移文件里的 SQL**。默认 **dry-run**（`BEGIN READ ONLY`），逐项核对 0001–0003 的效果在库里都已成立：
  - 结构：`scripts/db-baseline-contract.mjs` 的 `BASELINE_SHAPE`——0001→0003 在空库上真跑出的 20 张表的全部列（类型 / 非空 / 默认值 / identity / 生成列表达式 / 所属序列的 `pg_sequence` 参数，含 0001:5 identity 的 `START WITH 2`）、约束（名称 + 类型 + 定义）、索引（名称 + 定义），由 `db-baseline.test.ts` 每次重跑迁移钉住；每张表出自哪段 SQL 见 `BASELINE_TABLE_SOURCES`。库里多出来的列 / 约束 / 索引（auth v5–v7、运行期、artifact 后加的）只在 `extra` 里报告，不拒绝。
  - 删除项（`BASELINE_ABSENT`）：recommendations 的旧全局唯一约束 / 索引（0001:103-108；索引判据与 0001 自身的正则同口径，带 WHERE 的部分唯一索引同样算违规）、`books_title_author_idx` / `labeled_books_title_author_idx`（0002:46-47）必须不在。
  - 数据项（`BASELINE_DATA_CHECKS`）：owner 固定身份、`auth_settings` / `profile` / `shuyuan_meta` / `app_settings` 的 id=1 行、recommendations / feedback 的 `user_id` 与 download_tasks 必填列无 NULL、auth 记账含 1–4、画像归属已迁移。
  - 前提：库里**没有登记任何版本**——没有 `schema_migrations`，或者表在但 0 行（视同未登记，但要求表的形状与 runner 建的完全一致，否则拒绝并请人查明来历；这样空记账表的库不会落进「baseline 拒、migrate 也拒」的死区）；已登记过版本的库交给 `db:migrate:prod`；auth 记账 ≥ 7（不足先跑 `migrate:auth:prod`）；迁移文件摘要等于 `BASELINE_CHECKSUMS`（契约只对那三份字节成立）。
  - 任何一条不成立：输出 `status: refused` 与 `refusals[]`（逐条写明出处行号与差异），**不写库，退出码 2**，绝不部分登记。全部成立时 dry-run 输出 `ledgerWrites`（`schema_migrations` 的 v1–v3 三行）。
  - 显式 `--apply` 才写：先实测端点，再在**一个事务**里拿与 runner 同一把迁移锁、**锁内重新核对一遍**（dry-run 之后库被改就回滚并拒绝），通过才建 `schema_migrations`（与 runner 同一条 DDL）并登记 v1–v3，最后只读复核输出 `after`（应 `ok: true`）。写入只有这张新表和三行记账。
  - 契约由 PGlite（PostgreSQL 18）导出；目标库大版本不同，若 `pg_get_constraintdef` / 生成列表达式的渲染有差异，会表现为 `column-mismatch` / `constraint-mismatch` 拒绝（不会误放行）。此时逐条比对差异是否只是渲染不同，再决定如何处理，不要绕过。
- **`db:migrate:prod`**：默认 **dry-run**（同样只读），列出将执行的迁移（`ledger.pending`）和将写入的记账行（`ledgerWrites`：每个待执行版本一行 `schema_migrations`，`0001` 另写 `auth_schema_migrations` 1–4）。显式 `--apply` 才写：先实测端点（同 `db:migrate`），再在迁移事务的 advisory lock 内按整张记账表复核一次，最后只读复核并输出 `after`。
  - 上面任何一条严格比对或列契约不通过：dry-run 与 `--apply` 都输出 `status: refused` 与 `refusals[]`，**不写库，退出码 2**。
  - **没有登记任何版本（没有 `schema_migrations` 或表在但 0 行）、却已有迁移管理的表**（从未登记的已有库，例如生产）同样拒绝，提示改走 `db:baseline:prod`——否则 `--apply` 会把整份 0001 在在线表上重放。冷建库只能从空库开始。
  - 没有待执行版本时 `--apply` 输出 `unchanged`，不开写事务。
- 输出只含目标 host、版本、摘要与列形状，不含连接串；错误信息里的连接 URL 会被替换为 `[REDACTED_DATABASE_URL]`。
- `--apply` 失败时先看退出码：**2** = 前置核对拒绝，未写库，按 `refusals` 处理后可直接重跑；**1** = 连接 / 端点 / 执行错误，其中 `code: 55P03` 是锁等待 10 秒超时、整批已回滚，先查谁持锁（`pg_locks` / `pg_stat_activity`）再低峰重试。

### 生产执行顺序（从未登记的已有库——生产当前形态）

连接串只在当前 shell 临时读入，不写文件、不进日志；每步先看输出里的 `host` 是否为目标库。

```powershell
$env:PROD_DATABASE_URL = '<目标库连接串>'
# 0) 部署应用（运行期行为不依赖 schema_migrations，可先行）；按 docs/auth-deployment.md「生产收口」第 2 步做备份 / Neon 时间点分支
# 1) auth：预期 plan.status=up-to-date、before.max=7；有 pending 先弄清原因再 --yes-i-mean-production
npm run migrate:auth:prod -- --database-url-env=PROD_DATABASE_URL --dry-run
# 2) 只读核对：预期退出码 2，versions=[]、missingTables=["schema_migrations"]、ledger.pending=[1,2,3]、ledger.errors=[]、
#    authVersionOk=true、runtimeColumns.ok=true。runtimeColumns.extra 非空先停下人工确认。
npm run db:check:prod -- --database-url-env=PROD_DATABASE_URL
# 3) baseline dry-run：预期 status=dry-run、problems=[]、ledgerWrites 为 v1–v3 三行；看一遍 extra
#    （应只有 auth v5–v7 / 运行期 / artifact 加的东西）。status=refused 就停，按 refusals 逐条核实，不要改用 migrate --apply 绕过。
npm run db:baseline:prod -- --database-url-env=PROD_DATABASE_URL
# 4) 登记：预期 status=applied、after.ok=true
npm run db:baseline:prod -- --database-url-env=PROD_DATABASE_URL --apply
# 5) 复核：退出码 0；db:migrate:prod dry-run 应为 status=up-to-date
npm run db:check:prod -- --database-url-env=PROD_DATABASE_URL
npm run db:migrate:prod -- --database-url-env=PROD_DATABASE_URL
Remove-Item Env:PROD_DATABASE_URL
```

登记之后的新迁移（0004 起）照常走 `db:migrate:prod`，见下一节。

### 已登记库的后续迁移

库里已有 `schema_migrations` 时：`db:check:prod`（预期退出码 2，且唯一原因是新版本未登记——逐条看 `ledger.errors` 应为空，`runtimeColumns.extra` 非空先停）→ `db:migrate:prod` dry-run（`ledger.pending` 只有新版本）→ `--apply`（`after.ok=true`）→ `db:check:prod` 退出码 0。`ALTER TABLE … ADD COLUMN IF NOT EXISTS` 即便空转也要短暂拿 `ACCESS EXCLUSIVE` 锁，取不到锁 10 秒后整批回滚、不留半成品，低峰重试即可。

### 灾备冷建库顺序（空库）

`db:migrate:prod --apply`（0001→0003，`after.authVersion=4`、`authVersionOk=false` 属预期，输出 `next` 提示）→ `migrate:auth:prod --yes-i-mean-production`（补 auth 5/6/7）→ `db:check:prod` 退出码 0 → 部署应用。每一步之前都可以先跑对应的 dry-run。必须从空库开始：先跑了 auth 迁移的库已有业务表，`db:migrate:prod` 会按「未登记的已有库」拒绝——灾备分支直接丢弃重建即可。

### 回滚

- 应用代码：revert 即可。旧代码没有本入口；旧 `db:migrate` / `db:check` 只遍历自己列表里的版本，库里多出的记账行不影响它们。
- baseline：唯一写入是新建的 `schema_migrations` 表与 v1–v3 三行，业务表一个字节不动；确要撤回就删掉这张记账表（`DROP TABLE schema_migrations`），库回到登记前的状态。`--apply` 中途失败整批回滚，不会留下空表或部分登记。
- migrate：对已登记库，新版本多出记账行和该版本自己的 DDL；确要撤回某版本记账用 `DELETE FROM schema_migrations WHERE version = <N>`（表结构不动）。`--apply` 失败时整批事务回滚，无半成品。冷建库失败直接丢弃该库 / 分支重来。auth 迁移只进不退，见 `docs/auth-deployment.md`。

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
