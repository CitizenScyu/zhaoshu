# A04 个人数据隔离与 schema 交付（当前 auth schema v7）

> 本文档跨批次累积：§运行版本与部署顺序描述当前版本，其余章节标注了各自的批次语境。
> 当前版本为 **v7**（下载任务队列：用户任务与系统任务同表），此前为 v6（A07 邀请码）、v5（A05 下载归属）、v4（A04 个人数据隔离）。
> 历史章节里的“本批”指它们各自的批次，不代表当前版本。
> 版本号须与 `src/lib/auth-store.ts` 的 `AUTH_SCHEMA_VERSION` 同步（有测试断言守着，漂移即红）。

## 运行版本与部署顺序

**当前必须一次完成的顺序**：先对目标库执行迁移到 `version = 7`，确认成功后再切换应用代码 / 部署。
仅部署代码而不迁移会让 `assertAuthSchema` 全站失败：`ensureSchema` 在初始化业务表之前先校验
`max(version) >= 7`，版本不足时抛 `AuthSchemaRequiredError`，所有需要数据库的请求都会 503。
闸门只拦「库落后于代码」一侧：库版本新于代码（DDL 已跑、旧实例还在的灰度/回滚窗口）不再 503；
库版本高于代码支持上限的前向保护由迁移器在 `version > 7` 时 `RAISE EXCEPTION` 兜底，不靠运行时闸门。

```powershell
# 1) 先迁移（必须显式提供 TEST_DATABASE_URL；脚本不回退业务 DATABASE_URL；缺连接退出码 2）
$env:TEST_DATABASE_URL = '<目标库连接串>'
npm run migrate:auth -- --check   # 只读预检：当前版本、约束、索引
npm run migrate:auth              # 幂等迁移到 v7
# 2) 确认 preflight/complete 输出里的 version 为 7、users_created_via_invite_fk 已建立
# 3) 再切换应用代码 / 部署
```

迁移只增不删：v7 只追加 `download_tasks` 的系统任务列、约束与索引（requested_by /
lease_generation 等），v6 只追加 `registration_invites` 表、索引与 `users.created_via_invite_id` 外键，
v5 及以前的语句一字未动，重复执行是幂等的（`IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 7)`）。
回退应用代码不会撤销已建立的表；已产生的邀请码与成员数据必须保留，不能承诺“关掉开关即可回退”。

新版应用连旧库不受支持（503）；旧版应用连新库**可以**继续服务——闸门只拦库版本落后于代码的一侧，
不再把「库新代码旧」判成 503。库版本高于代码支持上限（`auth_schema_migrations` 里出现比当前代码
支持的更高的版本）仍由迁移块主动 `RAISE EXCEPTION`（`newer than supported version 7`）。

## 生产库迁移入口（`migrate:auth:prod`）

`migrate:auth` 只接受 `TEST_DATABASE_URL`，是隔离库演练工具；生产库（以及灾备冷建库）用
`scripts/migrate-auth-prod.mjs`。迁移本体与 `migrate:auth` 是同一个 `initializeAuthSchema`（不另写 DDL），
逐版本按 `auth_schema_migrations` 是否已有该版本行决定执行或跳过，因此幂等、可重复执行。

目标必须显式给出，没有默认值：`--database-url-env=<变量名>` 指定从哪个环境变量读连接串（脚本不读
`.env*`、不回退 `DATABASE_URL`），再从 `--dry-run`（只读）与 `--yes-i-mean-production`（真执行）里
**必须且只能**选一个。输出只含目标 host、记账版本与步骤说明，不含连接串或凭据。

```powershell
# 连接串只在当前 shell 临时读入，不写进文件或日志；变量名自定，这里用 PROD_DATABASE_URL 举例
$env:PROD_DATABASE_URL = '<目标库连接串>'
# 1) 只读预检：核对输出里的 host 是否为目标库，看 before.versions 与 plan.pending（将补哪些版本）
npm run migrate:auth:prod -- --database-url-env=PROD_DATABASE_URL --dry-run
# 2) 按「生产收口的前置条件与顺序」做完备份后真执行；status=applied（或 unchanged）且 after.max=7
npm run migrate:auth:prod -- --database-url-env=PROD_DATABASE_URL --yes-i-mean-production
Remove-Item Env:PROD_DATABASE_URL
```

- **灾备冷建库**的完整顺序：`db:migrate:prod --apply`（业务 schema 的生产入口，`0001` 只把 auth 记账到 4）→ 本命令补 auth 的
  5/6/7 三步（下载归属、邀请码表、系统任务队列）→ `migrate:artifacts:prod` 补 artifact schema（`storage_repositories` /
  `book_artifacts` / `download_tasks.artifact_id` FK，v2 加 `download_tasks.book_id` → `labeled_books(id)` FK，独立入口见 `docs/artifact-registry.md`）→ `register:storage:prod` 登记仓位 →
  `db:check:prod`（auth 记账不足 7 或 artifact schema 未建时退出码 2）→ 部署应用。
  跳过本命令时应用的 `assertAuthSchema` 会全站 503，`db:check:prod` 也会报 `authVersionOk: false`；
  跳过 `migrate:artifacts:prod` 时 T8 下载 worker 启动即 `relation "storage_repositories" does not exist`，
  `db:check:prod` 报 `artifactVersionOk: false` 且缺表清单含 artifact 三表。
  业务侧入口与已有生产库的执行顺序（生产走 `db:baseline:prod`）见 `docs/migrations.md`「生产 / 灾备入口」；`db:check` / `db:migrate` 只接受测试库。
- dry-run 报 `newer-than-code`（库里记账版本高于代码支持的上限）时，真执行会被拒绝；先核对是否连错库或代码版本过旧。
- **回滚**：auth 迁移只进不退，没有 down 脚本；真执行失败时整批在同一事务里回滚，不留半成品，修正原因后重跑即可。
  已成功执行后要撤回，只能按「生产收口的前置条件与顺序」第 2 步事先做好的完整备份整库恢复（Neon 上即执行前建的
  分支 / 时间点恢复），不要手工删表或删 `auth_schema_migrations` 记账行——旧版本应用在库新代码旧时仍能服务（闸门单向），
  通常向前修复比恢复更安全。

## 从零重建（全新空库，不连接生产）

先用隔离的空 PostgreSQL 测试库演练；上线时由运维改用已备份、经核对的目标库，不能把生产连接塞进 `TEST_DATABASE_URL`。以下命令都在仓库根目录运行，脚本不会自动加载 `.env*`：

```powershell
$env:DR_DATABASE_URL = '<隔离空库连接串>'
# 第一步：确认目标 host 和零业务表；dry-run 不写库。
npm run db:check:prod -- --database-url-env=DR_DATABASE_URL
npm run db:migrate:prod -- --database-url-env=DR_DATABASE_URL
# 第二步：先创建 0001–0003，auth 暂为 v4；随后分别升级 auth 到 v7、建 artifact schema。
npm run db:migrate:prod -- --database-url-env=DR_DATABASE_URL --apply
npm run migrate:auth:prod -- --database-url-env=DR_DATABASE_URL --dry-run
npm run migrate:auth:prod -- --database-url-env=DR_DATABASE_URL --yes-i-mean-production
npm run migrate:artifacts:prod -- --database-url-env=DR_DATABASE_URL --dry-run
npm run migrate:artifacts:prod -- --database-url-env=DR_DATABASE_URL --yes-i-mean-production
# 第三步：登记发布仓位（storage_repositories 一行）——不登记时 T8 worker 反查不到可写仓，启动即报错。
#   仓库键从 --repo/--branch 或环境变量 ZHAOSHU_BOOKS_REPO / DOWNLOAD_TARGET_BRANCH 读出（缺省 CitizenScyu/zhaoshu-books / main）。
npm run register:storage:prod -- --database-url-env=DR_DATABASE_URL
npm run register:storage:prod -- --database-url-env=DR_DATABASE_URL --apply
# 第四步：业务迁移、auth 版本、artifact schema 与必需表都通过只读复核（缺任一即退出码 2）。
npm run db:check:prod -- --database-url-env=DR_DATABASE_URL
Remove-Item Env:DR_DATABASE_URL
```

然后按 `.env.local.example` 的分组配置新的部署环境（密码与连接串只写入部署平台的私密配置，不写入仓库），运行 `npm run check:deploy` 核对样例键名覆盖，再部署应用；确认健康请求放行、owner 登录和负向权限生效后再开启流量。上述第二步不能倒序：auth 入口先运行会创建业务表，使空库迁移器拒绝未记账的既存库。`src/lib/runtime-tables-migration.pglite.test.ts` 在隔离 PGlite 真库验证 v4 闸门拒绝、升级 v7 后放行；`src/lib/cold-schema-rebuild.pglite.test.ts` 跑完整条链（业务迁移 → auth 5/6/7 → artifact → `db:check` 通过）。如果迁移失败，先核对错误并用事前整库备份/分支恢复，不手工删记账行。

### 重建后必须恢复的运行期设置（tempdb41 §缺陷 D2）

冷建库的 `auth_settings` 只有建表时的默认行：`members_enabled = false`、`registration_mode = 'closed'`
（`src/lib/auth-store.ts:141-148`）。生产既有状态是 `members_enabled = true` / `registration_mode = 'invite'`
（成员入口开着、仅凭邀请码注册）。**重建后若直接切流量，成员入口会「悄悄关闭」**。切流量前用 owner 账号在
「管理」页确认这两项，或按既有状态改回（改 `auth_settings` id=1 行；本仓没有专用 CLI，走管理页即可，
不要手写 SQL 绕过 CSRF/权限校验）。冷建库演练里为验收临时改过 `true`/`invite` 的话，注意这批设置不会随
数据回迁自动恢复，回迁后要再确认一次（`auth_settings` 不在重灌清单里，见下）。

### 重建后的数据重灌路径（tempdb41 §缺陷 D3）

结构齐了不等于有数据。冷建库后按下面三条重灌（每条都只写目标库；本仓脚本均不读 `.env*`）：

1. **书源 + 准入**：用 `scripts/build-shuyuan-refresh.mjs` 构建刷新运行器产物，放到目标机的运行目录，对目标库
   **连跑多轮**（每轮一次刷新 + 一次准入批次）。`ADMISSION_MAX_PROBES` 缺省 20（`.env.local.example` 该键注释：
   20 源最坏 ≈ 264s < 295s 平台上限，25 源会顶破），而一个满池约有 114 个 compile_ok 源需要真搜一遍，
   **所以一轮探不完，要跑到 `source_admission` 里 compile_ok 的行都被探过为止（经验值 ~6 轮）**。实测口径见
   `tempdb-41-report.md` §5.2：连跑 7 轮后 `shuyuan_sources` 1681 行、`source_admission` 164 行（search_ok 28）。
   刷新中途上游 `fetch failed` 会按设计中止并保留既有数据（rc=1），下一轮继续即可。
2. **打标书库**：把 `labels.jsonl` 类快照按时间顺序（新的覆盖旧的）用 `scripts/import_labels.mjs`（或目标机上的
   `import_one.py`）导入 `labeled_books`；导入是幂等 upsert（按身份键去重）。**只导入 jsonl 里有的行**——历史
   人工修过的作者/质量字段若没进 jsonl 就重建不出来。实测见 `tempdb-41-report.md` §5.3（本地 37 + 241 行、
   目标机 353 行快照 → 入库 299 行；Neon 上最后是 349 行，差的 50 行来自无本地账本的历史导入，回迁时合并）。
3. **账号 / 画像 / 书架 / 反馈**：**不可重建**。`users`（除固定 owner 行）、`sessions`、`registration_invites`、
   `profile`、`recommendations`、`feedback` 等都要等原库恢复后回迁合并；`download_tasks` 历史与
   `book_artifacts`（Neon 上已发布的书）同理——GitHub 上的文件还在，但新库没有登记行，离线读这些书在新库上
   暂不可用。完整清单见 `tempdb-41-report.md` §9。

owner 访问不依赖库里的行（靠部署平台的 `APP_OWNER_TOKEN`），所以 owner 口令重建后照常可用；
member 账号不存在，成员无法登录，需重新邀请或等回迁。


## 当前行为与开关

A04 迁移画像、找书、反馈、推荐、书架、统计与导出的全部 HTTP 方法到 `requirePermission(req, 'find')`。归属只使用服务端 principal.userId；owner 也只访问 userId=1 的个人记录。账号模式关闭时，旧 owner 头认证仍兼容，`/api/owner` 保持零数据库验证，业务查询仍按 userId=1 过滤。

`AUTH_ACCOUNTS_ENABLED` 默认 false；数据库 `auth_settings.members_enabled` 默认 false、`registration_mode` 默认 closed。A07 已交付注册、邀请码与管理界面（`POST /api/auth/register`、`/api/admin/*`）；部署闸门与成员总闸保持默认关闭，需 owner 在「管理」页显式开启后才生效，且所有管理接口仅 owner 可访问、写请求强制 CSRF 校验。

普通登录、注册和业务请求只校验当前 schema 版本（**v7**）。初始化业务表之前先校验版本，不在请求中删约束、改默认值或自动迁移。旧版本、未知较新版本或缺版本表均不能静默降级到全局查询，也都不能绕过版本闸门执行写操作。

## 隔离库预检与执行

连接必须由外部显式提供为 `TEST_DATABASE_URL`；脚本不读取环境文件，也不回退 `DATABASE_URL`。没有测试连接时退出码为 2。未知或空 case 退出失败，不空跑成功。

```powershell
npm run migrate:auth -- --check
npm run migrate:auth
npm run test:auth-db -- --case=personal-migration
npm run test:auth-db -- --case=personal-isolation
```

预检输出版本、实际约束名称、索引及默认值，不输出连接串、凭据或个人正文。迁移事务使用 advisory lock；v4 收口再锁定个人表，验证用户外键、非空归属、旧默认值及唯一性形态。它按 PostgreSQL 目录定位旧表级 UNIQUE(book_id, query) 和独立全局唯一索引，移除两者，保留用户复合唯一索引 (user_id, book_id, query)。recommendations/feedback 的 user_id 默认值被移除；profile.id 继续作为用户键，不新增第二套用户列。

迁移不修改既有书名、画像原文、种子、微秒版本、推荐、反馈或个人 ID。缺外键、孤立/不明确归属、未知全局唯一性、依赖旧唯一键的外键或意外默认值均要求人工核验，不能通过自动认领或删除记录解决。

专用测试 case 在本次创建的随机 a04_ schema 内建立夹具，结束时只清理自己的 schema；不会清空 public。历史 v3 夹具保存自基点 1311b36。测试覆盖重命名约束、重复/并发迁移、冷启动、缺省 userId 拒绝、A/B/owner 隔离、同用户与跨用户 CAS、真实只读一致快照及授权撤销竞争。

## 最终写入、预算与取消

每个请求先建立自己的 deadline，再认证、读取正文和业务数据。模型重试、原会话复核、写回与结果处理共享剩余预算；找书的三个 step 各自拥有一个独立预算。SSE 保留原有 phase/progress/result 与 token/done/conflict/error 契约，返回 private/no-store，不在发送响应头后提前销毁预算。

写回前绕过请求内身份缓存，重新核验原会话、启用状态与 find 权限。写事务开始和结束时再次核验有效会话与请求截止时间，并持有用户、会话及成员闸门的 SHARE 行锁。撤销先完成则拒写；写事务先持锁时撤销等待其完成，因此不存在复核与提交之间的无保护窗口。statement_timeout 与业务 SQL 在同一个 Neon HTTP 非交互事务中设置。

取消信号按请求传递到认证、模型和写事务。取消发生在模型等待、前置读库或提交前时，不再发起后续业务写入；取消 HTTP 等待不能证明已经提交到 PostgreSQL 的事务被撤销。调用方必须区分“客户端已退出等待”和“数据库已回滚”，不能把 abort 当成撤销承诺。

## 统计与导出契约

stats 返回 subject.userId、allowedSections、sectionStates 和 sectionScopes。找书/书架是本人计数，书库是共享计数；书源只对 download 能力开放并标为共享。书源计数（task-24 起口径）：enabled/disabled 看启停开关（disabled_at），unprobed/pending/reachable/failed 看探测快照，两者正交；active 是兼容字段，仅计「启用且最近探测可达」，不能用未禁用数量填充，界面不展示该字段。无权限为 forbidden，允许但未建设完成为 not_ready，查询失败才是 unavailable；前两者不混入数据库错误聚合。

现有用量表没有用户归属，保留为仅 owner 可见的全站共享运营计数，不冒充个人用量，也不向 member 输出。下载任务归属仍属 A05：当前统计与导出都不读取全局下载任务；有 download 能力时显式标为 not_ready，否则为 forbidden。

导出 formatVersion=2，注明 subject.userId，保留 profile/seeds/books/recommendations/feedback/labeled_books 等关键字段。只包含本人记录及它们引用的 books；labeled_books 为共享元数据。五组读取处于 RepeatableRead、readOnly 同一事务，不导出认证表、会话、密码哈希、口令、邀请码或连接配置。

## 生产收口的前置条件与顺序

本批只执行隔离库演练，不执行生产迁移。生产操作须由主会话另行安排受控连接和维护窗口，不能把生产连接冒充 TEST_DATABASE_URL；生产迁移用上文的 `migrate:auth:prod`，业务 schema 用 `db:check:prod` / `db:baseline:prod` / `db:migrate:prod`（`docs/migrations.md`；生产库从未登记过业务迁移，先走 `db:baseline:prod` 只补记账）。

1. 停止旧写入口、离线旧脚本与旧部署实例，排空在途事务。仅关闭账号开关不够：旧 owner 写入口和旧冷启动 DDL 也必须停用。
2. 对生产数据库制作包含全部 schema、表、序列、约束和认证设置的完整一致备份；记录恢复时间点。在另一隔离恢复库执行完整恢复并核对 ID、行数、微秒版本及外键。只备份几张个人表或只导出 JSON 不能替代完整备份。
3. 只读预检真实版本、约束、索引、默认值及用户归属；结构漂移或归属不明时先停止迁移并核验。
4. 按已验收的专用迁移事务升级到当前版本（**v7**），再切换至完整应用代码；校验版本、owner 个人访问、负向权限及一致快照后恢复流量。顺序颠倒（先切代码后迁移）会让全站 503。
5. 保持注册和成员闸门关闭，直到 A05–A08 的权限、归属、入口和回退验收完成。
6. v6 之后仍待真库验收的项：`/api/auth/register` 的 CTE 原子性（同码 20 路并发仅一人成功、用户名冲突不耗码、关闭/作废先提交则注册失败）与邀请码消费的并发排序。本批只有 SQL 文本断言与桩测试，未跑真库。

最低兼容回退版本必须包含完整 A04 的用户过滤和 v4 只读版本守卫。本批 32.1/32.2 中间提交与基点 1311b36 都不是 v4 迁移后的安全回退点：旧冷启动可能重建全局唯一索引。出现问题时应向完整 A04 上的修复版本前进，或在维护窗口按验证过的整库恢复方案回退；成员数据产生后还需保留新增数据，不能承诺关闭开关即可撤销迁移。

## 并行任务衔接

任务 24 与本批重叠 stats/route.ts 及其测试。合并时保留本批的可信用户过滤、权限分区和错误分类，同时保留任务 24 的书源未探测/待核验/禁用状态语义，不把未禁用计为健康；不要用某一方的整文件覆盖另一方。

A05 需要给下载任务建立可信归属，再实现本人下载统计/导出，并衔接共享 TXT 的 read 权限访问。本批只在推荐列表中按 read 能力输出最小共享定位 read_task_id；其余未迁移端点继续保留原受限入口。
