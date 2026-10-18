# phoenix 生产部署单元（入仓副本）

本目录是 **phoenix（144.24.10.250）生产现网 systemd / nginx 单元的仓内副本**，2026-10-18 由
`ssh phoenix 'systemctl cat …'` 原样取回（去掉了 `# /etc/systemd/system/… #` 注释头），
未做内容改写。**入仓不是为了改它们，是为了（a）让离线门禁能真解析 `OnCalendar=`、
（b）灾备重建时不必靠记忆。**

> 本副本**不是**部署脚本。生产单元仍以 phoenix 上的 `/etc/systemd/system/` 为准；
> 两者出现差异时以 phoenix 为准，并回来更新本目录（更新时重跑一次 `systemctl cat` diff）。

## 文件清单

| 文件 | 对应现网路径 |
| --- | --- |
| `zhaoshu-web.service` | `/etc/systemd/system/zhaoshu-web.service` |
| `zhaoshu-cron-shuyuan.service` / `.timer` | 同名 |
| `zhaoshu-cron-reclaim.service` / `.timer` | 同名 |
| `zhaoshu-cron-drain.service` / `.timer` | 同名 |
| `zhaoshu-admission.service` / `.timer` | 同名 |
| `zhaoshu-admission.service.d/70-scan5.conf` | `/etc/systemd/system/zhaoshu-admission.service.d/70-scan5.conf` |
| `cron-call.sh` | `/usr/local/lib/zhaoshu/cron-call.sh` |
| `nginx/book.conf` | `/etc/nginx/sites-enabled/`（生产站块，占位符版） |

单元文件里**没有任何密钥真值**：`EnvironmentFile=/etc/zhaoshu-web/env` 与
`/etc/zhaoshu-shuyuan/env` 一律保持引用形式，`CRON_SECRET` 由 cron-call.sh 从环境读取、
经 curl 的 stdin 传入，不进 argv 也不进 journal。

## timer 与告警阈值对照

调度唯一来源是 phoenix 的 systemd timer（Vercel 侧 `vercel.json` 的 `crons` 块已于
crons5 删除，见下）。阈值常量在 `src/lib/source-health.ts`，**不在本目录复述**；
下表的「阈值」列只写常量名。

| timer | OnCalendar | 实际间隔 | service ExecStart | 阈值常量 |
| --- | --- | --- | --- | --- |
| `zhaoshu-cron-shuyuan.timer` | `*-*-* 10:00:00 Asia/Shanghai` | 24h | `cron-call.sh /api/shuyuan 330` | `SHUYUAN_REFRESH_ALERT_HOURS` |
| `zhaoshu-cron-reclaim.timer` | `*-*-* 05:00:00 Asia/Shanghai` | 24h | `cron-call.sh /api/download/reclaim 60` | `CRON_ALERT_HOURS` |
| `zhaoshu-cron-drain.timer` | `*-*-* 05:30:00 Asia/Shanghai` | 24h | `cron-call.sh /api/profile/absorb/drain 330` | `CRON_ALERT_HOURS` |
| `zhaoshu-admission.timer` | `*-*-* 00/1:17:00 UTC` | 1h | `refresh-runner.mjs --admission` | `ADMISSION_ALERT_HOURS` |

**不变量：告警阈值必须 > 实际触发间隔**，否则正常运行就会误报。该不变量由
`src/lib/vercel-cron.test.ts` 从本目录的 timer/service 文件**真解析** `OnCalendar=` 与
`ExecStart=` 后离线校验——改这里的计划必须同步改 `src/lib/source-health.ts` 的阈值与
`.github/workflows/source-health.yml` 里复述的同一组数字，脱节即测试变红。

`zhaoshu-admission.timer` 的描述文字仍写着「every 2h」，但 `OnCalendar=*-*-* 00/1:17:00 UTC`
实际是**每小时一轮**（:17 分）。描述是 2026-10-18 现网原文，未改动；**以 `OnCalendar` 为准**
（门禁解析的也是 `OnCalendar`）。

## `zhaoshu-admission.service` 与架构书 §10.6 ④ 的偏离

计划书 §10.6 ④ 要求准入也走 `cron-call.sh <路由>` 的 oneshot 形态。现网**不是**这样：

- `User=root`，`ExecStart=/opt/node24/bin/node /opt/zhaoshu-shuyuan-refresh/refresh-runner.mjs --admission`
  —— 是 runner 形态，直接调仓库里的 `admitRows`，**不经过 HTTP 路由**，所以没有
  `/api/shuyuan/admission` 路由路径可断言。
- 用 node24（web 服务用 node22，在 `/opt/node22`）。
- 环境文件是 `/etc/zhaoshu-shuyuan/env`（只读 `DATABASE_URL`），不是 web 的 `/etc/zhaoshu-web/env`。
- 另有 drop-in `70-scan5.conf` 把 `ADMISSION_MAX_PROBES` 覆盖到 120 并新增
  `ADMISSION_UPGRADED_MAX_PROBES=80`（单元内联的 80 已被 drop-in 覆盖，保留原样以便看出覆盖关系）。

**为何保留**：主会话 2026-10-18 已核实它是唯一准入源、成功时写 `cron_health('admission')`、
与路由共用 `admission_lease`。这是**有意为之的偏离**，不是遗留缺陷；要收敛到字面四约束需要
另一次生产变更，不在本目录副本范围内。

## release 目录布局 / 回滚

```
/opt/zhaoshu-web/
  releases/<short-sha>/      # 每次部署一个不可变目录（standalone 构建产物）
  current -> releases/<short-sha>   # 符号链接，systemd WorkingDirectory/ExecStart 指向它
  src/                       # 检出的源码树
  build.log / ci.log
```

部署完成时在 `current/` 写 `DEPLOYED_SHA`，单行：

```
<完整 sha> <ISO 时间> origin:master <构建机标识>
```

例（2026-10-18 取回时）：

```
21e0238145b06090e0eee83b8ec4e6e37af0fb19 2026-10-18T02:48:10Z origin:master phoenix-arm64
```

**回滚**：`ln -sfn /opt/zhaoshu-web/releases/<上一个 short-sha> /opt/zhaoshu-web/current &&
systemctl restart zhaoshu-web`。回滚前先核实目标 release 目录确实存在且内容完整；
`current` 是符号链接，`releases/<sha>` 一律不删（删了就没有回滚点了）。
回滚后读 `current/DEPLOYED_SHA` 复核实际生效版本，不要凭 `systemctl status` 的启动时间推断。

## Vercel 侧收尾（人工，部署后）

`vercel.json` 的 `crons` 块删除只保证**下次 Vercel 部署后**不再有计划任务。仓内改动未推送、
未部署（crons5 不 push、不部署），所以生产 Vercel 实例此刻仍在按旧计划跑，与 phoenix timer 双跑。
人工确认步骤：

1. 合并并推上 master，确认 Vercel 侧出现新的 READY 部署（用 `vercel ls --meta githubCommitSha=<sha>` 按 sha 认，别凭 Age 列猜）。
2. `vercel inspect <deployment-url>`，看内联的 `vercelConfig` 里已无 `crons`。
3. Vercel 控制台 → 项目 → **Cron Jobs**，确认 4 条计划任务（`/api/shuyuan`、`/api/shuyuan/admission`、
   `/api/download/reclaim`、`/api/profile/absorb/drain`）全部消失。
4. Vercel 的 cron 是 UTC 触发；观察一天内 `cron_health` 表里 `reclaim` / `drain` / `shuyuan`
   的 `last_success_at` 只在 phoenix timer 的时刻前进，而 `/api/health/sources` 的判龄始终低于阈值。
