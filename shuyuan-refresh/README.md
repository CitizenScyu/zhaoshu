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

## 源准入探测(admrunner42,phoenix runner `--admission`)

同一份打包产物加 `--admission` 参数即跑一轮源准入探测:领 `cron_health.admission_lease` 租约 →
读 `shuyuan_sources` → 与 Vercel 独立轮同一条流水(`admitRows`)→ 写 `source_admission`。
差别:探得 ok 的行 `error='phoenix_ok:'`(phoenix 出网能搜到、Vercel 未确认),**不入池**
(池谓词全部 `... AND (error IS NULL OR error NOT LIKE 'phoenix_ok:%')`),由 Vercel 下一轮按 20h 窗
class 1 复测:ok 洗掉前缀进池、失败直接写真实 verdict。runner 不发布源池产物(pool-artifact timer 每 30 分钟自会生成)。

单元:`deploy/zhaoshu-admission.service` + `deploy/zhaoshu-admission.timer`(每小时一轮,`*-*-* 00/1:17:00 UTC`,与 `deploy/phoenix/` 副本逐字同频)。
env:`ADMISSION_MAX_PROBES=80`、`ADMISSION_PROBE_CONCURRENCY=8`、`ADMISSION_LEASE_TTL_MS=900000`(须 ≥ `WATCHDOG_MS=900000`;现网另有 drop-in 70-scan5.conf 提升到 120/8)。
预算 = `ADMISSION_BUDGET_MS`(缺省 `WATCHDOG_MS` − 30s;再缺省 240s)。

部署(主会话另行执行;先 `node scripts/build-shuyuan-refresh.mjs`):

    scp shuyuan-refresh/dist/refresh-runner.mjs phoenix:/opt/zhaoshu-shuyuan-refresh/refresh-runner.mjs
    scp shuyuan-refresh/deploy/zhaoshu-admission.service shuyuan-refresh/deploy/zhaoshu-admission.timer phoenix:/etc/systemd/system/
    ssh phoenix 'systemctl daemon-reload && systemctl start zhaoshu-admission.service && journalctl -u zhaoshu-admission -n 20 --no-pager'
    # 一行 {"mode":"admission",...} 且退 0 后再开定时器:
    ssh phoenix 'systemctl enable --now zhaoshu-admission.timer && systemctl list-timers zhaoshu-admission.timer'

注意:同一份 `refresh-runner.mjs` 也被 refresh/pool-artifact 单元用,换包即三者同时升级(打包产物向后兼容,无参数照常刷新)。
须与含本改动的 Vercel 部署**同批**上线:旧 Vercel 代码的池谓词不认前缀,会把 `phoenix_ok:` 行直接当在池 ok。

准入写围栏(fencecore42,901971c 起):每轮领取租约时原子递增 `cron_health.lease_generation`,
最终写库在同一事务里校验代次+锁后有效期,旧轮迟到写整批拒绝(`{"skipped":"lease_lost","written":0}`)。
数据库没有该列时 fail-closed(每轮 `{"skipped":"lease"}`,准入零推进):应用内的运行期 DDL
(`initializeBusinessSchema` 同款 `ADD COLUMN IF NOT EXISTS`,属惰性 schema 初始化,应用走到该
初始化时补列、不要求迁移先行,但不保证每次启动都执行)可能已补列;
要按迁移记账收口,则先 `db:baseline:prod`(只登记 v1–v3)再 `db:migrate:prod --apply` 补 v4,
步骤与预期输出见 `docs/migrations.md`「生产执行顺序」。

回滚(= 回到现状:Vercel 两轮 + 20h/7d 窗):

    ssh phoenix 'systemctl disable --now zhaoshu-admission.timer'

关掉后不需要清库:已写的 `phoenix_ok:` 行留池外,由 Vercel 轮在 20h 窗内自然洗掉或改判。
若还要退代码,回滚打包产物 + Vercel 部署到改前提交即可(前缀行在旧代码下会被当 ok 入池——先等 20h 让 Vercel 洗完再退)。
退代码前先停**全部**准入触发入口(本 timer、Vercel 独立轮 cron、Vercel 刷新尾部;清单见
`docs/migrations.md`「回滚」):确实未包含围栏实现的旧版本与带围栏新代码混跑时,旧写不受代次门禁约束。

## 自测

    npx vitest run scripts/shuyuan-refresh/    # dry-run 计数口径 + 产物可加载/无凭据字面量

`src/lib/shuyuan.test.ts`(78 例)钉住「可见性改动不改变 refreshShuyuan 语义」。

## 与仓库共享的改动(仅可见性,零逻辑)

`src/lib/shuyuan.ts` 里把 `INDEX_URL`/`LATEST_COUNT`/`fetchText`/`parseIndex`/`sameRules`/
`normalizeUrl`/`cleanJson` 由非导出改为 `export`,供 dry-run 复用同一抓取语义。函数体逐字未动。
