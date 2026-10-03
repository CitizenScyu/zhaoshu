# 628 稳定身份与备选源修复报告

- 任务书：D:/ClaudeCode/projects/zhaoshu/codex-fence-followup-20260929/task-labeler628-opus.md
- 基线：0373be24fd45cf30c3505f001a7fe5d52e7716da → 本地分支 labeler628-stable-identity（隔离树 agent-ac67042af0c69c0df）
- 全部为 Python 业务代码 + 相关测试；未改 TS/CLI、未触生产/凭据/安装/push。

## 1. 问题（主协调亲核，本批必修；626 的非阻断措辞不采纳）

1. _relocate_rank_books_to_engine（基线 labeler.py:3538）把 b[url] 换成 hit[url] 且丢原 URL。
   main 先重定位、后 split_queue，后者仅按 src.absolute(b[url]) 比对 done/pinned/deferred：
   旧 book15 URL / 上轮引擎 URL 全部失配 → 已 done/stub 的书重复打标、pinned 终态失效每轮白烧、
   deferred 后移失效；引擎轮间换站 URL 再漂移，同一书每轮重打。与文档「不会重复标」声明相反。
2. 重定位条目不带 hit[alternates]，而名单线已有 engine_alternates 换源机制
   （fetch_engine_book_with_giveup / fetch_book_text_segmented）→ 主源坏时丢已找到的备选源。

## 2. 身份定义与读写调用点

身份定义：identity = 原 book15 站内路径的绝对 URL（BOOK15.absolute(原url)），在重定位改写
取文 URL 之前写入条目。与书名/作者无关——同名异书不同路径，天然不合并；禁止裸书名去重。
条目无 identity（普通 book15 路径/--book/douban/webnovel 线）时一切按旧 URL 键，行为逐字不变。

统一小接口（labeler.py，628 段）：
- _identity_keys(book, src) → {归一化取文URL} ∪ {identity}：split_queue、deferred_in_queue、
  钉子户日志计数全部经它比对（任一键命中即算）。
- _load_terminal_identities(path)：labels.jsonl / labels-stub.jsonl → {identity, url} 双键并集。
- _rejection_identity_counts(path)：拒收计数按 identity 优先回落 url（豁免规则同 count_rejections）。
- _recent_rejection_identities(path, cooldown)：deferred 冷却的身份版（口径同 recent_rejection_urls）。
- _attach_identity(rec, book)：成功（labels.jsonl）、拒收（labels-rejected.jsonl，5 个写点）、
  残本（labels-stub.jsonl）写回时挂 identity 键；identity==rec.url 时不写（普通路径零变化）。

main 装配：split_queue(all_books, done|stub|_done_keys, pinned|_pinned_keys, deferred=…|deferred_identity_urls)；
_pinned_keys 身份版钉子户与 terminal_urls 同常量同关闸语义（REJECT_TERMINAL_THRESHOLD<=0 时为空）。
钉子户日志计数 max(身份计数, URL计数)，无 KeyError。

兼容旧键：所有名单集合同时含 identity 与 url 键；旧记录（只有 url）自然被 url 键命中，零迁移、
零删除、零生产改动。已 done/stub → 不再打标；pinned 仍终态；deferred 仍后移；优先级 done>pinned>deferred 不变。

重定位免搜：done∪stub∪pinned 的身份键集 terminal_keys 传入 _relocate_rank_books_to_engine，
已终态条目不发起引擎搜索（省全量空搜），但仍原样带 identity 返回、交 split_queue 归类计数（计数不丢）。
deferred 不滤（后移不是终态）。

备选源：hit 的 alternates → 条目 engine_alternates，与名单线同一换源机制（不另造回退系统）。
备选源仍受既有身份校验（toc 身份比对、错书拦）、死源跨轮记忆约束；不复制 disabled/retired 候选。
多源元数据仍记真实取文来源（used[url]/used[source] 改写 b[url]/source_host，identity 不动）；
绝不用旧退休 URL 发网络请求（重定位后零 book15 请求，有专门测试钉死）。

入库侧：import_one.FIELD_STRINGS 与 import_labels.validateImportRecord 同步收 identity
（只类型校验、不写库），两条导入路径对同一记录裁决不分叉。

## 3. 提交链（相对 0373be2）

| 提交 | 内容 |
|---|---|
| be78417 | 合成反例钉失败（修复前 7 红 + 1 误差形态）：done/stub/pinned/deferred 失配、跨轮换站重打、同名异书误合并、alternates 丢失、退休 URL 零请求红线、普通路径兼容 |
| 73688d2 | 主体修复：identity 键 + _identity_keys/_load_terminal_identities/_rejection_identity_counts/_recent_rejection_identities/_attach_identity；split_queue 双键匹配；重定位保留 identity+alternates、终态免搜；写回点全挂 identity |
| e66b3c7 | 入库两侧 identity 字段类型校验对齐（只校验不写库） |
| 505d016 | 隔离验证门 verify628_launcher/gate（沿用 625 已审方案，仅改名与文案） |

## 4. 测试（先失败后修）

新文件 scripts/test_labeler_identity.py（10 例，OfflineGuardMixin socket/DNS 层离线守卫）：
1. 旧 book15 URL done → 重定位后仍跳过（修前红：todo 收进已完成书）
2. 旧 book15 URL stub → 仍终态（修前红）
3. 旧 book15 URL pinned（5 次拒收）→ 仍终态且日志计数 5 次、无 KeyError（修前红）
4. deferred 冷却 → 按身份后移队尾，后移计数同口径（修前红：计数 0）
5. 本轮成功写回 → 下轮引擎换站（URL 不同）→ 0 本重打（修前红；最直接的跨轮漂移复现）
6. 同名不同站内路径（同名异书）→ 不因书名合并跳过（修前红）
7. 重定位 hit 带 alternates → 条目带 engine_alternates + identity（修前红）
8. 主源 EngineSourceGaveUp → 按 engine_alternates 换源成功，产物记真实来源 alt.example（修前红）
9. 退休 URL 零请求：重定位整轮 http_get 零调用（修前即绿，红线钉）
10. 普通未重定位路径：split_queue 按 URL 匹配旧契约不变（修前即绿，兼容钉）

既有套件适配：test_douban_list.py 重定位 stats 断言加 skipped_terminal 键 + identity 键断言（3 例）。

## 5. 隔离验证结果（真实测试，非普通环境代验）

- 门机制：python verify628_launcher.py（树根）。空白名单 env 子进程（只取 PATH/SYSTEMROOT 等
  9 个系统键，编码键字面量，HOME/APPDATA 指向树内假目录，TEMP/TMP 重定向）；子进程 python -I -B
  verify628_gate.py 在导入任何测试/业务模块之前装三层护栏（socket connect/create_connection/
  create_server + DNS getaddrinfo/gethostbyname* 打桩拒绝 + C 级 audit hook 拦 socket.connect 与
  subprocess.Popen 白名单）。正控制（create_connection/getaddrinfo/urlopen 必须被拦）3/3 POS-OK、
  负控制（本地操作不受影响）NEG-OK，控制失败则门拒绝跑测试。
- 运行：HEAD=505d016，退出码 0。GATE_EXIT=0 tests=1051 failures=0 errors=0 skipped=0，
  guard stats：BLOCKED_NET=2、BLOCKED_DNS=1、BLOCKED_PROC=0、ALLOWED_PROC=0。
  安全日志：verify628-gate.log（树根，白名单键清单在文件头）。
- 普通门（同一棵树）：node scripts/run-py-tests.mjs → 22/22 文件、实际通过 1051 例、跳过 0；
  node scripts/run-mjs-tests.mjs → 4/4 文件、201 通过、0 失败（import_labels.mjs 改动侧）。

## 6. 残余与边界

- identity 只落在 labels.jsonl / labels-rejected.jsonl / labels-stub.jsonl，不写库表（labeled_books
  无对应列；书库身份键仍 title/author，与 628 无关）。
- douban/webnovel 名单线条目无 identity 键（其 URL 本来就稳定，不存在重定位漂移问题）；这些线的
  done 跳过另由 load_done_titles 书名预跳过覆盖，不在本次范围。
- 重定位免搜只按身份键滤；若某书终态记录既无 identity 又与当前引擎 URL 不同（理论上只有手工改库
  才会出现），回落到 split_queue URL 双键兜底，不误跳。
- verify628 脚本沿用 625 已审方案（任务书允许只读参考），仅改名/文案，未改门语义；627 Codex 对
  625 隔离合同的审查结论尚未出，若其裁定门有缺陷，本门同源需同步修。

LABELER628_IDENTITY_ALTERNATES_FIX_DONE
