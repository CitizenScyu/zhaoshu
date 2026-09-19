# legado 语义取证摘录（准入兼容 R7）

上游主仓 `gedoor/legado` 已被清空（main 分支只剩 README 与一份法律公告），取证依赖两个
独立 fork 快照，关键段落逐行 diff 一致后按上游原样采信：

- `Jer-Chao/legado@c2c4775`（取证日期 2025-07-07）
- `vvb2060/legado@5a65aa42`（取证日期 2025-07-17）

本目录存放准入兼容设计（`admission-compat-design.md`）所依据的证据摘录，防 fork 消失。
设计附录 A 的完整证据清单（E1–E9）仍以设计文档为准；此处固化其中三条地基证据的代码原文：

| 文件 | 证据 | 结论 |
|---|---|---|
| `E1-bookchaptersetlist-baseUrl.md` | E1 | chapterUrl 缺失/求值空 → 章节 url 取当前目录页 URL（非 href） |
| `E3-tocrule-default-null.md` | E3 | 实体默认值 null，getTocRule() 不注入规则默认值 |
| `E5-url-fields-baseUrl-convention.md` | E5 | URL 三件套共用「缺失 → 当前页 URL」约定 |

重取证要求（设计 R8）：legado 上游若改掉 chapterUrl 默认语义，本仓镜像语义过期，
M3+ 需定期复核本目录证据。
