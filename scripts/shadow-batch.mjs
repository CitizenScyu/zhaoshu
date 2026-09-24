// P1a 放量前置 3:影子求值批量入口(只读 CLI;简报 p1a-rollout-brief.md §7 第 3 条)。
//
// 用途:ENGINE_SYNTAX_OR **保持 off**(生产口径不变)时,对候选源跑一遍编译口径的
// on/off 对拍,产出**脱敏差异清单**,为将来「是否放量」的决策提供观测数据。
// 调用 rule-engine 的真函数 shadowEvaluateSource(不复制其逻辑)。
//
// 与 seed-admission.mjs 同款骨架:ts-esm-loader shim(经 register 动态 import 仓库 TS)、
// `--env .env.xxx` 解析 DATABASE_URL、neon 只读连接、参数解析。差别:
//   - 本脚本**零写库**(无任何 INSERT/UPDATE/DELETE),只 SELECT shuyuan_sources;
//   - 本脚本**零网络请求**:pages 传空对象 `{}`,只产出 compile 口径的 on/off 对拍
//     (compiled 布尔 / error 摘要 / 差异字段数),不求值 value——
//     这是**编译口径**的影子对拍,与简报「离线批量影子跑」一致;
//   - 开关防线保持:若 ENGINE_SYNTAX_OR 已 on,shadowEvaluateSource 自抛错(既有防线),
//     本脚本不绕过、不 monkey-patch。
//
// 用法:
//   node scripts/shadow-batch.mjs --env .env.pull [--url <source_url> ...] [--limit 200]
//                                 [--json <path>]
//   node scripts/shadow-batch.mjs --dry-run --fixture <fixture.json>   # 离线自验,不连库
// 不带 --url 时全量(受 --limit 上界保护,默认 200)。--json 落盘完整字段级明细。
//
// 凭据纪律:只做 readFileSync 解析 --env 文件取 DATABASE_URL;**不打印其内容,不打印
// 任何 env 值**;stdout 只输出 host / compile 结论 / 差异计数 / error 摘要(截断)。
// 不打印源规则原文。

import { register } from 'node:module';
import { neon } from '@neondatabase/serverless';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

register('./ts-esm-loader.mjs', import.meta.url);
const { shadowEvaluateSource } = await import('../src/lib/rule-engine/shadow-eval.ts');
const { compileAdmission } = await import('../src/lib/rule-engine/admission.ts');
const { compileSource } = await import('../src/lib/rule-engine/compile.ts');

const ERROR_SUMMARY_MAX = 80;
const DEFAULT_LIMIT = 200;

// 源级两态谓词**不是同一谓词的两态**(复核报告 §1「源级谓词不对齐」):
//   off 源级 = compileAdmission(source).ok —— 含 survey 初筛 + 必需组校验;
//   on  源级 = shadowEvaluateSource(...).shadowCompileOk —— 缺整组字段只 continue,
//             不判失败,且不跑 survey 初筛。
// 因此 offOk/onOk 的差会混入与 ENGINE_SYNTAX_OR 无关的初筛/必需组差异。本任务只加
// 标注(低成本对齐会改已实测数字与行为,不做),下面两个标签同时进 stdout 与汇总 JSON。
export const OFF_OK_PREDICATE_LABEL =
  'compileAdmission(source).ok(survey 初筛 + 必需组 + 默认 orEnabled)';
export const ON_OK_PREDICATE_LABEL =
  'shadowEvaluateSource(...).shadowCompileOk(缺字段 continue 不判失败;orEnabled:true;不跑 survey)';

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function truncate(text, max = ERROR_SUMMARY_MAX) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function parseArgs(argv) {
  const args = { env: null, urls: [], limit: DEFAULT_LIMIT, json: null, dryRun: false, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env') args.env = argv[++i];
    else if (argv[i] === '--url') args.urls.push(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = argv[++i];
    else if (argv[i] === '--fixture') args.fixture = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else throw new Error(`未知参数:${argv[i]}`);
  }
  if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error('--limit 必须是正整数');
  return args;
}

// 与 seed-admission.loadEnvFile 逐字同款:只解析,不打印。
function loadEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * 对一个源做编译口径的 on/off 对拍(纯函数,零网络、零写库)。
 * off 源级列 = compileAdmission(生产默认口径,含 survey 初筛 + 必需组);on 源级列 =
 * shadowEvaluateSource 的 shadowCompileOk。逐字段差异**直接对两态编译产物**比(off 用
 * compileSource orEnabled:false,on 用 shadow.fields 的 compiled):
 * 不能拿 compileAdmission 的 coreFieldMask 去比——survey 初筛一旦拒,那个位图是全 false
 * 的短路值,不是逐字段编译结论,比出来是伪差异(BOTH_BAD 的 @js: 源即此坑)。
 */
export function evaluateSource(source, pages = {}) {
  const off = compileAdmission(source);
  const shadow = shadowEvaluateSource(source, pages);
  const url = typeof source.bookSourceUrl === 'string' ? source.bookSourceUrl : '';
  const offCompiled = compileSource({ url, searchUrl: source.searchUrl, rules: source }, { orEnabled: false });
  let rescued = 0; // off 不可解释、on 可解释(|| 组合救回)
  let regressed = 0; // off 可解释、on 不可解释
  for (const f of shadow.fields) {
    const offEntry = offCompiled.get(f.field);
    const offOk = Boolean(offEntry && !('skipped' in offEntry));
    if (offOk && !f.compiled) regressed += 1;
    else if (!offOk && f.compiled) rescued += 1;
  }
  const errors = shadow.fields
    .filter((f) => f.error)
    .map((f) => `${f.field}: ${truncate(f.error)}`);
  return {
    sourceUrl: shadow.sourceUrl,
    host: hostOf(shadow.sourceUrl),
    offCompileOk: off.ok,
    onShadowCompileOk: shadow.shadowCompileOk,
    diffFields: rescued + regressed,
    rescued,
    regressed,
    errorSummaries: errors,
    shadow,
  };
}

export function evaluateSources(sources, pages = {}) {
  return sources.map((src) => evaluateSource(src, pages));
}

/** 汇总计数(测试断言口径)。 */
// 汇总字段一律带单位后缀:避免把字段加总(如 98)误读成源计数。
function addUnitSuffix(obj, suffix) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[`${k}${suffix}`] = v;
  return out;
}

export function summarize(rows) {
  const sourceCounts = {
    total: rows.length,
    offOk: rows.filter((r) => r.offCompileOk).length,
    onOk: rows.filter((r) => r.onShadowCompileOk).length,
    rescued: rows.filter((r) => !r.offCompileOk && r.onShadowCompileOk && r.rescued > 0).length,
    regressed: rows.filter((r) => r.offCompileOk && !r.onShadowCompileOk && r.regressed > 0).length,
    withErrors: rows.filter((r) => r.errorSummaries.length > 0).length,
  };
  const fieldTotals = {
    rescued: rows.reduce((n, r) => n + r.rescued, 0),
    regressed: rows.reduce((n, r) => n + r.regressed, 0),
  };
  // 源级 / 字段级两列拆分单位:源级计数带 `Sources` 后缀,字段加总带 `Fields` 后缀,
  // 顶层不再出现无后缀 total/offOk/onOk/withErrors/rescued/regressed。
  return {
    ...addUnitSuffix(sourceCounts, 'Sources'),
    ...addUnitSuffix(fieldTotals, 'Fields'),
    offOkPredicate: OFF_OK_PREDICATE_LABEL,
    onOkPredicate: ON_OK_PREDICATE_LABEL,
  };
}

function jsonSafeShadow(shadow) {
  // 只保留脱敏观测口径的字段(不含源规则原文)。
  return {
    sourceUrl: shadow.sourceUrl,
    currentCompileOk: shadow.currentCompileOk,
    shadowCompileOk: shadow.shadowCompileOk,
    shadowSemanticsVersion: shadow.shadowSemanticsVersion,
    fields: shadow.fields.map((f) => ({
      field: f.field, compiled: f.compiled, nodes: f.nodes, value: truncate(f.value, 500), error: f.error,
    })),
  };
}

async function readSourcesFromDb(args) {
  const env = loadEnvFile(resolve(args.env));
  if (!env.DATABASE_URL) throw new Error('env 文件缺 DATABASE_URL');
  const sql = neon(env.DATABASE_URL);
  const urls = args.urls.map((u) => u.trim().replace(/\/+$/, ''));
  // 只读 SELECT:不带 --url 时全量(受 limit 保护);带 --url 时按 IN 过滤。
  // source json 存于 shuyuan_sources.source(与 seed-admission 同列)。
  const stored = urls.length
    ? await sql`SELECT source_url, source FROM shuyuan_sources
        WHERE source_url IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(urls)}::jsonb))
        LIMIT ${args.limit}`
    : await sql`SELECT source_url, source FROM shuyuan_sources LIMIT ${args.limit}`;
  return stored.map((row) => row.source);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  let sources;
  if (args.fixture) {
    // 离线自验路径:不连库、不读 env。
    sources = JSON.parse(readFileSync(resolve(args.fixture), 'utf8'));
    if (!Array.isArray(sources)) throw new Error('fixture 必须是源数组');
    console.log(`[shadow-batch] fixture 源 ${sources.length} 个(离线,不连库)`);
  } else {
    if (!args.env) throw new Error('缺少 --env <path>(或 --fixture <json>)');
    sources = await readSourcesFromDb(args);
    console.log(`[shadow-batch] 库源 ${sources.length} 个(只读 SELECT${args.urls.length ? `,--url 过滤 ${args.urls.length} 个` : ',全量'}${args.dryRun ? ',dry-run' : ''})`);
  }

  const rows = evaluateSources(sources);
  console.log('[shadow-batch] 逐源对拍(host | off_compile_ok | on_shadow_ok | diff_field_count | error 摘要):');
  for (const r of rows) {
    console.log(`  host=${r.host || '(bad-url)'} off_compile_ok=${r.offCompileOk} ` +
      `on_shadow_ok=${r.onShadowCompileOk} diff_fields=${r.diffFields} ` +
      `(rescued=${r.rescued} regressed=${r.regressed}) errors=${r.errorSummaries.join(' | ') || '(无)'}`);
  }
  const s = summarize(rows);
  console.log('[shadow-batch] 汇总:', JSON.stringify(s));
  console.log(`[shadow-batch] 源级谓词标注:offOkPredicate = ${OFF_OK_PREDICATE_LABEL}`);
  console.log(`[shadow-batch] 源级谓词标注:onOkPredicate  = ${ON_OK_PREDICATE_LABEL}`);
  console.log('[shadow-batch] 单位约定:键名带 Sources=源计数;带 Fields=字段加总(两者不可相加)。');

  if (args.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      summary: s,
      rows: rows.map((r) => ({
        sourceUrl: r.sourceUrl, host: r.host, offCompileOk: r.offCompileOk,
        onShadowCompileOk: r.onShadowCompileOk, diffFields: r.diffFields,
        rescued: r.rescued, regressed: r.regressed, errorSummaries: r.errorSummaries,
        shadow: jsonSafeShadow(r.shadow),
      })),
    };
    writeFileSync(resolve(args.json), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[shadow-batch] --json 已落盘:${args.json}(字段级明细)`);
  }
  console.log('[shadow-batch] 只读完成:零写库、零网络请求、未翻任何开关。');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  run().catch((e) => { console.error('[shadow-batch] 失败:', e.message); process.exit(1); });
}
