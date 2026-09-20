#!/usr/bin/env node
// admission 人工种库脚本（m2-scaleout §7：W1 四源是 E 节实测可达的确定名单，
// admission 结论可人工核验一次后写库）。用途：hub 不可达导致 cron 准入批次跑不到时，
// 手动为已知可达源把 source_admission 结论种进库——配合改动 A（host 门随池刷新），
// 种库后引擎源即可过运行时 host 门进入取书池。
//
// 用法：
//   node scripts/seed-admission.mjs --env .env.pull [--url <source_url> ...] [--dry-run]
// 不带 --url 时用 W1 默认四源。--dry-run 只跑真实编译/搜索并打印将写入的行，不写库。
//
// 复用 rule-engine/admission.ts 的真逻辑（compileAdmission/searchAdmission/runAdmissionBatch/
// rulesHash），行格式与 rules_hash 与 cron 准入批次逐字一致。只写 source_admission，
// 不碰 shuyuan_sources / shuyuan_meta。
//
// 凭据纪律：不打印 DATABASE_URL 或任何密钥；汇总只输出 host / verdict 计数。
//
// TS 加载：经 scripts/ts-esm-loader.mjs（唯一 TS shim：esbuild 钩子，--import 与 register() 两用）import 仓库 TS——
// 本仓库 tsconfig 是 bundler 目标，`node --experimental-strip-types` 无法加载 admission.ts
// 的依赖图（@/ 别名 / 无扩展名相对导入 / TS 参数属性 / 跨模块类型导入）。

import { register } from 'node:module';
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

register('./ts-esm-loader.mjs', import.meta.url);
const {
  compileAdmission, searchAdmission, runAdmissionBatch, rulesHash,
  defaultAdmissionTransport, DEFAULT_ADMISSION_KEYWORD,
} = await import('../src/lib/rule-engine/admission.ts');

// W1 四源（m2-scaleout §2.2；jhsssd 三个 s）。这里是规范化后的 bookSourceUrl origin。
const W1_DEFAULT_URLS = [
  'https://www.yingsx.com',
  'https://www.kanshuw.com',
  'https://www.czhiyao.com',
  'https://m.jhsssd.com',
];

// 与 shuyuan.ts normalizeUrl 同款：去首尾空白 + 剥末尾斜杠（source_url 的存库形态）。
function normalizeUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// 展示用关键词（与 admission.ts expandAdmissionSearchUrl 同口径：source.checkKeyWord 优先）。
function keywordOf(source) {
  const raw = source && typeof source === 'object' ? source.checkKeyWord : undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_ADMISSION_KEYWORD;
}

// 版本自洽自查（复审 P3）：source_admission.rules_hash 形如 `<engine_semantics_version>:<contentRevision>`
// （compile.ts engineVersionedKey / engineSourceRevision）。种库前确认每行「版本列」与 rules_hash 前缀
// 同源，否则写进库的行会像修复前那样自相矛盾——rules_hash 带 `1:`/`2:` 前缀、engine_semantics_version
// 却取 schema 默认 0（INSERT 列清单漏写该列所致）。现 INSERT 已显式带上该列（取 admission.ts 同一批
// runAdmissionBatch 计算的值），此查确保不再分叉；发现错配即拒绝写库，暴露上游口径问题。
function assertVersionSelfConsistent(rows) {
  for (const row of rows) {
    const prefix = Number(String(row.rules_hash).split(':', 1)[0]);
    if (!Number.isInteger(prefix)) {
      throw new Error(`[seed-admission] 版本自查失败：host=${row.host} rules_hash 无版本前缀`);
    }
    if (row.engine_semantics_version !== prefix) {
      throw new Error(
        `[seed-admission] 版本自查失败：host=${row.host} engine_semantics_version=${row.engine_semantics_version} ` +
        `≠ rules_hash 版本前缀=${prefix}（行内元数据不自洽，拒绝写库）`,
      );
    }
  }
}

function parseArgs(argv) {
  const args = { env: null, urls: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env') args.env = argv[++i];
    else if (argv[i] === '--url') args.urls.push(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

function loadEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // vercel env pull 写的值带引号，必须剥掉（否则 invalid connection string）。
    if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.env) throw new Error('缺少 --env <path>');
  const env = loadEnvFile(resolve(args.env));
  if (!env.DATABASE_URL) throw new Error('env 文件缺 DATABASE_URL');
  const sql = neon(env.DATABASE_URL);

  const wanted = (args.urls.length ? args.urls : W1_DEFAULT_URLS).map(normalizeUrl);
  console.log(`[seed-admission] 目标源 ${wanted.length} 个${args.dryRun ? '（dry-run，不写库）' : ''}`);

  // 从 shuyuan_sources 读 source json（脚本只读，不改这张表）。
  const stored = await sql`
    SELECT source_url, source FROM shuyuan_sources
    WHERE source_url IN (
      SELECT value FROM jsonb_array_elements_text(${JSON.stringify(wanted)}::jsonb))`;
  const byUrl = new Map(stored.map((row) => [row.source_url, row.source]));

  const candidates = [];
  for (const url of wanted) {
    const source = byUrl.get(url);
    if (!source) { console.error(`  跳过：${hostOf(url)} 不在 shuyuan_sources`); continue; }
    candidates.push({ url, source });
  }
  if (candidates.length === 0) throw new Error('没有可种库的源（目标都不在 shuyuan_sources）');

  // 候选池的声明 host 集合（admission 门校验用）。
  const declaredHosts = new Set(candidates.map((c) => hostOf(c.url)).filter(Boolean));

  // existing 传空 Map ⇒ 全部视为新源、强制真实搜索一遍（种库语义就是「现在核验一次」）。
  // maxProbes 提到候选数，保证每个源都跑真实搜索，不被默认 5 上限截断。
  const result = await runAdmissionBatch({
    candidates,
    declaredHosts,
    existing: new Map(),
    fetchPage: defaultAdmissionTransport,
    signal: new AbortController().signal,
    maxProbes: candidates.length,
  });

  // 写库前自查：行内 engine_semantics_version 必须与 rules_hash 的版本前缀同源（见函数注释）。
  assertVersionSelfConsistent(result.rows);

  // 展示行：host / verdict / keyword / compile / search_ok（不含任何凭据）。
  console.log('[seed-admission] 将写入的行：');
  for (const row of result.rows) {
    const kw = keywordOf(byUrl.get(row.source_url));
    console.log(`  host=${row.host} verdict=${row.search_verdict || '(compile拒)'} ` +
      `keyword=${kw} compile_ok=${row.compile_ok} search_ok=${row.search_ok}`);
  }
  // verdict 计数汇总（报告口径）。
  const byVerdict = {};
  for (const row of result.rows) {
    const key = row.compile_ok ? (row.search_verdict || 'untested') : 'compile_rejected';
    byVerdict[key] = (byVerdict[key] ?? 0) + 1;
  }
  console.log('[seed-admission] verdict 计数：', JSON.stringify(byVerdict),
    `probed=${result.probed} compile_ok=${result.compileOk} compile_rejected=${result.compileRejected}`);

  if (args.dryRun) { console.log('[seed-admission] dry-run：未写库。'); return; }
  if (result.rows.length === 0) { console.log('[seed-admission] 无行可写。'); return; }

  // 与 shuyuan.ts writeAdmissionRows 同款 upsert：ON CONFLICT (source_url) DO UPDATE。
  await sql`
    INSERT INTO source_admission
      (source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash, engine_semantics_version, host, error)
    SELECT source_url, tier, compile_ok, core_field_mask, search_ok, search_verdict, search_checked_at, rules_hash, engine_semantics_version, host, error
    FROM jsonb_to_recordset(${JSON.stringify(result.rows)}::jsonb)
      AS t(source_url text, tier text, compile_ok boolean, core_field_mask jsonb, search_ok boolean,
           search_verdict text, search_checked_at timestamptz, rules_hash text, engine_semantics_version integer, host text, error text)
    ON CONFLICT (source_url) DO UPDATE SET
      tier = EXCLUDED.tier, compile_ok = EXCLUDED.compile_ok, core_field_mask = EXCLUDED.core_field_mask,
      search_ok = EXCLUDED.search_ok, search_verdict = EXCLUDED.search_verdict,
      search_checked_at = EXCLUDED.search_checked_at, rules_hash = EXCLUDED.rules_hash,
      engine_semantics_version = EXCLUDED.engine_semantics_version,
      host = EXCLUDED.host, error = EXCLUDED.error`;
  const okHosts = result.rows.filter((r) => r.compile_ok && r.search_ok === true).map((r) => r.host);
  console.log(`[seed-admission] 已写 ${result.rows.length} 行；ok 态 host ${okHosts.length} 个：${okHosts.join(', ') || '(无)'}`);
  console.log('[seed-admission] 提示：ok 态 host 会在下次 getReadingPool 时经改动 A 刷入运行时门。');
}

// rulesHash 是导出的确定函数，顺带做一次自证（rules 一变哈希即变），不依赖 DB / 网络。
if (process.argv.includes('--selftest')) {
  const a = rulesHash({ bookSourceUrl: 'https://x.example', searchUrl: 's', ruleSearch: { name: 'h1' } });
  const b = rulesHash({ bookSourceUrl: 'https://x.example', searchUrl: 's', ruleSearch: { name: 'h2' } });
  console.log('[selftest] rulesHash 稳定且规则敏感：', a !== b, a.slice(0, 12), b.slice(0, 12));
  const c = compileAdmission({ bookSourceUrl: 'https://x.example', searchUrl: 'https://x.example/s?q={{key}}',
    ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' }, ruleContent: { content: '.c' } });
  console.log('[selftest] compileAdmission:', JSON.stringify({ ok: c.ok, tier: c.tier }));
  void searchAdmission; // 引用以证明已成功 import（真实搜索在 run() 里经 runAdmissionBatch 触发）
  // 版本自洽自查的判别力（不依赖 DB/网络）：rules_hash 前缀与版本列同源的行通过，伪造错配必抛。
  const seedHash = rulesHash({ bookSourceUrl: 'https://x.example', searchUrl: 's', ruleSearch: { name: 'h1' } });
  const seedVersion = Number(seedHash.split(':', 1)[0]);
  assertVersionSelfConsistent([{ host: 'x.example', rules_hash: seedHash, engine_semantics_version: seedVersion }]);
  let mismatchCaught = false;
  try {
    assertVersionSelfConsistent([{ host: 'x.example', rules_hash: seedHash, engine_semantics_version: seedVersion + 99 }]);
  } catch { mismatchCaught = true; }
  console.log('[selftest] 版本自洽自查：同源通过、错配即抛 =', mismatchCaught, '（前缀', seedVersion, '）');
  if (!mismatchCaught) { console.error('[selftest] 版本自查无判别力'); process.exit(1); }
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  run().catch((e) => { console.error('[seed-admission] 失败：', e.message); process.exit(1); });
}
