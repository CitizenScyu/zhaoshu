# 本地验证指南（最短可复现）

目标：不加载真实凭据、不连真实数据库，在本地把测试与构建跑通。针对贡献者/接手会话，不是部署文档（部署见 `docs/auth-deployment.md`）。

## 前置

- Node 22.x（与 `package.json` `engines.node` 一致；仓内脚本用 `node --experimental-strip-types`）。
- 依赖按项目环境准备（`npm install` 或既有的共享依赖链接均可；若当前工作树已有共享依赖链接，不覆盖它即可）。
- **环境隔离**：所有本地验证先在「无生产 `.env*` 文件、且不继承生产环境变量的隔离工作副本/终端」进行。工具链只关掉自动加载，不会清除父进程已继承的变量——隔离要靠工作副本/终端本身。

## 测试与检查命令（来自 `package.json` scripts）

| 命令 | 用途 |
| --- | --- |
| `npm test` | vitest 全量（`vitest run --no-file-parallelism`） |
| `npm test -- src/lib/rule-engine/api.test.ts` | 单文件 vitest（最快冒烟） |
| `npm run test:scripts` | `scripts/` 下 .mjs 测试（不在 `npm test` 内） |
| `npm run test:py` | Python unittest（需可用 Python 解释器，不在 `npm test` 内） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run check:deploy` | 部署配置与 `.env.local.example` 键完整性检查 |
| `npm run test:contracts` | worker 契约检查（**可选**：默认读兄弟仓 `../zhaoshu-books/worker.mjs`，需另一个 checkout 前置；不在 `npm run check` 内） |
| `npm run check` | 串联总入口（typecheck+lint+check:deploy+test:scripts+test:py+test+build） |
| `npm run build` | `next build` |

`db:*:prod` / `migrate:*:prod` 系列操作生产库，本地验证**不要**执行。

## 测试与凭据

- `vitest.config.ts` 的 `envDir: false` 只关闭 Vitest 对 `.env*` 的自动加载；它不清除父进程 `process.env`。运行时防护靠用例内 `vi.stubEnv(...)` 提供合成值（如 `AUTH_ACCOUNTS_ENABLED`、`APP_OWNER_TOKEN` 假值）与隔离终端的配合，不是工具自动完成的。
- 配置给所有测试注入 `SHUYUAN_READ_CACHE_TTL_MS=0`（关闭池读缓存，避免用例间串数据）。
- 因此：跑 `npm test` 不需要 `.env.local`；需要数据库的测试用内存 PGlite（如 `artifact-registry.pglite.test.ts`），不连 Neon。
- `npm run build`（next build）**会**加载其目录下对应 `.env*`——这是它与 Vitest 行为的差别，也是前置一节要求隔离副本的原因。
- `.env.local.example` 只服务本地 `npm run dev`（README 本地开发节），与测试无关。

## 建议的最小验证序列

```bash
npm test -- src/lib/rule-engine/api.test.ts   # 快速冒烟
npm run typecheck                             # 类型门禁
npm run lint                                  # lint 门禁
npm test                                      # 全量（较慢）
npm run build                                 # 构建门禁（最重，注意 .env 加载）
```

按改动面裁剪：只改单模块时至少跑「单文件冒烟 + typecheck + lint」；集成/合并前跑全量与 build。

## 本文档的验证状态

- 以上命令与配置事实核对自本仓 `package.json`、`vitest.config.ts`、`scripts/check-worker-contract.mjs`、`scripts/check-env-example.mjs`。
- 本提交仅实跑过单文件冒烟 `npm test -- src/lib/rule-engine/api.test.ts`（89 项通过）；其余命令未逐条执行，本文档不声称其通过。
