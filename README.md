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
cp .env.local.example .env.local   # 填好五个变量
npm install
npm run dev
```

开发环境默认服务在 http://localhost:3000。所有 `/api` 路由都要求 owner 认证（`APP_OWNER_TOKEN`）：浏览器右上角填入同一口令后存在 localStorage，请求带 `Authorization: Bearer <token>` 或 `X-Owner-Token`；未配置时接口返回 503，口令不符返回 401。

## 部署到 Vercel

1. 推到 GitHub 私有仓库
2. 在 Vercel 项目里通过 Marketplace 的 Neon 集成创建数据库（免费档），自动注入 `DATABASE_URL`
3. Vercel 导入仓库，配 Environment Variables（同 `.env.local.example` 五项：数据库连接串、owner 口令、LLM 三件套）
4. （推荐，国内直连）把 `find.cloud.us.kg` 之类子域 DNS-only CNAME 到 `cname.vercel-dns.com`，在 Vercel 项目里 Add Domain

注意：Hobby 档 Fluid Compute 单函数上限 300s，流水线已拆为 recall / verify / rerank 三步由前端分步调用（各 Route Handler 声明 `maxDuration = 295`；LLM 侧默认总超时 280s、空闲超时 60s，可用 `LLM_TOTAL_TIMEOUT_MS` 覆盖）。

## 路线图

- [x] MVP：LLM 召回 + 豆瓣验证 + 画像 + 反馈闭环
- [ ] V2 验证增强：豆瓣未命中时，借鉴开源阅读（Legado）书源的站点搜索 URL 模板，对起点/番茄等站直接做存在性验证（书源规则引擎本身不接，只借 URL 模板——书源只解决元数据，不解决口碑）
- [ ] V2 召回增强：历史推荐去重、同好书单聚合
- [ ] V3：本地已读书 TXT 向量化，"和我爱的那本文风最像"的语义检索（参考 INovelRec 架构）
