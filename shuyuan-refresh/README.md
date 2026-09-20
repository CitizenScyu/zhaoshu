# shuyuan-refresh(phoenix 书源刷新运行器)

把仓库**同一份** `src/lib/shuyuan.ts` 的 `refreshShuyuan` 用 esbuild 打成单文件 ESM,部署到
phoenix 定时跑,写同一个生产库。落地背景与根因见 `D:/ClaudeCode/projects/zhaoshu/shuyuan-refresh-stall-36.md`。

## 构建

    node scripts/build-shuyuan-refresh.mjs

产出 `shuyuan-refresh/dist/refresh-runner.mjs`(+ `.sha256`)。构建后自查产物无内联凭据
(判据 `grep -cE "postgres://|ghp_|github_pat_|sk-"` = 0,minify 已剥离含 `sk-` 字样的源码注释)。

## 运行(phoenix)

systemd 单元见 `deploy/`。运行器读 env `DATABASE_URL`(取自 `/etc/zhaoshu-shuyuan/env`,
只含该一个键),缺失时只报键名。

    node refresh-runner.mjs            # 正式刷新(写库)
    node refresh-runner.mjs --dry-run  # 只读干跑(抓上游 + 合并去重,打印计数,不写库)

可选 env:`HEARTBEAT_FILE`(运行期每 25s 追加一行)、`WATCHDOG_MS`(超时告警并以码 2 退出)、
`STATUS_FILE`(失败时写 `refresh-failed` JSON,启动时清除)。

## 自测

    npx vitest run scripts/shuyuan-refresh/    # dry-run 计数口径 + 产物可加载/无凭据字面量

`src/lib/shuyuan.test.ts`(78 例)钉住「可见性改动不改变 refreshShuyuan 语义」。

## 与仓库共享的改动(仅可见性,零逻辑)

`src/lib/shuyuan.ts` 里把 `INDEX_URL`/`LATEST_COUNT`/`fetchText`/`parseIndex`/`sameRules`/
`normalizeUrl`/`cleanJson` 由非导出改为 `export`,供 dry-run 复用同一抓取语义。函数体逐字未动。
