# verify625 报告：Python 严格隔离离线门（白名单 env + 进程级断网）

- 任务书：D:/ClaudeCode/projects/zhaoshu/codex-fence-followup-20260929/task-pygate625-sonnet.md
- 分支：pygate625-offline（新建自 0373be24fd45cf30c3505f001a7fe5d52e7716da，不从 origin 重写）
- 隔离 pwd：D:/ClaudeCode/projects/zhaoshu/novel-finder/.claude/worktrees/agent-ab81b23938a7f200c
- 范围遵守：未改任何业务源码与已有测试（diff 仅新增 4 个本任务文件）；未读 624 日志/真实 env；未做真实 socket 探针（TEST-NET 地址零接触）；无生产/凭据/安装/push。

## 1. 启动器与机制

- 入口命令（隔离树根）：`python verify625_launcher.py`（自查模式：`--selfcheck`）
- 子进程实际命令形态：`<python> -I -B verify625_gate.py`（isolated：忽略用户 site 与 PYTHON* 环境变量，不读真实 .env 路径外内容）
- 白名单 env：从**空映射**构造；从真实环境**只逐键取** 7 个系统键——PATH、SYSTEMROOT、WINDIR、COMSPEC、PATHEXT、OS、PROCESSOR_ARCHITECTURE（存在才取，未枚举后脱敏）；TEMP/TMP/HOME/USERPROFILE/APPDATA/LOCALAPPDATA 全部重定向到本树内假目录（verify625-tmp / verify625-fake-home）；编码键 PYTHONIOENCODING/PYTHONUTF8/LC_ALL 用**字面量**注入。零 API/DB/代理/认证键透传。
- 网络护栏（在导入任何测试/业务模块之前安装）：
  - socket 连接层：`socket.create_connection`、`socket.socket.connect/connect_ex`、`socket.create_server` 打桩抛 NetworkGuardError；
  - DNS 层：`socket.getaddrinfo/gethostbyname/gethostbyname_ex/gethostbyaddr` 打桩抛 NetworkGuardError（不做真实解析）；
  - audit hook 层：`sys.addaudithook` 拦 **C 级 `socket.connect` 事件**（不依赖 Python 属性替换，mock.patch 换掉打桩也拦得住）+ `subprocess.Popen` 白名单（只放行「python -I -B 本门文件」形态，其余子进程一律阻断使门失败；实际门内未触发任何子进程）。
- 测试运行：门内 `unittest discover('scripts', top_level_dir='scripts', pattern='test_*.py')`，cwd=隔离树根。

## 2. 护栏正负控制（先证明拒绝，再放行门）

- POS-OK create_connection blocked（合成地址，未发包）
- POS-OK getaddrinfo blocked（合成 .invalid 域名，未解析）
- POS-OK urlopen blocked (guard)（合成 URL，经 DNS/连接层拦截，零真实请求）
- NEG-OK local op unaffected（护栏不误伤本地执行）
- 控制失败时门**拒绝跑测试**（exit=2 设计），本次控制全过。

## 3. 启动器修正（有据仅一次）

- 首跑（a6afb85 版 audit hook 拦 'urllib.Request'）出现唯一失败：`test_labeler_import.TestOfflineGuardIsEffective.test_missing_http_get_stub_fails_loudly_not_by_timeout`——原因：该层早于 socket 层，把套件自带离线守卫的 `OfflineViolation`（刻意继承 BaseException 以穿透 http_get 的 `except Exception` 重试兜底）替换成普通 Exception，被兜底吞掉，测试断言 `OfflineViolation not raised`。修正：audit hook 撤掉 'urllib.Request' 拦截、保留 C 级 socket.connect 审计。selfcheck 复验 3+1 控制全过后才跑修正后的最终门。
- 未删测试、未改业务源码、未放松护栏强度（socket/DNS 打桩 + C 级审计仍在）。

## 4. 最终全发现门结果（仅此一次最终跑）

- `Ran 1041 tests in 7.724s` / `OK` / `GATE_EXIT=0 tests=1041 failures=0 errors=0 skipped=0`
- 发现总数 1041，成功 1041，失败 0，错误 0，跳过 0，退出码 0。

## 5. 网络阻断与放行计数（分开报）

- 门跑全程：BLOCKED_NET=2、BLOCKED_DNS=1（全部来自门自举的正控制合成调用）、BLOCKED_PROC=0、ALLOWED_PROC=0。
- 即：套件运行期真实网络出网次数=0、真实 DNS 解析次数=0、子进程放行次数=0（套件内 subprocess 全为 mock，未真起进程）。

## 6. 产物路径与提交

- 脚本：`verify625_launcher.py`、`verify625_gate.py`（本树根）
- 日志：`verify625-gate.log`（合成测试输出；子进程因 -I 忽略 PYTHONIOENCODING 而以 cp936 写入，已按 GBK 解码规范为 UTF-8，统计数字行均为 ASCII 原样；落盘前后自扫 postgres/sk-/API_KEY=/Bearer/password 模式命中 0）
- 提交：a6afb85（启动器+门体+骨架+selfcheck 证据）→ b6ed4fd（唯一一次有据修正）→ 最终 HEAD（本报告+最终门日志）见下。

## 7. 结论

- 门**通过**：1041/1041 全绿、退出码 0，且在空白名单 env + 三层进程级断网下完成——满足任务缺失验收门的白名单与离线要求。
- 已知噪音：日志中文夹具输出编码混合为显示层问题，不影响门判定（数字行/结果行均 ASCII 清晰）。

PYGATE625_STRICT_OFFLINE_GATE_DONE
