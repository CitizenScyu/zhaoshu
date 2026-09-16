# A04 个人数据隔离与 schema v4 交付

## 当前行为与开关

A04 迁移画像、找书、反馈、推荐、书架、统计与导出的全部 HTTP 方法到 `requirePermission(req, 'find')`。归属只使用服务端 principal.userId；owner 也只访问 userId=1 的个人记录。账号模式关闭时，旧 owner 头认证仍兼容，`/api/owner` 保持零数据库验证，业务查询仍按 userId=1 过滤。

`AUTH_ACCOUNTS_ENABLED` 默认 false；数据库 `auth_settings.members_enabled` 默认 false、`registration_mode` 默认 closed。本批不新增注册、邀请码或登录界面，也不开放成员入口。后续批次未完成前不得开启成员闸门。

普通登录和业务请求只校验 schema v4。初始化业务表之前先校验版本，不在请求中删约束、改默认值或自动迁移。v3、未知较新版本或缺版本表均不能静默降级到全局查询。

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

stats 返回 subject.userId、allowedSections、sectionStates 和 sectionScopes。找书/书架是本人计数，书库是共享计数；书源只对 download 能力开放并标为共享，active 仅表示未停用，不等于验证健康。无权限为 forbidden，允许但未建设完成为 not_ready，查询失败才是 unavailable；前两者不混入数据库错误聚合。

现有用量表没有用户归属，保留为仅 owner 可见的全站共享运营计数，不冒充个人用量，也不向 member 输出。下载任务归属仍属 A05：当前统计与导出都不读取全局下载任务；有 download 能力时显式标为 not_ready，否则为 forbidden。

导出 formatVersion=2，注明 subject.userId，保留 profile/seeds/books/recommendations/feedback/labeled_books 等关键字段。只包含本人记录及它们引用的 books；labeled_books 为共享元数据。五组读取处于 RepeatableRead、readOnly 同一事务，不导出认证表、会话、密码哈希、口令、邀请码或连接配置。

## 生产收口的前置条件与顺序

本批只执行隔离库演练，不执行生产迁移。生产操作须由主会话另行安排受控连接和维护窗口，不能把生产连接冒充 TEST_DATABASE_URL。

1. 停止旧写入口、离线旧脚本与旧部署实例，排空在途事务。仅关闭账号开关不够：旧 owner 写入口和旧冷启动 DDL 也必须停用。
2. 对生产数据库制作包含全部 schema、表、序列、约束和认证设置的完整一致备份；记录恢复时间点。在另一隔离恢复库执行完整恢复并核对 ID、行数、微秒版本及外键。只备份几张个人表或只导出 JSON 不能替代完整备份。
3. 只读预检真实版本、约束、索引、默认值及用户归属；结构漂移或归属不明时先停止迁移并核验。
4. 按本批已验收的专用迁移事务升级到 v4，再切换至完整 A04 代码；校验版本、owner 个人访问、负向权限及一致快照后恢复流量。
5. 保持注册和成员闸门关闭，直到后续 A05–A08 的权限、归属、入口和回退验收完成。

最低兼容回退版本必须包含完整 A04 的用户过滤和 v4 只读版本守卫。本批 32.1/32.2 中间提交与基点 1311b36 都不是 v4 迁移后的安全回退点：旧冷启动可能重建全局唯一索引。出现问题时应向完整 A04 上的修复版本前进，或在维护窗口按验证过的整库恢复方案回退；成员数据产生后还需保留新增数据，不能承诺关闭开关即可撤销迁移。

## 并行任务衔接

任务 24 与本批重叠 stats/route.ts 及其测试。合并时保留本批的可信用户过滤、权限分区和错误分类，同时保留任务 24 的书源未探测/待核验/禁用状态语义，不把未禁用计为健康；不要用某一方的整文件覆盖另一方。

A05 需要给下载任务建立可信归属，再实现本人下载统计/导出，并衔接共享 TXT 的 read 权限访问。本批只在推荐列表中按 read 能力输出最小共享定位 read_task_id；其余未迁移端点继续保留原受限入口。
