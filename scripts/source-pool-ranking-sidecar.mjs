#!/usr/bin/env node
// source-pool-ranking-sidecar.mjs — P0-b 落地的第一步: **只读** source_admission,
// 用「现状 §2.4 全序」vs「host bucket 前置提议」 各跑一次, 输出 diff 到 logs/。
// 不修改 src/, 不改 shuyuan.ts, 不发请求, 不动 runner, 不接触 DATABASE_URL。
//
// 出口码: 0 = ok;1 = ssh/psql 失败。

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(SCRIPT_DIR, '../logs/source-pool-ranking-diff.jsonl');
const TOP_N = 24;

const PSQL_SQL = `
WITH last24 AS (
  SELECT
    host, search_ok, error, search_checked_at, tier, source_url, rules_hash
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
  la.source_url, la.host, la.tier, la.search_ok, la.error, la.search_checked_at::text AS ts,
  COALESCE(a.has_clean_recent, 0) AS has_clean_recent,
  COALESCE(a.ok_24h, 0) AS ok_24h,
  COALESCE(a.tot_24h, 0) AS tot_24h
FROM last24 la
LEFT JOIN agg a USING (host)
ORDER BY la.search_checked_at DESC NULLS LAST
LIMIT 400;
`.trim();

async function psql(sqlPath_remote) {
  const { stdout } = await execFileAsync('ssh', [
    'phoenix',
    `sudo docker exec -i zhaoshu-tempdb-postgres-1 psql -U zhaoshu_app -d zhaoshu -At -F'\t' < ${sqlPath_remote}`,
  ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function cmpCurrent(a, b) {
  // §2.4 同实现: probe_reachable(近似 search_ok=true) → tier → checked_at → url
  const pa = a.search_ok === 't' ? 1 : 0;
  const pb = b.search_ok === 't' ? 1 : 0;
  if (pa !== pb) return pb - pa;
  if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  return a.source_url.localeCompare(b.source_url);
}

function cmpHostBucket(a, b) {
  if (a.has_clean_recent !== b.has_clean_recent) return Number(b.has_clean_recent) - Number(a.has_clean_recent);
  if (a.ok_24h !== b.ok_24h) return Number(b.ok_24h) - Number(a.ok_24h);
  return cmpCurrent(a, b);
}

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

async function main() {
  // 1) scp 传入 SQL
  const tmpLocal = resolve(SCRIPT_DIR, `.spbr-${Date.now()}.sql`);
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(tmpLocal, PSQL_SQL, 'utf8');
  const tmpRemote = `/tmp/spbr-${Date.now()}.sql`;
  await execFileAsync('scp', [tmpLocal, `phoenix:${tmpRemote}`], { timeout: 30_000 });
  rmSync(tmpLocal, { force: true });

  // 2) 跑 psql
  let raw = '';
  try {
    raw = await psql(tmpRemote);
  } finally {
    execFileAsync('ssh', ['phoenix', `rm -f ${tmpRemote}`], { timeout: 10_000 }).catch(() => {});
  }

  // 3) 排序
  const rows = raw.split(/\r?\n/).filter(Boolean).map(line => {
    const [source_url, host, tier, search_ok, error, ts, has_clean_recent, ok_24h, tot_24h] = line.split('\t');
    return {
      source_url, host, tier, search_ok, error,
      ts,
      has_clean_recent: Number(has_clean_recent),
      ok_24h: Number(ok_24h),
      tot_24h: Number(tot_24h),
    };
  });

  const cur = firstPerHost([...rows].sort(cmpCurrent), TOP_N);
  const pro = firstPerHost([...rows].sort(cmpHostBucket), TOP_N);
  const curUrls = cur.map(r => r.source_url);
  const proUrls = pro.map(r => r.source_url);
  const movedCount = curUrls.filter((u, i) => proUrls[i] !== u).length;
  const promoted = proUrls.filter((u, i) => curUrls.indexOf(u) > i);
  const demoted = curUrls.filter((u, i) => proUrls.indexOf(u) > i || proUrls.indexOf(u) === -1);

  const record = {
    ts: new Date().toISOString(),
    rows_input: rows.length,
    top_n: TOP_N,
    moved_count: movedCount,
    pool_size: { current: cur.length, proposal: pro.length },
    promoted_hosts_top25: [...new Set(pro.slice(0, 25).map(r => r.host))].slice(0, 8),
    demoted_hosts_top25: [...new Set(cur.slice(0, 25).map(r => r.host))].filter(h => !new Set(pro.slice(0, 25).map(r => r.host)).has(h)).slice(0, 8),
    sample_top5_current: cur.slice(0, 5).map(r => `${r.host} ok=${r.search_ok} clean=${r.has_clean_recent}`),
    sample_top5_proposal: pro.slice(0, 5).map(r => `${r.host} ok=${r.search_ok} clean=${r.has_clean_recent}`),
  };
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  console.log(JSON.stringify(record));
}

const isDirect = process.argv[1] && process.argv[1].endsWith('source-pool-ranking-sidecar.mjs');
if (isDirect) main().catch(err => {
  console.error(String(err && err.message ? err.message.slice(0, 200) : err).slice(0, 200));
  process.exitCode = 1;
});
