# host 成功率二级排序(hostbucket42,已落地)

> 状态:**已实施**(2026-10-13 19:26,commit `eee0000`;产物 schema 向后兼容可行字段 `host_ok_score_24h`;Vercel zhaoshu-4kvolsv7h ● Ready)。下文是落地版口径;观测打点用 `scripts/source-pool-ranking-sidecar.mjs`(只读,不动库)。

## 落地的实际改动(与原静态提议的差异)

原提议里「排序键前置两层(hostHealthy + hostRecentOkLines)」简化为**一层 0/1 tie-break**:

```
最终排序链(shuyuan.ts readEngineRows → eligibleReadingSources):
  builtin DESC → probeRank → tierRank → checked_at DESC → host_ok_score_24h DESC → url 升序
```

- `host_ok_score_24h`: 同 `source_url` 在 24h 内是否有 non-phnx 干净 ok 行(0/1)
  —— CTE `recent_per_url` 按 `source_url` 字面量等值聚合,**放弃 host 派生键**
      (hkey JOIN 在 shuyuan_sources 多形态下不配对,url-suffix-join pglite 测试已抓过坑)
- 落点: probe/tier/checked_at **三键全等时**才生效——不打乱既有主序,只在并列里让「最近 24h 真实 ok」的副本前移
- 产物 schema(`pool-artifact.ts`):`host_ok_score_24h?: number` **可选**;旧产物缺字段按 0 读(`?? 0`),排序退化为改前全序;新产物恒由 SQL 生成 0/1(COALESCE→int4)

## SQL(落地)

```sql
WITH recent_per_url AS (
  SELECT source_url,
         MAX(CASE WHEN search_ok AND error NOT LIKE 'phoenix_ok:%' THEN 1 ELSE 0 END)::int AS has_clean_recent
  FROM source_admission
  WHERE search_checked_at > NOW() - INTERVAL '24 hours'
  GROUP BY source_url
)
SELECT src.source_url, ..., COALESCE(recent_per_url.has_clean_recent, 0) AS host_ok_score_24h
FROM shuyuan_sources src
JOIN LATERAL ( ... source_admission 最新行 ... ) a ON true
LEFT JOIN recent_per_url ON recent_per_url.source_url = src.source_url
ORDER BY src.source_url
```

## 兼容性 / 红线

- builtin 恒在最前,不动;selectable/traversal/fanout 同一 eligible 序列
- 聚合 SQL 失败 ⇒ 走现有 readEngineRows 错误路径回退,不产生新失败模式
- 产物消费侧可选字段,旧产物(无 host_ok_score_24h)0 处理,回滚路径同任意旧版产物

## 观测(2026-10-13 起)

sidecar 打点(`scripts/source-pool-ranking-sidecar.mjs`,输出 logs/source-pool-ranking-diff.jsonl):

| 时间(CST) | rows_input | moved_count(top24) | 释义 |
|---|---|---|---|
| 19:32 | 400 | 24 | 首日首轮,同 host 多副本并列换位为主 |
| 21:02 | 400 | 24 | 幅度稳定,无跨层洗牌迹象 |

moved_count 大头 = 同 probe/tier/checked_at 并列内的副本换位;非并列行不受影响。
走势结论需要至少 72h 打点再判;不预先调权。

## 待核实点(已核实)

- [x] readAdmissionFunnel 不复用——CTE 独立挂 LEFT JOIN,不进既有 funnel 读
- [x] 测试向量:5 个 pglite 套件(含 url-suffix-join)全过,32/32;非 pglite 3303/3303
- [x] 24h 窗长度:先按 24h 落地,72h 对照打点见 source-pool-phnx-aging.mjs;不调窗

## 回滚

- 代码反向 diff(eee0000)→ 字段回退可选,消费侧 `?? 0` 自动退化为旧全序;
- 产物旧版本直接可续用(可选字段设计即为此)。
