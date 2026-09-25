# 离线书源测试语料

`admission-174.json` 与 `smoke-174.json` 取自公开 legado 书源集合，于 2026-09-19 纳入仓库（上游采集日期未核实），仅用于离线解析、compile 冒烟及 admission 测试。

2026-09-19 已将敏感参数 `_token`、`nid`、`Q-GUID`、`dev_id`、`token` 替换为确定性的同形态合成值；两份语料中相同原值使用相同假值，UUID 连字符与小写 32 位十六进制形态保持不变。不含任何真实凭据，不可用于在线认证或书源访问。

`json-booklist/`（2026-09-25，jsonbl41）：JSON 搜索页 bookList 回归语料。`sfacg-search.json`、`ihuaben-search.json`、`ihuaben-search-empty.json` 是对公开搜索接口各做一次 GET 实采后的裁剪结果，只保留规则会用到的字段（书名/作者/ID/更新时间）。不含 cookie、token 或任何请求头。sfacg 接口实际返回的 Content-Type 是 `text/html`，响应体却是 JSON，测试按实采的 Content-Type 回放。
