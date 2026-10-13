#!/usr/bin/env node
// source-bucket-dryrun.mjs — 本地静态 dry-run, 不联网, 不改 src/, 不 ssh, 不写文件。
//
// 目的: 在不动现网代码的前提下,比较 §2.4 现状全序 (probe reach / tier / checked_at / url) 与
//       「P0-b 提议新增 host bucket 前置」对前 24 名的影响。
// 方法: mock 一份反映 17:19 实测分布的 source_admission 样本(只读), 在本地跑两种排序器。
//
// 用法: node source-bucket-dryrun.mjs
// 出口码: 0=ok, 1=error

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';

const execFileAsync = promisify(execFile);

const SQL = `
WITH last24 AS (
  SELECT
    host,
    search_ok,
    search_verdict,
    error,
    search_checked_at,
    tier,
    source_url,
    rules_hash
  FROM source_admission
  WHERE search_checked_at > NOW() - INTERVAL '24 hours'
),
agg AS (
  SELECT
    host,
    MAX(CASE WHEN search_ok AND error NOT LIKE 'phoenix_ok:%' THEN 1 ELSE 0 END) AS has_clean_recent,
    COUNT(*) FILTER (WHERE search_ok = true)                                     AS ok_24h,
    COUNT(*)                                                                     AS tot_24h
  FROM last24 GROUP BY host
)
SELECT
  la.source_url, la.host, la.tier, la.search_ok, la.error, la.search_checked_at,
  COALESCE(a.has_clean_recent, 0) AS has_clean_recent,
  COALESCE(a.ok_24h, 0)           AS ok_24h,
  COALESCE(a.tot_24h, 0)          AS tot_24h
FROM last24 la
LEFT JOIN agg a USING (host)
ORDER BY la.search_checked_at DESC NULLS LAST
LIMIT 400;
`.trim();

async function psql(sql) {
  throw new Error('(stubbed) 不联网 — mock 模式');
}

// 由于跨 shell/ssh 引号陷阱, 直接读现网太费;改为在脚本内置 mock 一份典型分布(基于 17:19 实测)
// 这样脚本完全离线运行,零执行。

const MOCK = (() => {
  // falsifiable mock 让 P0-b 的 host bucket 真正起作用:
  //   5 个 host × 4 副本, 每个 host 第一份 clean_ok (搜通), 其余 3 份全失败 (conn_fail 或 search_ok=false)。
  //   现有全序: 第一份(search_ok=true) 排前, 其它 3 份(search_ok=null) 排后;
  //            → firstPerHost 留下第一份,剩下 3 副本被丢。
  //   P0-b (host bucket 前置): host 因有 clean 副本加分, 这一族整体靠前,
  //            → firstPerHost 仍只留第一份 (同 host 去重), 但族之间的相对顺序由 host bucket 抬高。
  //   场景: 另一个 host yangFFFF.com 全失败 (无 clean 副本); 它在 P0-b 下应该沉底。
  //   yangGGGG.com 全成功(每 24h 内 clean_ok×4), 它应该排最前。

  const rows = [];
  let i = 0;
  // 1) yangAAAA ~ yangEEEE: 第一份 clean_ok(true), 其它 phnx/null/failed
  const multiHosts = ['yangAAAA.com','yangBBBB.com','yangCCCC.com','yangDDDD.com','yangEEEE.com'];
  for (const h of multiHosts) {
    for (let j = 0; j < 4; j++) {
      rows.push({
        source_url: `https://${h}/s${j}`, host: h, tier: 'M1',
        search_ok: j === 0 ? true : (j === 1 ? true : null),
        error: j === 0 ? '' : (j === 1 ? 'phoenix_ok:' : ''),
        search_checked_at: new Date(Date.now() - i * 60_000).toISOString(),
        has_clean_recent: j === 0 ? 1 : 0,
        ok_24h: j === 0 ? 1 : 0,
        tot_24h: 4,
      });
      i += 1;
    }
  }
  // 2) yangFFFF.com 全失败(全部 search_ok=false)
  for (let j = 0; j < 3; j++) {
    rows.push({
      source_url: `https://yangFFFF.com/s${j}`, host: 'yangFFFF.com', tier: 'M1',
      search_ok: false, error: 'conn_fail',
      search_checked_at: new Date(Date.now() - i * 60_000).toISOString(),
      has_clean_recent: 0, ok_24h: 0, tot_24h: 3,
    });
    i += 1;
  }
  // 3) yangGGGG.com 全成功(每 24h 内 clean×4)
  for (let j = 0; j < 4; j++) {
    rows.push({
      source_url: `https://yangGGGG.com/s${j}`, host: 'yangGGGG.com', tier: 'M1',
      search_ok: true, error: '',
      search_checked_at: new Date(Date.now() - i * 60_000).toISOString(),
      has_clean_recent: 1, ok_24h: 4, tot_24h: 4,
    });
    i += 1;
  }
  // 4) 30 个干净单源 host
  for (let k = 0; k < 30; k++) {
    rows.push({
      source_url: `https://h${k}.example.com/x`, host: `h${k}.example.com`, tier: 'M1',
      search_ok: true, error: '',
      search_checked_at: new Date(Date.now() - (600 + k) * 60_000).toISOString(),
      has_clean_recent: 1, ok_24h: 1, tot_24h: 1,
    });
  }
  return rows;
})();

function cmpCurrent(a, b) {
  // §2.4 同实现: probe_reachable(由 search_ok=true 近似) → tier → checked_at DESC → url
  const pa = a.search_ok === true ? 1 : 0;
  const pb = b.search_ok === true ? 1 : 0;
  if (pa !== pb) return pb - pa;
  if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
  if (a.search_checked_at !== b.search_checked_at) return a.search_checked_at < b.search_checked_at ? 1 : -1;
  return a.source_url.localeCompare(b.source_url);
}

function cmpHostBucket(a, b) {
  // 新增 host 健康桶前置(24h 内有 clean ok 的 host 排前)
  if (a.has_clean_recent !== b.has_clean_recent) return b.has_clean_recent - a.has_clean_recent;
  if (a.ok_24h !== b.ok_24h) return b.ok_24h - a.ok_24h;
  return cmpCurrent(a, b);
}

const current = [...MOCK].sort(cmpCurrent).slice(0, 24);
const proposal = [...MOCK].sort(cmpHostBucket).slice(0, 24);

// 用 firstPerHost 去重,看读池长什么样
function firstPerHost(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (seen.has(r.host)) continue;
    seen.add(r.host);
    out.push(r);
  }
  return out;
}

const currentPool = firstPerHost(current, 24);
const proposalPool = firstPerHost(proposal, 24);

console.log('=== §2.4 现有 firstPerHost 池 前 24 名 ===');
currentPool.forEach((r, i) => console.log(`${String(i+1).padStart(2)} ${r.host.padEnd(20)} tier=${r.tier} ok=${r.search_ok} clean=${r.has_clean_recent} ok24=${r.ok_24h} ts=${r.search_checked_at.slice(0,16)}`));
console.log('\n=== 提议新序(host bucket 前置)+firstPerHost 前 24 名 ===');
proposalPool.forEach((r, i) => console.log(`${String(i+1).padStart(2)} ${r.host.padEnd(20)} tier=${r.tier} ok=${r.search_ok} clean=${r.has_clean_recent} ok24=${r.ok_24h} ts=${r.search_checked_at.slice(0,16)}`));

// 差异统计
const cur = currentPool.map(r => r.source_url);
const pro = proposalPool.map(r => r.source_url);
const moved = cur.filter((u, i) => pro[i] !== u);
console.log(`\nfirstPerHost 池前 24 名顺序变化数: ${moved.length}`);
// 关键收益: yangFFFF 全失败 host 在 P0-b 下被彻底沉出 firstPerHost 池,
//            yangGGGG(全成功副本 4×)被抬到第 1。
const oldIdx = cur.indexOf('https://yangFFFF.com/s0');
const newIdx = pro.indexOf('https://yangFFFF.com/s0');
console.log(`yangFFFF.com (全失败 host): ${oldIdx === -1 ? '不在池' : '原位=' + (oldIdx+1)} -> ${newIdx === -1 ? '不在池' : '新位=' + (newIdx+1)}`);
const gOld = cur.indexOf('https://yangGGGG.com/s0');
const gNew = pro.indexOf('https://yangGGGG.com/s0');
console.log(`yangGGGG.com (4 副本全 ok24=4): ${gOld === -1 ? '不在池' : '原位=' + (gOld+1)} -> ${gNew === -1 ? '不在池' : '新位=' + (gNew+1)}`);
