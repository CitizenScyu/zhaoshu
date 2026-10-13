#!/usr/bin/env node
// source-pool-phnx-aging.mjs — phnx(phoenix_ok:*) 占位行按时间窗老化打点。
// 只读 source_admission;不联网除 ssh phoenix psql;不写 DB;不碰凭据。
//
// 用法: node source-pool-phnx-aging.mjs
// 出口: 0 = ok;1 = ssh/psql 失败。

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(SCRIPT_DIR, '../logs/source-pool-phnx-aging.jsonl');

const SQL = `
SELECT
  count(*) FILTER (WHERE search_checked_at > NOW() - INTERVAL '1 hour')   AS w_1h,
  count(*) FILTER (WHERE search_checked_at > NOW() - INTERVAL '4 hours')  AS w_4h,
  count(*) FILTER (WHERE search_checked_at > NOW() - INTERVAL '20 hours') AS w_20h,
  count(*) FILTER (WHERE search_checked_at > NOW() - INTERVAL '48 hours') AS w_48h,
  count(*) FILTER (WHERE search_checked_at > NOW() - INTERVAL '7 days')   AS w_7d,
  count(*)                                                                AS total,
  -- phnx-payload42:P0-a 后新行带 hash 短尾(11+8=19 字符);旧裸行等长 11。跟踪顶替速率。
  count(*) FILTER (WHERE length(error) > 11)                              AS payload8,
  count(*) FILTER (WHERE length(error) = 11)                              AS bare11,
  -- 视野扩充:同一张表上已扣 phnx 的干净 ok(池遥控真身) 与 24h 非 phnx 失败行(churn 供给)
  (SELECT count(*) FROM source_admission WHERE search_ok IS TRUE AND error NOT LIKE 'phoenix_ok:%') AS clean_ok,
  (SELECT count(*) FROM source_admission WHERE search_ok IS FALSE AND error NOT LIKE 'phoenix_ok:%' AND search_checked_at > NOW() - INTERVAL '24 hours') AS churn_24h
FROM source_admission
WHERE error LIKE 'phoenix_ok:%' AND search_ok = true;
`.trim();

async function main() {
  const tmpLocal = resolve(SCRIPT_DIR, `.sppa-${Date.now()}.sql`);
  writeFileSync(tmpLocal, SQL, 'utf8');
  const tmpRemote = `/tmp/sppa-${Date.now()}.sql`;
  await execFileAsync('scp', [tmpLocal, `phoenix:${tmpRemote}`], { timeout: 30_000 });
  rmSync(tmpLocal, { force: true });

  let raw = '';
  try {
    const { stdout } = await execFileAsync('ssh', [
      'phoenix',
      `sudo docker exec -i zhaoshu-tempdb-postgres-1 psql -U zhaoshu_app -d zhaoshu -At -F' ' < ${tmpRemote}`,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    raw = stdout.trim();
  } finally {
    execFileAsync('ssh', ['phoenix', `rm -f ${tmpRemote}`], { timeout: 10_000 }).catch(() => {});
  }

  const [w_1h, w_4h, w_20h, w_48h, w_7d, total, payload8, bare11, clean_ok, churn_24h] = raw.split(' ').map(Number);
  const record = {
    ts: new Date().toISOString(),
    phnx: { w_1h, w_4h, w_20h, w_48h, w_7d, total },
    // phnx-payload42:新行带 hash8='phoenix_ok:'+8 位=19 字符;旧裸行=11。到期洪峰后 payload8 应顶替 bare11。
    payload8, bare11,
    // overdue = 超 20h 复测窗仍未被 Vercel 复测的存量
    overdue_20h: total - w_20h,
    overdue_48h: total - w_48h,
    clean_ok, churn_24h,
  };
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  console.log(JSON.stringify(record));
}

const isDirect = process.argv[1] && process.argv[1].endsWith('source-pool-phnx-aging.mjs');
if (isDirect) main().catch(err => {
  console.error(String(err && err.message ? err.message.slice(0, 200) : err).slice(0, 200));
  process.exitCode = 1;
});
