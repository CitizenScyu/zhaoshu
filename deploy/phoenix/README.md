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
| `zhaoshu-cron-followup.service` / `.timer` | 同名 |
| `zhaoshu-admission.service` / `.timer` | 同名 |
| `zhaoshu-admission.service.d/70-scan5.conf` | `/etc/systemd/system/zhaoshu-admission.service.d/70-scan5.conf` |
| `zhaoshu-admission-confirm.service` / `.timer` | 同名（admconf46，每小时 GET /api/shuyuan/admission） |
| `zhaoshu-pool-artifact.service` / `.timer` | 同名（每 30min 源池产物） |
| `zhaoshu-pool-sync-copy.service` / `.timer` | 同名（每 5min 产物副本同步，OnUnitActiveSec 形态） |
| `zhaoshu-repo-rollover.service` / `.timer` | 同名（每小时切仓探针 + ExecStartPost 台账/续期同步） |
| `zhaoshu-download-b-reclaim.service` / `.timer` | 同名（B 线每 30min stale 任务回收，OnUnitActiveSec 形态） |
| `zhaoshu-download-b-prune.service` / `.timer` | 同名（prune1108，B 线下载缓存每 6h 保留清理，OnUnitActiveSec 形态；见下文专节） |
| `prune-protect.sh` | `/usr/local/lib/zhaoshu/prune-protect.sh`（prune 的 ExecStartPre，生成保护名单） |
| `zhaoshu-maint-window.service` / `.timer` | 同名（每天 07:40、19:40 维护窗口；见下文专节） |
| `maint-window.sh` / `pool-unregistered.mjs` | `/usr/local/lib/zhaoshu/` 同名（维护窗口脚本与只读选 host） |
| `nosrc-tool.sh` | `/usr/local/lib/zhaoshu/nosrc-tool.sh`（root 0755；`/root/zs-backup/nosrc-tool.sh` 是指向它的软链；见下文专节） |
| `zhaoshu-nosrc-gc.service` / `.timer` | 同名（每天 10:30 书库清理 gcrun；见下文专节） |
| `zhaoshu-gapfill.service` / `.timer` | 同名（每天 11:00 缺章补抓 gapfill；见「少量缺章占位发布」专节） |
| `cron-call.sh` | `/usr/local/lib/zhaoshu/cron-call.sh` |
| `nginx/book.conf` | `/etc/nginx/sites-enabled/`（生产站块，占位符版） |
| `nginx-pool-artifact.conf`（在 shuyuan-refresh/deploy/） | vhost 443 块内 `/pool-artifact.json` location（41-poolimpl） |

单元文件里**没有任何密钥真值**：`EnvironmentFile=/etc/zhaoshu-web/env` 与
`/etc/zhaoshu-shuyuan/env` 一律保持引用形式，`CRON_SECRET` 由 cron-call.sh 从环境读取、
经 curl 的 stdin 传入，不进 argv 也不进 journal。

cron-call.sh 用法：`cron-call.sh <路由路径> [max-time 秒，默认 330] [HTTP 方法，默认 GET]`；
第 3 参数是 2026-10-18 追更上线时加的（`/api/followup` 只导出 POST，GET 会 405），
旧调用点不传第 3 参数即保持 GET，行为不变。

## timer 与告警阈值对照

调度唯一来源是 phoenix 的 systemd timer（Vercel 侧 `vercel.json` 的 `crons` 块已于
crons5 删除，见下）。阈值常量在 `src/lib/source-health.ts`，**不在本目录复述**；
下表的「阈值」列只写常量名。

| timer | OnCalendar | 实际间隔 | service ExecStart | 阈值常量 |
| --- | --- | --- | --- | --- |
| `zhaoshu-cron-shuyuan.timer` | `*-*-* 10:00:00 Asia/Shanghai` | 24h | `cron-call.sh /api/shuyuan 330` | `SHUYUAN_REFRESH_ALERT_HOURS` |
| `zhaoshu-cron-reclaim.timer` | `*-*-* 05:00:00 Asia/Shanghai` | 24h | `cron-call.sh /api/download/reclaim 60` | `CRON_ALERT_HOURS` |
| `zhaoshu-cron-drain.timer` | `*-*-* 05:30:00 Asia/Shanghai` | 24h | `cron-call.sh /api/profile/absorb/drain 330` | `CRON_ALERT_HOURS` |
| `zhaoshu-cron-followup.timer` | `*:0/30` | 0.5h | `cron-call.sh /api/followup 60 POST` | `CRON_ALERT_HOURS` |
| `zhaoshu-admission.timer` | `*-*-* 00/1:17:00 UTC` | 1h | `refresh-runner.mjs --admission` | `ADMISSION_ALERT_HOURS` |
| `zhaoshu-admission-confirm.timer` | `hourly`（关键字） | 1h | `cron-call.sh /api/shuyuan/admission 300` | `ADMISSION_ALERT_HOURS` |
| `zhaoshu-pool-artifact.timer` | `*-*-* *:07,37:00` | 0.5h | `refresh-runner.mjs --pool-artifact` | `CRON_ALERT_HOURS` |
| `zhaoshu-repo-rollover.timer` | `*-*-* *:37:00` | 1h | `repo-auto-create.mjs` + ExecStartPost `sync-ledger-capacity.mjs` | `CRON_ALERT_HOURS` |
| `zhaoshu-pool-sync-copy.timer` | 无 OnCalendar（`OnUnitActiveSec=5min`） | 5min | `cp pool-artifact.json → /var/lib/zhaoshu-sync/` | 不判龄（副本同步，非业务轮） |
| `zhaoshu-download-b-reclaim.timer` | 无 OnCalendar（`OnUnitActiveSec=30min`） | 0.5h | `runtime/timer/reclaim.mjs`（B 线本机回收） | 不判龄（不写 cron_health） |
| `zhaoshu-download-b-prune.timer` | 无 OnCalendar（`OnUnitActiveSec=6h`） | 6h | `ops/prune-download-out.mjs --apply`（B 线下载缓存保留） | 不判龄（不写 cron_health） |
| `zhaoshu-maint-window.timer` | `*-*-* 07:40:00` + `*-*-* 19:40:00` | 12h | `/usr/local/lib/zhaoshu/maint-window.sh` | 不判龄（不写 cron_health） |
| `zhaoshu-nosrc-gc.timer` | `*-*-* 10:30:00` | 24h | `/usr/local/lib/zhaoshu/nosrc-tool.sh gcrun` | 不判龄（不写 cron_health） |
| `zhaoshu-gapfill.timer` | `*-*-* 11:00:00` | 24h | `/usr/local/lib/zhaoshu/nosrc-tool.sh gapfill` | 不判龄（不写 cron_health） |

后三条是 2026-10-22 从现网取回补齐的（此前零登记、不受门禁覆盖）：
- `admission-confirm` / `pool-artifact` / `repo-rollover` 已进 `src/lib/vercel-cron.test.ts` 的 TIMERS 表并做「阈值 > 间隔」断言；
- `pool-sync-copy` / `download-b-reclaim` 是相对触发形态，只登记不做间隔断言（ExecStart 片段由 runnerFragments 钉住）。

`download-b-prune` 是 2026-11-08 prune1108 新增的相对触发形态，同样只登记不做间隔断言；
runnerFragments 钉住 `--apply` 与 `--protect`（少前者只是预演，少后者静默降级为只删 `book.txt`）。
`maint-window`、`nosrc-gc`（2026-11-09）与 `gapfill`（同日）有 OnCalendar，但不写 cron_health，也登记为 `alertHours: 0`。
临时的 `zs-nosrc-p2.timer` 已于 11-09 由 `zhaoshu-nosrc-gc.timer` 取代并 disable，单元副本已从本目录删除。

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

## B 线下载缓存保留（prune1108，2026-11-08）

`/var/lib/zhaoshu-download-b/inst-N/download/out/<适配键>/<引擎键>/` 此前从不清理（11-08 现网 51G、
日增约 10G，与 Postgres 同盘、根分区 0 保留块，盘满即全站停）。`zhaoshu-download-b-prune.timer`
每 6h 跑一次 `prune-download-out.mjs --apply`，判龄只看 mtime 与 manifest 顶层 `status`：

| 规则 | 条件 | 动作 |
| --- | --- | --- |
| 活锁 | `download.lock` 在，且 max(锁, manifest) 不足 6h（任务预算 5.5h） | 整目录不动 |
| R1 | `book.txt` 与 manifest 都超 1h | 只删 `book.txt`（完成当刻已被读走，可由章文件重建） |
| R2 | `status=done` 超 3d，且不在保护名单 | 整目录删 |
| R3 | 其余（partial / 无 manifest / done 但带占位章 `chapters_missing≥1`）超 14d，且不在保护名单 | 整目录删 |

- 保护名单 = 用户任务（`requested_by='user'`）及其候选源的适配键，由 `prune-protect.sh` 以 root 写到
  `/run/zhaoshu-prune-protect/protect.txt`。生成失败、键数为 0 或超 2h 未更新时，本轮只做 R1。
- 整目录先 rename 进 `<out>/.prune-trash/` 再删，worker 只会看到完整目录或没有目录；
  改名后若发现判定时没有的新锁，就原样放回（计入 `raced`）。
- 每删一个 `book.txt` 或整目录后歇 `--pace-ms`（默认 50ms）：调度器是 mq-deadline（unit 里的
  `IOSchedulingClass=idle` 不生效），成批删的元数据写会和同盘 Postgres 抢 IO。根分区原先还挂着 online
  `discard`，删除会再排出一长串 TRIM；11-08 已去掉，见下节。
- 每轮在 journal 写一行 JSON 计数（`journalctl -u zhaoshu-download-b-prune -n 5`），不含路径与书名；
  `freedBytes` 是 statfs 实测差值。

| 仓内 | 现网 | 属主 / 权限 |
| --- | --- | --- |
| `scripts/prune-download-out.mjs` | `/opt/zhaoshu-download-b/ops/prune-download-out.mjs` | root:root 0644（zsdownload 只读） |
| `deploy/phoenix/prune-protect.sh` | `/usr/local/lib/zhaoshu/prune-protect.sh` | root:root 0755 |

root 执行的脚本必须由 root 持有、zsdownload 不可写；root 也只往 root 自建的目录写（防软链劫持）。

- 预演（不带 `--apply` 即 dry-run，只读）：
  `sudo -u zsdownload /opt/node24/bin/node /opt/zhaoshu-download-b/ops/prune-download-out.mjs --root /var/lib/zhaoshu-download-b --protect /run/zhaoshu-prune-protect/protect.txt`
- 关停：`systemctl disable --now zhaoshu-download-b-prune.timer`；在跑的一轮用
  `systemctl stop zhaoshu-download-b-prune.service` 中断，留下的回收目录下一轮自动清掉。
- 回滚：关停 timer 即回到不清理状态。删掉的是本机下载缓存，不能恢复，只会在任务重跑时重新下载。

## 根分区去掉 online discard（2026-11-08）

`/`（ext4，`LABEL=cloudimg-rootfs`，与 Postgres、B 线缓存同盘）原先以 `discard,errors=remount-ro` 挂载。
prune 首轮成批删除后，ext4 把释放的区间排进后台 discard 队列逐段下发，积压持续了几个小时：
IO PSI（some avg60）约 52%、盘忙 59–96%、load 约 5.2，同盘 Postgres 一起变慢。

- `/etc/fstab` 根分区去掉 `discard`（默认即不在线 TRIM；原文件备份在 `/root/zs-backup/fstab-20261108-091732`），
  并 remount 生效。TRIM 交给系统自带的每周 `fstrim.timer`。
- remount 只挡住新的排队，已经排进去的仍按原速下发。清掉积压的办法：把
  `/sys/block/sda/queue/discard_max_bytes` 临时写 0，块层对 discard 直接返回 `EOPNOTSUPP`，ext4 跳过剩余区间，
  几秒内清空；随后写回原值 `2147483648`。原值与恢复命令记在 `/root/zs-backup/sda-discard-20261108-112012.txt`。
  跳过的区间只是少发了一次 TRIM，不影响数据。
- 处置后 IO PSI 降到约 8%、盘忙约 16%、load 约 1.5。
- 回滚：换回 fstab 备份并 `mount -o remount,discard /`。不建议，批量删除会再次堆出 TRIM 积压。

## 维护窗口（maint-window，2026-11-09）

两件事都要先停全部 B 线 worker，合并到一个窗口里做：

- **登记新 host**：准入每天会往源池加新 host，但共享限速登记表不会自动跟进，没登记的 host
  worker 拿不到锁（`HOST_LOCK_MISSING`），等于白进池。
- **释放 worker 内存**：11-08 16:00 到 11-09 01:45，20 个 worker 的 RSS 合计稳定在约 8.2G，
  swap 却从 733M 涨到 1528M，其中约 1G 在 B 线 slice（匿名页被慢慢换出）。01:46 重启一次后，
  slice 的 swap 归零，整机 swap 降到 496M，可用内存从 2.9G 回到 4.9G。

`zhaoshu-maint-window.timer` 每天 07:40、19:40（北京时间）跑 `maint-window.sh`：

1. 拿 `/run/zs-maint.lock`；校验脚本与 `/usr/local/lib/zhaoshu/` 都是 root 持有且组/他人不可写；
   记下当前在跑的实例号。
2. 以 zsdownload 只读运行 `pool-unregistered.mjs 5`，挑最多 5 个 host。条件：在源池产物 `hosts[]` 里，
   也是某条启用中的引擎源 `source_url` 的 host；登记表里没有，数据根下也没有它的目录；不在拒绝名单
   （`PAYWALL_HOSTS` 加 `m.yuedu.163.com`、`www.ciweimao.com`、`so.html.qq.com`）；host 名过正则。
3. 停全部 worker（SIGTERM，在跑的任务先存进度）。有待登记的 host 就先把登记表备份到
   `/root/zhaoshu-backfill/poolreg-window-<ts>/`，再用 `register-hosts.mjs` 登记。
4. 把第 1 步记下的实例原样拉起。任何一步失败都由 trap 拉起 worker。

11-09 01:46 首次运行登记了 `jyapi.jyacg.com`，worker 停机约 10 秒。07:40 落在每日 08:00
（UTC 零点）按 host 预算重置之前。

- 日志：`journalctl -u zhaoshu-maint-window`（只有 host 名与计数，不含 authority/epoch/rootId）。
- 关停：`systemctl disable --now zhaoshu-maint-window.timer`。
- 撤销某次登记：停全部 worker；以 zsdownload 把备份里的 `registry.json` 拷回
  `/var/lib/zhaoshu-download-b/control/`；以 zsdownload 删掉 `registered.tsv` 列出的 host 目录；
  再起 worker。
- 20 个实例 `zhaoshu-download-b@1..20` 都必须 enable（11-09 发现 1–12 未 enable，重启后不会自启，已补）。

B 线 slice 另加了内存上限 `MemoryMax=10G`（`systemctl set-property`，drop-in 在
`/etc/systemd/system.control/system-zhaoshu\x2ddownload\x2db.slice.d/50-MemoryMax.conf`）。
11-09 前的峰值是 9.6G。到上限时只在 slice 内回收或 OOM，不会挤占 Postgres、web 和其它容器。
回滚：`systemctl set-property 'system-zhaoshu\x2ddownload\x2db.slice' MemoryMax=infinity`。

维护类脚本（`maint-window.sh`、`nosrc-tool.sh gcrun`）都用 `flock` 拿 `/run/zs-maint.lock`，互不重叠。

## 无源书清理（nosrc，2026-11-09）

原则：打标的书先入库，确认下载不了再从书库删除（不在入库前等下载结果）。
工具是 `nosrc-tool.sh`（phoenix 上 `/usr/local/lib/zhaoshu/nosrc-tool.sh`，root 0755）。

- **常设清理 gcrun**（`zhaoshu-nosrc-gc.timer` 每天 10:30）。适用范围：没有产物，没有 done/pending/running 任务，
  没有用户请求，最新任务 failed/partial 或从未排过任务的书。在这个范围内：
  - **删除**：最新失败属于「没有可用源」类（`no_candidates`，以及 failed 的 identity_mismatch、
    download_failed、invalid_next_page、invalid_chapter、unsupported_toc_rule、preview_truncated、toc_limit），
    并且已经是第二次（末次搜索 `lastcall-*`/`gc-lastcall-*` 的结果，或 14 天内 ≥2 次失败），
    并且没有未试过的免费候选。
  - **末次搜索**：其余还没排过末次搜索的书，每天最多排 300 本（`source_revision=gc-lastcall-YYYYMMDD`）。
  - **保留**：partial（缺章）、`source_unavailable`（源站临时不可用）、有免费候选的书，末次之后也不自动删；
    日志里按 `held_*` 计数，留给人工决定。
  - 单次删除超过 2000 本就拒绝执行（`ZS_GC_MAX_DELETE` 可手工放宽）。`gcrun --dry-run` 只打印分桶计数。
  - 日志：`journalctl -u zhaoshu-nosrc-gc`（分桶计数、备份目录、删除与排队数）。
    关停：`systemctl disable --now zhaoshu-nosrc-gc.timer`。
- **备份**（`backup`）：全库 `pg_dump -Fc`，涉及的 7 张表（书、产物、任务、候选、预取、追更、
  容量预留）按书 id 导出 CSV，生成单事务的 `restore.sh`。gcrun 的备份在 `/root/zs-backup/nosrc-gc-<时间>/`，
  回滚跑其中的 `restore.sh`。
- **删除**（`delete`）在一个事务里先做这些检查，任一不符就整体回滚：
  - 外键白名单、无用户触发器；
  - 锁住这些书，逐本复核仍符合清理条件（gc 模式在加锁后重算规则，期间被排上任务的书会让整批回滚）；
  - 没有集合外的任务或追更指向这些行；
  - 每张表删除的行数等于备份行数。
- **第一阶段**（11-09 01:01，QQ 付费墙书）：删除最终判定在 11-07 之后的 311 本。备份在
  `/root/zs-backup/nosrc-p1-20261109-010126/`，回滚跑其中的 `restore.sh`。
- **第二阶段**：其余 1504 本先各排一次末次搜索（`source_revision=lastcall-20261109`），
  删除改由 gcrun 承担（原临时 `zs-nosrc-p2.timer` 已停）。
  回滚步骤见 `/root/zs-backup/nosrc-lastcall-20261109/rollback.txt`。
- **不清理的部分**：
  - 被删产物在 GitHub 仓库里的文件不动（第一阶段约 216.9MB）。容量台账是增量记账，不受影响。
  - `import_labels.mjs` 重新导入名单时，这些书会以新 id 回到书库。

## 少量缺章占位发布（gappub1109，2026-11-09）

- drop-in `zhaoshu-download-b@.service.d/89-gappub.conf`：`DOWNLOAD_GAP_PUBLISH=1`。整本只缺 ≤3 章且 ≤2% 时，
  缺的章写「（本章源站下载失败，暂缺正文。）」照常发布；清单记 `chapters_missing`，任务行与 book_artifacts 的
  `chapters_done` 只算实有正文的章，书库显示「完成（缺 N 章）」。
- 晋升保护：带缺章的新版本实有章数少于已发布版本时不晋升（`superseded_by_incomplete`）。
- 自动补缺（`zhaoshu-gapfill.timer` 每天 11:00 跑 `nosrc-tool.sh gapfill`）：最新 done 任务仍有占位章
  （`chapters_done < chapters_total`）且没有 pending/running 任务的书，插一条新系统任务重下
  （`source_revision=gapfill-YYYYMMDD`）。第 k 次（从 0 起）要等「缺章发布与上次补抓中较晚者」之后
  24h × 2^k，即 1、2、4、8、16、32 天；每本最多 6 次，每天最多 100 本。重下会重新选源，抓到正文就以更全的版本晋升；
  仍缺的照旧保留已发布版本。选中同一源时，续传（含 `DOWNLOAD_RESUME_PEERS` 从兄弟实例同键目录播种）只重抓占位章；
  带占位章的缓存目录 prune 按 14 天保留（读 manifest 末 4KB 的 `chapters_missing`），覆盖第 1/2/4/8 天四次补抓。
  换了源才是整本重下，费用由退避与日上限兜住。
  - `gapfill --dry-run` 在事务里照实插入后回滚，打印分桶（`gap_due`/`gap_waiting`/`gap_capped`）与「会插入」数。
  - 可调：`ZS_GAP_MAX_TRIES`（6）、`ZS_GAP_MAX_ENQUEUE`（100）、`ZS_GAP_BASE_HOURS`（24）。
  - 日志 `journalctl -u zhaoshu-gapfill`；关停 `systemctl disable --now zhaoshu-gapfill.timer`；已插的任务可按
    `source_revision LIKE 'gapfill-%' AND status='pending'` 删除。
- 关闭：删 drop-in → `systemctl daemon-reload` → 重启 `zhaoshu-download-b@1..20`；已发布的缺章书不受影响。

## 发布 409 重试与重领复用整本（pub409 / pubreplay1110，2026-11-10）

- contents API 的 PUT 遇 409（20 个 worker 往同一分支提交，分支头在读 sha 与写之间被推进）就地重读 sha 重写，
  最多 4 次、抖动退避约 1/2/4/8s；其余状态码不重试。仍失败才走原「发布失败，自动退避重试」放回 pending。
- drop-in `zhaoshu-download-b@.service.d/90-pubreplay.conf`：`DOWNLOAD_PUBLISH_REPLAY=1`。整本下完后在引擎目录写
  `publish-replay.json`（任务 id + 整本 sha）；同一任务再领时在本实例和兄弟实例同适配键下找它，逐章核 sha256、
  拼回整本且 sha 与 manifest 相符才直接发布，不再重跑 search/toc（源熔断时整本也能发出）。追更、补缺、重排都是
  新任务行，照常联网；目录持锁、被别的任务重跑或任一校验不过都按不命中照常下载。标记随引擎目录被 prune 删除。
- 日志：「发布失败，已退避放回」{taskId, stage, retryAt}、「重领复用本地整本，跳过联网」{taskId, chapters, peer}、
  「任务失租约，交回收器」{taskId}。
- 关闭复用：删 drop-in → `systemctl daemon-reload` → 重启 `zhaoshu-download-b@1..20`。

## 书尾预览先探（tailprobe1110，2026-11-10）

- drop-in `zhaoshu-download-b@.service.d/91-tailprobe.conf`：`DOWNLOAD_PREVIEW_TAIL_PROBE=1`（tailwall 也须开着）。
  正文首轮前先抓书尾 5 个非公告章；全是短章（< 500 字）就顺序抓到第一个非公告长章即判 `preview_truncated`。
  这时收尾的 tailwall 判据必然命中，只是不再抓完整本；书是否发布不变。
- 动机：11-08～11-10 共 526 份 preview_truncated 清单抓了约 8.57 万章，其中 274 本首章就是长章、
  只有尾段是预览，要逐章抓完全书才判；biquge.site 两天在这类书上耗约 3.4 万次请求，撞 2 万/天上限。
- 探测章失败不计连败，主循环按目录序重抓；探测成功的章不重复抓。
- 关闭：删 drop-in → `systemctl daemon-reload` → 重启 `zhaoshu-download-b@1..20`。

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
