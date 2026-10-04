# fix673 报告：669 用例④⑤⑥ attempt_count 语义修正

- 代理：fix673-sonnet
- 任务书：D:/ClaudeCode/projects/zhaoshu/codex-fence-followup-20260929/task-fix673-sonnet.md
- 树：D:/ClaudeCode/projects/zhaoshu/novel-finder/.claude/worktrees/agent-a45787d121132dd20
- 分支：fix673-attempt-semantics（基于 86ff1ada5751f7fdbb863bfaa7b5de40902c40c2 新建）
- 唯一改动文件：runtime-download/retired-builtin.pglite.test.ts（+52/−27）
- 新 commit：见末尾「提交记录」节

## 语义依据（672 轮已核实，未重证）

- attempt_count 列：DEFAULT 1，CHECK ≥1（src/lib/business-schema.ts:235–236）
- 领取 claimDownloadTask 不 +1（src/lib/download-task-queue.ts:120–134，仅置 running/lease）
- 一轮 source_unavailable 唯一 +1 在 deferDownloadTask（download-task-queue.ts:225：status='pending'、attempt_count+1、lease_owner=''、next_attempt_at 退避）
- finish 不改 attempt_count（download-task-queue.ts:202–208）
- reclaimStaleTasks：system 且 <16 ⇒ pending 且 attempt_count+1；否则 failed 且 attempt_count 不变（download-task-reclaim.ts:18–36）

## 三用例修正前后对照

### 用例④（user 同源不可用仍走 defer）
- harness：旧 `?? 0` 显式插 0（过不了 CHECK ≥1）→ 改为不传参时 INSERT 省略 attempt_count 列、落 DEFAULT 1
- 断言前：attempt_count=2，注释「领取 +1、defer +1」（前提错误）
- 断言后：attempt_count=**2**（DEFAULT 1 → defer +1，领取不 +1），pending 非 failed、lease_owner='' 不变
- 注意：④断言值 2 恰好前后相同，但达成路径由「0+1(领取)+1(defer)」纠正为「1(DEFAULT)+1(defer)」；旧版实际会在 INSERT 处违反 CHECK ≥1 报错，根本走不到断言

### 用例⑤（达上限 16 ⇒ 终态 partial 不再重排）
- 断言前：insertTask({attemptCount: 15}) + 错误前提「领取 +1 ⇒ 16」⇒ 一轮即 partial/16
- 断言后：**两轮制**对齐既有 source-unavailable.pglite.test.ts:261–282 用例⑥——insert（DEFAULT 1）后 `UPDATE ... SET attempt_count = 15`（同参照 :263 写法）→ 第一轮断言 **pending/16**（15<16 ⇒ defer +1 重排）→ dueNow 推进（测试内合成 `UPDATE ... SET next_attempt_at = now() - interval '1 millisecond'`，参照 :255/:270）→ 第二轮断言 **partial/16**、error 含 source_unavailable、不再重排（若再 defer 会变 17）

### 用例⑥（reclaim 对照：system 回 pending、user 直接 failed）
- harness：两行 insert 均删去 attemptCount: 0 → 落 DEFAULT 1
- 断言前：system attempt_count=1（0+1）、user attempt_count=0（不变）
- 断言后：system attempt_count=**2**（DEFAULT 1 + reclaim +1）、user attempt_count=**1**（保持 DEFAULT 1，非 0）；status/lease_owner 断言不变

### harness insertTask 总体改法
opts.attemptCount === undefined ⇒ 列清单不含 attempt_count（落 DEFAULT 1）；显式传入 ⇒ 仍显式插列。既有用例①②③均不传参 ⇒ 行为统一为 DEFAULT 1；②③的既有断言（一轮后 attempt_count=2 = 1+1）未动且语义自洽。

### 注释同步
文件内所有「领取 +1」表述已删除/改写为「DEFAULT 1（business-schema.ts:235）+ defer +1（download-task-queue.ts:225），领取（claim）不 +1（download-task-queue.ts:120–134）」。

## 约束遵守声明

- 未改生产代码任何一行（diff 仅 runtime-download/retired-builtin.pglite.test.ts + 本报告）
- 未动既有用例①②③的断言（harness 默认路径按任务书指示改为省列 DEFAULT 1）
- **未运行任何测试/应用/构建/Node/Python**（仅 git 只读、checkout -b、commit；本文档写入用编辑器工具）
- 未读 env；读白名单 5 文件恰好用满（retired-builtin 全文、source-unavailable 230–283、queue 115–235、reclaim 1–60、schema 225–245）
- 未遇任何权限或隔离守卫拒绝
- 工具调用总数 12（上限 16 内）

## 提交记录

- 新 commit：**398249792c7f08991d9a5c932481b298aa971246**（fix673-attempt-semantics，父 = 86ff1ad）
- 变更：2 files changed, 104 insertions(+), 27 deletions(-)（测试文件 + 本报告）
- 未 push（任务书无 push 指示）

FIX673_ATTEMPT_SEMANTICS_CODE_DONE

