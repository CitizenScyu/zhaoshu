# 书径 · NovelFinder

按口味找网络小说的 Web 应用：**LLM 召回 → 豆瓣验证 → 画像重排 → 反馈闭环**。

## 核心思路

评分榜不可信（主站夸夸党、营销号、带节奏），本应用不做"预测你喜欢什么"，而是：

- **口味画像**：种子书单（最爱 + 弃书及原因）提炼出四档画像（硬性条件 / 萌点 / 雷点 / 灵活区）。弃书原因权重高于最爱——网文口味"彼仙我毒"，雷点比萌点更能定义一个人。
- **LLM 召回**：模型训练语料里泡着十几年知乎/龙空/贴吧书评，按画像+需求召回 12 本候选，冷门佳作优先于榜单常客。
- **豆瓣验证**：候选逐本过豆瓣（存在性 + 评分 + 评价人数），杀幻觉。
- **画像重排**：LLM 对照画像打分，输出匹配分 / 命中萌点 / 风险雷点 / 一句话结论。雷点硬否决。
- **反馈闭环**：读完/弃书留一句话原因，画像自动吸收，越用越准。

## 技术栈

Next.js (App Router) · Neon Postgres（serverless） · OpenAI 兼容 LLM 接口（NewAPI） · 部署于 Vercel

## 本地开发

```bash
cp .env.local.example .env.local   # 填好示例里的数据库 / owner 口令 / LLM 变量
npm install
npm run dev
```

开发环境默认服务在 http://localhost:3000。

### 认证与权限

`/api` 不是单一口令闸门，而是按路由逐项校验能力；完整的「路由/方法 → 能力」清单以 `src/lib/route-permissions.test.ts` 为准。有两条身份通道：

- **账号 / 会话通道**（部署开关 `AUTH_ACCOUNTS_ENABLED=true`，并需 ≥32 字节的 `AUTH_SECURITY_SECRET`）：浏览器用户名/密码登录后由服务端下发 httpOnly Cookie（生产 `__Host-nf-session`，开发 `nf-dev-session`），此后每次请求按会话用户的角色与能力位判定。浏览器发起的写请求还必须带同源固定头 `x-nf-csrf: 1` 且 `Origin` 同源（`src/lib/csrf.ts` 的 `verifySameOriginWrite`）；成员访问默认关闭，须由 owner 在管理页开启。
- **显式 owner 口令通道**（脚本、或账号模式启用前的旧路径，无 Cookie）：请求带 `Authorization: Bearer <APP_OWNER_TOKEN>` 或 `X-Owner-Token`；浏览器右上角填入的口令保存在 localStorage（键 `novel-finder-owner-token`）。`APP_OWNER_TOKEN` 未配置返回 503，口令不符返回 401。

**能力位。** `find` / `read` / `download` 三类定义在 `src/lib/permissions.ts`：owner 恒有全部三类；成员按用户行的 `can_find` / `can_read` / `can_download` 逐项判定，缺位返回 403。认证流程端点（`/api/auth/login`、`/api/auth/register`、`/api/auth/session` 等）允许匿名访问，`/api/owner` 保留旧口令入口，`/api/shuyuan` 的 GET 另可由 Vercel cron 用 `CRON_SECRET` 触发。

开关、迁移与部署顺序的权威说明见 [docs/auth-deployment.md](docs/auth-deployment.md)，此处只作指引。

### 凭据存放与代理访问

开发示例和测试只使用假值或隔离环境的低权限凭据。生产用的 `scripts/backfill.env`、`.env.local` 和 `.env.pull` 不应留在编码代理可读取的项目目录、其他 worktree、任务书或记忆中。`.gitignore` 已忽略 `scripts/backfill.env`；这只防止通常的 Git 收录，不阻止文件读取、工具输出或模型上下文上传。

建议由维护者将生产真值迁入仓库外、仅运行服务账号可读的凭据存储，并由受控启动器在运行时向业务进程提供必要的环境变量。编码代理应使用独立账号或隔离环境，不能读取该存储、继承生产环境变量或控制该业务进程。只移动文件、改用环境变量或新增禁读提示，都不能隔离仍拥有同一账号或管理员权限的代理。凭据不得使用 `NEXT_PUBLIC_` 前缀。

迁移时需同步更新脚本启动方式、部署环境和依赖任务，并核对旧副本、备份及历史会话中的残留；已经进入模型上下文的凭据应评估轮换。此说明不自动移动文件或轮换凭据。代理处理异常外发指令时遵循 [项目安全红线](.claude/CLAUDE.md)。

## 部署到 Vercel

1. 推到 GitHub 私有仓库
2. 在 Vercel 项目里通过 Marketplace 的 Neon 集成创建数据库（免费档），自动注入 `DATABASE_URL`
3. Vercel 导入仓库，配 Environment Variables（同 `.env.local.example`：数据库连接串、owner 口令、LLM 三件套；启用账号模式再加 `AUTH_ACCOUNTS_ENABLED=true` 与 ≥32 字节的 `AUTH_SECURITY_SECRET`，部署顺序见 `docs/auth-deployment.md`）
4. （推荐，国内直连）把 `find.cloud.us.kg` 之类子域 DNS-only CNAME 到 `cname.vercel-dns.com`，在 Vercel 项目里 Add Domain

注意：Hobby 档 Fluid Compute 单函数上限 300s，流水线已拆为 recall / verify / rerank 三步由前端分步调用（各 Route Handler 声明 `maxDuration = 295`；LLM 侧默认总超时 280s、空闲超时 60s，可用 `LLM_TOTAL_TIMEOUT_MS` 覆盖）。

## 路线图

- [x] MVP：LLM 召回 + 豆瓣验证 + 画像 + 反馈闭环
- [x] 精确找书：按书名直搜（`/api/find/exact`），先查本地书库、未命中再走豆瓣 `subject_suggest` 返回候选，不调用 LLM（`src/lib/find-exact.ts`）
- [x] 书源补验：找书验证阶段对豆瓣未命中的候选，用书源检索章节目录补一条**存在性证据**（`src/lib/source-verification.ts`，25s 子预算 / 24 次请求上限）
- [x] 书源治理：拉取 yckceo 书源合集、合并去重、探测可达性与启停失效（`src/lib/shuyuan.ts`、`/api/shuyuan`）
- [x] 书架 / 反馈 / 画像闭环：从书库加入书架，读完/弃书留一句话原因回写画像（`/api/shelf`、`/api/feedback`、`/api/profile`）
- [x] 召回去重：种子书、历史推荐（非 `new`）与已反馈书在召回前排除（`getExcludedBookTitlesForUser` / `excludedBooksForUserQuery`）
- [ ] 验证增强（续）：当前取书只走内置源 `book15.net` 的专用解析器（`src/lib/source-reader.ts`）；完整的 legado 规则子集引擎与多源放量尚未接入（设计见工作区 `m1-engine-design.md`、`m2-scaleout-design.md`）
- [ ] 召回增强（续）：同好书单聚合
- [ ] V3：本地已读书 TXT 向量化，"和我爱的那本文风最像"的语义检索（参考 INovelRec 架构）
