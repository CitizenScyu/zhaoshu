# 下载存储目标合同

默认上传目标依次取 `options.repository`、`env.ZHAOSHU_BOOKS_REPO`。不再用平台执行仓变量 `GITHUB_REPOSITORY`，也没有真实仓名兜底。显式空字符串视为错误，不回退到环境目标。

目标允许整体空格裁剪，必须恰为合法的 `owner/repo` 两段；错误仅含固定码。一次解析的同一元组用于仓库可写资格反查和GitHub写客户端。branch优先级保持 `options.branch ?? DOWNLOAD_TARGET_BRANCH ?? 'main'`，非空分支原值保留；不以trim改变分支身份。

`github` 与 `repositoryId` 必须同时提供或同时缺省，按 `undefined` 判定；单侧注入在客户端装配前拒绝。完整DI是可信调用方合同：不会检查client闭包的真实仓目标，也不要求新仓目标环境；ID仍须正安全整数、branch仍须非空字符串。未注入storage时，仍需数据库配置。

默认反查没有合资格仓行就失败，不回退执行仓、不自动注册或建仓。注入storage但未注入目标对时，仍通过数据库反查仓ID。

## 迁移边界

- 本改动只分离下载默认上传目标与平台执行仓。旧 `github.ts` dispatch也消费 `ZHAOSHU_BOOKS_REPO`；改该键可能影响派单目标，本改动不保证dispatch已分离。
- 本地代码不搬迁、不开启或恢复workflow，不调整凭据、仓权限或生产配置。GC、reader等其他消费者须独立核对，不从本入口推定全链同目标。
- 发布前另行核对配置、资格仓行与写权限；完整DI调用方须保证client、repositoryId、branch一致。
- 源码回滚会恢复旧目标解释；环境/平台配置的恢复必须单独处理，不能用Git回滚代替。
- 合成合同测试只写未运行；没有真实数据库、GitHub权限或部署验证结论。
