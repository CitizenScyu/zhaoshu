#!/usr/bin/env node
// source-pool-buckets: 打点 source_admission 分桶, 落 logs/source-pool-buckets.jsonl
// - 只读不写 DB; 不接触 DATABASE_URL; 走 ssh + docker exec
// - 出口码: 0=ok, 1=error

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(SCRIPT_DIR, '../logs/source-pool-buckets.jsonl');
const PATHS_REL_TO_SCRIPT = './source-pool-buckets.sql';

const SQL = `
WITH bucketed AS (
  SELECT
    search_ok, search_verdict, error, search_checked_at,
    CASE
      WHEN search_ok IS NULL THEN 'null'
      WHEN search_ok=true AND error LIKE 'phoenix_ok:%' THEN 'phnx'
      WHEN search_ok=true AND error LIKE 'recheck_fail:%' THEN 'recheck_fail'
      WHEN search_ok=true THEN 'clean_ok'
      ELSE 'rejected'
    END AS bucket
  FROM source_admission
)
SELECT
  COUNT(*) FILTER (WHERE bucket='null') AS null_count,
  COUNT(*) FILTER (WHERE bucket='phnx') AS phnx,
  COUNT(*) FILTER (WHERE bucket='phnx' AND search_checked_at < NOW() - INTERVAL '20 hours') AS phnx_overdue20h,
  COUNT(*) FILTER (WHERE bucket='clean_ok') AS clean_ok,
  COUNT(*) FILTER (WHERE bucket='recheck_fail') AS recheck_fail,
  COUNT(*) FILTER (WHERE search_verdict='conn_fail') AS conn_fail,
  COUNT(*) FILTER (WHERE search_verdict='no_result') AS no_result,
  COUNT(*) FILTER (WHERE search_verdict='http_4xx') AS http_4xx,
  COUNT(*) FILTER (WHERE search_verdict='http_5xx') AS http_5xx,
  COUNT(*) FILTER (WHERE search_verdict='url_invalid') AS url_invalid,
  COUNT(*) FILTER (WHERE search_verdict='challenge') AS challenge,
  COUNT(*) FILTER (WHERE search_verdict='ok') AS ok,
  COUNT(*) FILTER (WHERE search_verdict='query_insensitive') AS q_insens
FROM bucketed;
SELECT COUNT(*) FROM shuyuan_sources WHERE disabled_at IS NULL;
`.trim();

async function psqlViaScp() {
  // 写临时 SQL 到 /tmp, 用 scp + ssh stdin 执行, 避免命令行引号转义困境
  const tmpName = `/tmp/spb-${Date.now()}.sql`;
  await execFileAsync('scp', [resolve(SCRIPT_DIR, PATHS_REL_TO_SCRIPT), `phoenix:${tmpName}`], { timeout: 30_000 });
  try {
    const { stdout } = await execFileAsync('ssh', ['phoenix', `sudo docker exec -i zhaoshu-tempdb-postgres-1 psql -U zhaoshu_app -d zhaoshu -At < ${tmpName}`], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } finally {
    await execFileAsync('ssh', ['phoenix', `rm -f ${tmpName}`], { timeout: 10_000 }).catch(() => {});
  }
}

async function main() {
  const raw = await psqlViaScp();
  const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
  const row = lines[0] || '';
  const cols = row.split('|');
  const names = ['null','phnx','phnx_overdue20h','clean_ok','recheck_fail','conn_fail','no_result','http_4xx','http_5xx','url_invalid','challenge','ok','q_insens'];
  const out = { ts: new Date().toISOString() };
  for (let i = 0; i < names.length; i++) out[names[i]] = Number(cols[i] || 0);
  out.shuyuan_valid = Number(lines[1] || 0);
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(out) + '\n', 'utf8');
  console.log(JSON.stringify(out));
}

const isDirect = process.argv[1] && process.argv[1].endsWith('source-pool-buckets.mjs');
if (isDirect) main().catch(err => {
  console.error(String(err && err.message ? err.message.slice(0, 200) : err).slice(0, 200));
  process.exitCode = 1;
});
