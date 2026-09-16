# 第十一批：覆盖丢失审计

审计基点 `f054ffd`。范围包括全部应用写路由、前端持久化、认证与下载 worker 的状态写入，以及离线书库维护脚本。未连接生产数据库，未调用生产应用写接口。

判定模板：A 已保存的用户输入，被 B 的旧/空快照全量替换，缺少版本检查和变更记录，失败时还可能清空草稿。只读评估项保留现有存储方式。

## 审计矩阵

| 写入或存储位置 | 现状与判定 | 本批处理 / 不修改的理由 |
| --- | --- | --- |
| `PUT /api/profile`；`src/app/api/profile/route.ts`、`src/lib/db.ts` | 种子和正文整体保存。基点实际已有 `updated_at::text` CAS，并非无锁；仍缺少移除确认和种子变更审计，人工采用新版本后可误删大量种子。 | 普通保存、保存修订、冲突合并及生成前保存均检查移除项，显示书名与前后数量；服务端要求 `confirmSeedRemoval`，确认不能绕过版本检查。`profile_seed_audit` 与 CAS 在同一 SQL 语句提交，保存增删书名和前后种子快照；审计失败整体回滚。原始微秒版本不转 `Date`，冲突返回 409、线上快照及草稿。 |
| `POST /api/profile`；`ProfileTab.tsx`、`profile-draft.ts` | 生成前 PUT 与生成完成写回均已有 CAS；慢生成不能覆盖中途保存的画像。草稿在当前页面内存中，失败分支未清空。 | 保留并回归 CAS/SSE；给生成前 PUT 加同一移除确认。切标签保留草稿；浏览器刷新、离开整个应用、退出/换口令仍会结束内存草稿，属于未提交数据的寿命，不承诺永久保存。新增审计不能恢复部署前已被覆盖的种子。 |
| `POST /api/feedback`；`src/lib/feedback-store.ts`、`FeedbackForm.tsx` | 旧实现追加历史而非删除旧 note，但切换状态提交空 note、晚到的旧表单和无版本的 recommendations 状态更新会掩盖已保存内容，命中同类覆盖风险。 | 未传 note 时继承最新 note；最新反馈 id 作为版本（0 只允许首次创建）。事务先锁定稳定的书籍行，再检查最新 id，随后追加反馈并更新书架状态；丢失 CAS 返回 409 和最新反馈。缩短/清空需客户端确认且服务端验旗标；失败/冲突保留表单，先对比再继续。反馈历史本身是追加审计，不新增业务表。 |
| 反馈自动回写画像；`src/app/api/feedback/route.ts` | 模型只按读取时的画像版本 CAS，冲突时放弃自动更新，已保存的反馈不撤销。 | 保留这一最佳努力语义，回归流截断、取消、无效模型输出、超时及并发画像修改；不会无版本重试覆盖。 |
| 书架数据；`src/app/api/recommendations/route.ts`、`src/lib/db.ts` | **已在数据库**：`books` 保存作品身份，`recommendations` 保存书架条目/状态，`feedback` 保存原因及历史。ShelfTab 的 React 状态只是显示副本，没有书架 localStorage。 | 新读取同时带反馈版本，按用户和最大反馈 id 取当前原因。清浏览器缓存/换设备不会删除 DB 书架；同一 owner 重新验证即可读回。没有新增书架表或迁移数据。现有 `/api/export` 可备份；是否增加软删除/归档由用户决定。 |
| `POST /api/shelf`、`DELETE /api/shelf`；`ShelfTab.tsx` | 添加单本书，不提交整个书架快照；移除指定推荐 id，已有二次点击确认。删除推荐不会级联删除 books 或 feedback。 | 不命中全量覆盖模式，保留现状。移出书架会删除该推荐条目本身，但反馈历史仍在 DB；用户如需保留全部曾移出条目，可另定归档功能，本批未实施。 |
| 最近查询；`FindTab.tsx` 的 `novel-finder-recent-queries` | **仅本地浏览器，最多 6 条**。不同标签页的内存 historyCache 未合并，可能用旧列表覆盖新历史；清缓存/换设备无法保留。成功推荐的 query 另有 DB 记录，但不构成完整搜索历史。 | 按任务明确要求只读评估，不修改/建表。短列表属于便利功能，入库价值低于阅读进度；若要同步，应按条追加/去重并提供清除权限，而不是同步整个数组。 |
| 阅读进度；`reader/useReader.ts`、`reader-preferences.ts` | **仅 localStorage**。同一本书双标签页最后一次写入（包括旧页退出）可能回退位置；清缓存/换设备不会同步；凭据切换不会清除这些本地键。 | 25.1 必要改动仅扩展来源隔离：保留原 TXT key，书源按源和作品标识另存。按任务要求不做进度入库。跨设备续读有较高价值，建议未来按用户/作品/来源/版本保存并防旧写覆盖；是否实施由用户决定。 |
| 阅读设置；`reader-preferences.ts`、`useReader.updateSettings` | 字号、主题等是本地展示偏好，整个对象保存。跨标签页可能覆盖其他页的偏好；写入失败会显示保存受限提示，当前选择不被清空。 | 不命中业务文本保存失败丢草稿链。属于可重设的显示偏好，暂不入库、不新增审计表；已把跨标签覆盖限制列明。 |
| `/api/shuyuan` refresh；`src/lib/shuyuan.ts` | DELETE+INSERT、meta 更新在同一事务中；表锁之后核对 refreshed_at 和禁用/错误快照，事务失败保留旧表。 | 确认无回归。既有事务/规则变化/失效状态测试继续全绿；在线阅读只读来源状态，不会把未探测来源当作“已可达”，也不会因暂时失败自动禁用或覆盖合集。 |
| `download_tasks` API；`src/app/api/download/route.ts` | 建任务是 INSERT；回收仅命中超时 running；取消/清理仅能原子删除 pending/failed，不能删除 running/done。 | 不命中旧状态整表回写模式。保留已有状态谓词。并发创建同一作品仍可能产生不同任务 id 的重复工作，这属于防重范围，不是旧快照覆盖用户输入，本批不扩展下载状态机。 |
| 下载 worker；`zhaoshu-books/worker.mjs`、`task-heartbeat.mjs` | `FOR UPDATE SKIP LOCKED` 领取；进度、心跳、完成和失败全部要求原任务仍为 running；重试创建新 id，旧 worker 不复活已回收任务。 | 只读核验既有保护，未修改 worker 仓库。任务中止、源策略及 worker 契约检查继续覆盖。 |
| 认证表；`auth-store.ts`、`auth-session.ts`、`auth-rate-limit.ts` | 初始化 `ON CONFLICT DO NOTHING`；历史迁移只补 NULL user_id。会话创建用用户级事务锁，删除特定 token 或过期/超额会话；限流在 DB 原子递增。没有客户端整份用户/权限快照回写路径。 | 不命中。保留迁移、会话和限流测试；未增加认证迁移或修改权限。owner 凭据验证失败保留旧口令，凭据切换会中止旧请求并卸载内存私有页面。 |
| 找书持久化及作品 upsert；`src/lib/db.ts` | books 的 meta 合并，空反馈元数据不会清空已有属性；recommendations 冲突只更新模型排序字段，不更新用户状态，也不改 feedback。 | 不命中用户输入丢失模式。模型输出仍可能刷新旧推荐解释，是派生数据的预期更新，不作为用户手写内容。 |
| 书库离线维护；`scripts/import_labels.mjs`、`backfill_authors.mjs`、`backfill_quality.mjs` | 标签/质量是离线模型派生数据；导入按作品重算标签，保留空来源/缺失质量的旧值。作者回填有 dry-run 清单、旧值条件与事务保护。 | 不命中画像/笔记这类用户输入丢失链；未运行维护脚本写库。并行派生任务的结果先后仍需在后续任务版本化，不能把这些脚本视为个人书单备份。 |
| 导出、统计、用量记录；`/api/export`、`/api/stats`、`recordLlmUsage` | 导出只读一致性快照；统计只读聚合；用量是追加记录。 | 不存在客户端旧/空快照全量覆盖。保留既有接口。 |
| 本批书源目录与正文缓存；`source-reader.ts` | 目录以包含来源、规则及章节清单的哈希版本作主键；冲突只延长 TTL，不覆盖 payload。正文只在进程中按需短存并限制数量/体积。 | 缓存是可失效的派生数据，不是书架/进度存档；过期重新加载可重建。源停用/规则变化在每次章请求时复核，不能用暖缓存绕过。 |

## 数据库变更与验证边界

- 新表只有 `source_read_catalogs`（24 小时目录缓存）和 `profile_seed_audit`（种子变更历史），都在 `ensureSchema` 中以运行时幂等 DDL 创建；没有为书架、搜索历史、阅读进度新建表，没有新增既有表结构变更。
- 新种子审计保存前后完整种子 JSON，增删书名按作品身份做多重集合差，重复种子的删除也可查到。审计数据应随常规数据库备份保留；没有新增面向普通访客的读取接口。
- `scripts/check-profile-audit.mjs` 与 `scripts/check-feedback-cas.mjs` 直接提取应用 SQL，在内存 PostgreSQL（PGlite）执行，覆盖旧版本拒绝、同版本单一胜者、审计/书架状态失败回滚及用户隔离。此验证不等同于实际 Neon 多连接压力测试。
- `scripts/check-batch25-ui.py` 只允许 localhost，拦截所有 API 和外部资源，在桌面和手机宽度验证入口、续读、确认、失败草稿与冲突合并；不会触及生产写接口。
