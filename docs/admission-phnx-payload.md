# phnx 前缀加 hash 短尾

> 状态:**已实施**(2026-10-13,P0-a)— commit `328d4d8` + runner bundle 上产 sha256 7d69355d…;测试补同步 `a58c6a2`(shuyuan.admission-round.test.ts 曾漏改,20:43 verbose 重跑抓到)。下文为落地版口径。
>
> 与原静态提议的差异: 短尾取 `hash.slice(2, 10)`(唉 8 位, 而不是 7..15——`1:` 头后 8 位),并加形态断言 `/^phoenix_ok:[0-9a-f]{8}$/`。

## 背景

- phnx 前缀 `phoenix_ok:`:runner 探 ok 后写入,Vercel 复测后才洗白进池
- 现状:`admission.ts` 写库侧 `outcome.error = isVercelConfirmedOk(prev,hash) ? prev!.error : input.okPrefix;` → 写死 `'phoenix_ok:'` 无后缀
- 决策判据全是 `startsWith(ADMISSION_PHOENIX_OK_PREFIX)`(advert:planProbeOrder / isRetestDue / recheckOutcome / challengeError,全是前缀兼容,**不会**因加 payload 失效)
- 池谓词:`shuyuan.ts` `error NOT LIKE 'phoenix_ok:%'`,同上,加 payload 不影响

## 提议改动

**改 1 处**:`admission.ts:1352` 把 `input.okPrefix` 拼上 rules_hash 短尾

```diff
  if (input.okPrefix && outcome.search_verdict === 'ok' && outcome.error === '') {
-   outcome.error = isVercelConfirmedOk(item.previous, item.hash) ? item.previous!.error : input.okPrefix;
+   outcome.error = isVercelConfirmedOk(item.previous, item.hash)
+     ? item.previous!.error
+     : `${input.okPrefix}${item.hash.slice(2, 10)}`;  // '1:abcdef12…' → 'phoenix_ok:abcdef12'
  }
```

注:`input.okPrefix` 激发条件是 phoenix runner(`refresh-runner.mjs --admission` 路径);Vercel 轮不传 okPrefix,不受影响。

## 兼容性论证

| 判读点 | 依据 | 是否受影响 |
|---|---|---|
| `error LIKE 'phoenix_ok:%' && NOT LIKE 'phoenix_ok:'` (shuyuan 池谓词) | 前缀后带任意字符都仍 LIKE `phoenix_ok:%` | 否 |
| `error.startsWith(ADMISSION_PHOENIX_OK_PREFIX)`(planProbeOrder / isRetestDue / recheckOutcome / challengeError) | startsWith 兼容追加 | 否 |
| `ADMISSION_PHOENIX_OK_PREFIX = 'phoenix_ok:'` 常量本身 | 不变 | 否 |
| `parseFailCount`(只剥 fail_count:) | phnx 行不是 fail_count: 开头,原样返回 | 否 |
| 既有行(裸 `phoenix_ok:`) | 已有 194 行是老形态,新代码读旧行兼容(startsWith 仍匹) | 否 |
| **观测/打点** | 若打点脚本用 `error = 'phoenix_ok:'` 精确等值,会失配 | **要核对此点**(本轮打点用 LIKE 'phoenix_ok:%',兼容) |

## 测试向量(静态提案)

```
旧行(裸 phoenix_ok:)  + 复测 ok  → 洗白(前缀整个去掉, error='')
旧行(裸 phoenix_ok:)  + 复测失败 → 直接出池(不补 strike)
新行(phoenix_ok:abcd1234) + 复测 ok → 洗白
新行 + 复测失败 → 直接出池(同旧)
runner 探到 ok 时 hash=1:abcdef1234567890..., 写入 error='phoenix_ok:abcdef12'
runner 探到 ok 时 hash=2:f00ba712345678..., 写入 error='phoenix_ok:f00ba712'
```

## 后续观测点

- 每轮 runner 打点后查 `payload8 / bare` 两行形态分布;到期洪峰(首波约 22:15+ CST)后 payload8 应逐步顶替 bare
- Vercel 22:00(UTC 14:00)独立轮对 phnx 行复测起级:payload 行/旧行同路径出池,观测是否有判据回归
- 若 48h 后 bare 仍占绝对多数,说明 runner 探不到新 ok(churn 枯竭),是另一课题,不是本改动问题

## 待核实点(已全部核实)

- [x] `refresh-runner.mjs` 的 `okPrefix` 字面量 = `'phoenix_ok:'`(scripts/shuyuan-refresh/entry.ts --admission 路径,runAdmissionRunnerRound 内调 runAdmissionBatch)
- [x] 写库出口唯一:runner 轮与 Vercel 轮都走 admission.ts 同一 worker 赋值点;Vercel 不传 okPrefix ⇒ 无 payload
- [x] 当前 phnx 行 hash 全 `1:` 前缀(194 行,2026-10-13 首窗核实)

