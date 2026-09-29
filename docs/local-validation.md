# 本地验证指南（最短可复现）

目标：不动真实凭据、不连真实数据库，在本地把测试与构建跑通。针对贡献者/接手会话，不是部署文档（部署见 `docs/auth-deployment.md`）。

## 前置

- Node ≥ 22（本仓脚本用 `node --experimental-strip-types`，旧 Node 不支持）。
- 依赖已安装（本仓各 worktree 的 `node_modules` 是指向主 checkout 的 junction，**禁 `npm install`**，见根 CLAUDE.md）。

## 测试与检查命令（来自 `package.json` scripts）

| 命令 | 用途 |
| --- | --- |
| `npm test` | vitest 全量（`vitest run --no-file-parallelism`） |
| `npm test -- src/lib/rule-engine/api.test.ts` | 单文件 vitest（最快冒烟） |
| `npm run test:scripts` | `scripts/` 下 .mjs 测试 |
| `npm run test:py` | Python 脚本测试（`scripts/run-py-tests.mjs`） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run check:deploy` | 部署配置与 `.env.local.example` 键完整性检查 |
| `npm run test:contracts` | worker 契约检查（`vite-node scripts/check-worker-contract.mjs`） |
| `npm run check` | 上述大部分的串联总入口（含 build，最重） |
| `npm run build` | `next build` |

`db:*:prod` / `migrate:*:prod` 系列操作生产库，本地验证**不要**执行。

## 测试不读真实凭据

- `vitest.config.ts` 显式 `envDir: false`：vitest 不加载任何 `.env*` 文件，单元测试只使用用例内显式 `vi.stubEnv(...)` 的合成值（如 `AUTH_ACCOUNTS_ENABLED`、`APP_OWNER_TOKEN` 假值）。
- 配置还给所有测试注入 `SHUYUAN_READ_CACHE_TTL_MS=0`（关闭池读缓存，避免用例间串数据）。
- 因此：跑 `npm test` **不需要**也不应该准备 `.env.local`；需要数据库的测试用内存 PGlite（如 `artifact-registry.pglite.test.ts`），不连 Neon。
- `.env.local.example` 只服务本地 `npm run dev`（README 本地开发节），与测试无关。

## 建议的最小验证序列

```bash
npm test -- src/lib/rule-engine/api.test.ts   # 快速冒烟
npm run typecheck                             # 类型门禁
npm run lint                                  # lint 门禁
npm test                                      # 全量（较慢）
npm run build                                 # 构建门禁（最重）
```

按改动面裁剪：只改单模块时至少跑「单文件冒烟 + typecheck + lint」；集成/合并前跑全量与 build。

## 本文档的验证状态

- 以上命令与配置事实直接核对自本仓 `package.json`、`vitest.config.ts`、`scripts/check-env-example.mjs`（提交见本文件所在提交）。
- 单文件冒烟 `npm test -- src/lib/rule-engine/api.test.ts` 已在本树实跑通过（见证据目录报告）。
- 其余命令（全量/构建/脚本测试）本提交未逐条实跑，数字以主协调台账（`CC-RECOVERY-20260929.md`）记录的绿色批次为准。
