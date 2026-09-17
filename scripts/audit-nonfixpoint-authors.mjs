#!/usr/bin/env node
// R02 只读审计：扫 labeled_books，列出「按 HTML_SOURCE 归一后 status !== 'ready'」的存量行
// —— 即**既非不动点、又无法归一**的潜在重复源，也就是导入器前置护栏的已知盲区
// （缺分号实体 / 未知实体 / 多层编码等，normalizeAuthor 故意拒绝猜）。
//
// 与导入器**解耦**：不 import import_labels.mjs 的 run/writeImportRecord，
// 本文件只出现 SELECT，没有任何 INSERT/UPDATE/DELETE/DDL。
//
// 用法:
//   node scripts/audit-nonfixpoint-authors.mjs --env scripts/backfill.env
//   DATABASE_URL=postgres://... node scripts/audit-nonfixpoint-authors.mjs
//
// 输出: 人工核验清单。BLIND_SPOT（status!=='ready'）> 0 时退出码 1 —— 需要人看的信号
// 不能静默通过；为 0 时退出码 0。
// 绝不打印连接串：错误信息里的 postgres:// URL 一律脱敏。
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HTML_SOURCE, normalizeAuthor } from './normalize_author.mjs';

const redact = (text) => String(text).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://<redacted>');

// 与 import_labels.mjs 同一套 env 解析规则（忽略空行/#、容忍 export 前缀与外围引号）
function loadEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq < 1) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[body.slice(0, eq).trim()] = value;
  }
  return env;
}

function parseArgs(argv) {
  const args = { envPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--env 缺少路径');
      args.envPath = value;
    } else throw new Error('未知参数: ' + argv[i]);
  }
  return args;
}

export async function audit(sql, log = console.log) {
  const queried = await sql`SELECT id, title, author, source_site FROM labeled_books ORDER BY id`;
  const rows = Array.isArray(queried) ? queried : (queried?.rows ?? []);

  const blind = [];   // 既非不动点、又无法归一 —— 护栏盲区
  const guarded = []; // 非不动点但可归一 —— 已由前置护栏覆盖
  const withAmp = []; // author 含 '&' 的行（与 T32 的统计交叉核对）
  for (const row of rows) {
    const author = row.author ?? '';
    if (author.includes('&')) withAmp.push(row);
    const n = normalizeAuthor(author, { sourceSite: HTML_SOURCE });
    if (n.status !== 'ready') blind.push({ row, n });
    else if (n.value !== author) guarded.push({ row, n });
  }

  log('审计目标: labeled_books，归一来源固定为 HTML_SOURCE=' + HTML_SOURCE + '（只读 SELECT）');
  log('总行数 = ' + rows.length);
  log('author 含 "&" 的行数 = ' + withAmp.length);
  log('');
  log('== A. BLIND_SPOT 既非不动点、又无法归一（护栏盲区，需人工核验）: ' + blind.length + ' 条 ==');
  for (const { row, n } of blind) {
    log(' - id=' + row.id + ' | status=' + n.status + ' | reasonCode=' + n.reasonCode +
        ' | reason=' + n.reason + ' | source_site=' + JSON.stringify(row.source_site ?? ''));
    log('   title=' + JSON.stringify(row.title));
    log('   author=' + JSON.stringify(row.author));
  }
  log('');
  log('== B. 非不动点但可归一（已由导入器前置护栏覆盖，仅供对照）: ' + guarded.length + ' 条 ==');
  for (const { row, n } of guarded) {
    log(' - id=' + row.id + ' | 归一后=' + JSON.stringify(n.value) + ' | source_site=' + JSON.stringify(row.source_site ?? ''));
    log('   title=' + JSON.stringify(row.title) + ' author=' + JSON.stringify(row.author));
  }
  log('');
  log('BLIND_SPOT_ROWS=' + blind.length);
  log('GUARDED_NONFIXPOINT_ROWS=' + guarded.length);
  log('AUTHOR_WITH_AMPERSAND_ROWS=' + withAmp.length);
  return blind.length;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  try {
    const args = parseArgs(process.argv.slice(2));
    let databaseUrl = process.env.DATABASE_URL;
    if (args.envPath) {
      const envPath = resolve(args.envPath);
      databaseUrl = loadEnvFile(envPath).DATABASE_URL;
      if (!databaseUrl) throw new Error(envPath + ' 里没有 DATABASE_URL');
    }
    if (!databaseUrl) throw new Error('缺少 DATABASE_URL(--env <path> 或环境变量)');
    const findings = await audit(neon(databaseUrl));
    process.exit(findings > 0 ? 1 : 0);
  } catch (error) {
    console.error('审计失败: ' + redact(error instanceof Error ? error.message : error));
    process.exit(2);
  }
}
