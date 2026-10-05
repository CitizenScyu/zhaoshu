# bphysical788-report：物理请求门支持 await 并接入逐 host 限速

## 0. 三字段与基点
- 任务书：D:/ClaudeCode/projects/zhaoshu/codex-fence-followup-20260929/task-bphysical788-opus.md
- pwd：D:\ClaudeCode\projects\zhaoshu\novel-finder\.claude\worktrees\agent-a6edc3cd302cc3f48
- 分支：bphysical788-request-gate，自 b2394564d6bed12375843ab307c45f0d3a774f65 开出；HEAD=ccdfbfe

## 1. 基点代码核实（与 747d033 描述一致，已在基点逐条核过）
- runtime-download/engine.ts createSourceTransport：外层仅一次 `limiter.acquire(hostOf(url))` 后整包交给 fetchSourceText——初始/redirect/备用 host 的后续物理发射不再取许可。
- src/lib/source-fetch.ts：beforeRequest 为 `(signal,url?)=>Promise<void>`；beforeFetch 为同步 `(signal,url)=>void`，每次物理发射（含跳转后 current、换 host 后起点）都走；换 host 重试传 skipFirstBeforeRequest=true 使预算不重复扣。
- SourceHttpError 携 responseHost（真正返回响应的站）。上述合同保持不变。

## 2. 源码改动（2 个源码文件 +2 个测试草稿文件，均在限内）
- src/lib/source-fetch.ts（66c69cc、0c8d56d）：
  - FetchSourceOptions/attemptOnce 的 beforeFetch 类型放宽为 `void | Promise<void>`，调用处 `await beforeFetch?.(signal,current)`；
  - 门成功后**门后** `signal.throwIfAborted()`（在 try 外，中止不标 fromBeforeRequest），随后才启动连接计时/fetch；
  - 门异常仍标 `fromBeforeRequest` ⇒ 不触发换 host 重试、不计源站失败（isTransportError 既有排除）。
- runtime-download/engine.ts（f2f8591）：
  - 删除外层 acquire；向 fetchSourceText 组合 beforeFetch：先 await 调用方已有物理策略门（callerGate），再按该次 current URL 真实 hostname `limiter.acquire(key,{signal})`；
  - SourceTransport options 增同形可选 beforeFetch；beforeRequest 原样透传（预算合同不变）；
  - 成功 recordSuccess 归返回 page.url 的 host；HTTP 失败归 SourceHttpError.responseHost，无 responseHost 时归最近实际发射 host（lastHost，随每次许可更新），不把备用 host 记到初始 host；仅 status 为数字（源站行为类）计 recordFailure，取消/门拒绝不计；
  - 无 limiter 且无 callerGate 时不注入 beforeFetch（行为同旧缺省）；hostOf 沿用，不合并 apex/www。
- 不变项：skipFirstBeforeRequest 语义、source-host-health 站点健康模型、SourceReader 的 beforeFetch 调用方（同步签名兼容）。

## 3. 合成测试草稿（只写未跑，文件在仓、断言具名）
- src/lib/source-fetch-beforefetch.test.ts（6 用例）：异步门 resolve 后才发射；302 跳转后新 current 逐次过门；传输失败换备用 host 两次门两次发射；异步门拒绝零 fetch+标 fromBeforeRequest+不换 host；门以 signal 拒绝（限速器合同）不发射；门 resolve 但父 signal 已中止由门后复查拦下；同步旧门兼容。
- runtime-download/engine-request-gate.test.ts（9 用例）：单页 acquire 恰一次无初始双扣；换备用 host 后 acquire=[初始,备用] 且 success 归 page.url host；429 recordFailure 带 retryAfterMs；传输失败后备用 5xx 记备用 host 不记初始 host；许可拒绝零 fetch 零 recordFailure；callerGate 先于 acquire；callerGate 拒绝零 fetch 零 acquire；beforeRequest 恰一次（换 host 不重复扣）；无 limiter 时 callerGate 仍生效。
- 两文件均 stub global fetch 合成响应、mock limiter，不真联网；transport 测试沿用 source-fetch.test.ts 的 isRetiredBuiltinHost 钉 false 约定（book15 载体按活跃形态测传输层）。

## 4. 预算与限制
- 工具调用约 34/40；源码改动 2 文件（+2 测试草稿）共约 320 行（含报告）；全部小步 commit（66c69cc/0c8d56d/f2f8591/3725237/c04f724/be51fff/7b29ad9/ccdfbfe/骨架 f56744c）。
- 未跑任何测试/类型/构建（任务书禁）；测试草稿未经验证，it 名与断言是交付物而非结果，失败可能性自担（如 Response mock 细节、AbortSignal 语义）。
- 未实现 flock/跨进程共享；未改 books 仓、常量、storage/SQL/租约/预算模块；不合并/push/部署。
- 风险注记：lastHost 在许可成功前先更新（取许可的 host 即反馈兜底 host）；若 acquire 本身抛错则该 host 已发射未遂，recordFailure 不触发（无 status）——与旧外层实现一致。

BPHYSICAL788_DONE
