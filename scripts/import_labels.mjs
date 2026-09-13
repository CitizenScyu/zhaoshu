#!/usr/bin/env node
// labels.jsonl → Neon labeled_books 表。
// labeler.py 在 phoenix 上只产 jsonl,入库由本地用项目的 @neondatabase/serverless 执行。
//
// 用法:
//   node scripts/import_labels.mjs --env .env.local --file labels.jsonl
//   DATABASE_URL=postgres://... node scripts/import_labels.mjs --file labels.jsonl
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeGenre } from './genre_map.mjs';

const DEFAULT_FILE = './labels.jsonl';
// PG 的 jsonb/text 严禁 NUL(0x00),源码里直接写裸 NUL 字节会被编辑链污染,
// 用码位构造
const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');

function parseArgs(argv) {
  const args = { env: null, file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--env') args.env = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (!a.startsWith('--') && args.file === DEFAULT_FILE) args.file = a;
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

// env 文件:每行 KEY=VALUE,忽略空行与 # 注释,容忍 export 前缀与外围引号
function loadEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq < 1) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// 字符串清洗:去 NUL、孤立 UTF-16 代理项替换为 U+FFFD。
// 与 src/lib/shuyuan.ts 的 cleanJson 同一套规则(上游数据里确实存在这类脏值)。
function cleanString(value) {
  return value
    .replace(NUL_RE, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '�')
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanJson(value) {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map(cleanJson);
  if (isRecord(value)) {
    // 键也是字符串,同样可能带脏字符
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[cleanString(k)] = cleanJson(v);
    return out;
  }
  return value;
}

// 与 labeler.py 的 title_matches 同一套规则:去空白后相等 / 一方包含另一方 /
// 去掉《》和空格后相等。
function titleMatches(guess, actual) {
  const g = String(guess ?? '').trim();
  const a = String(actual ?? '').trim();
  if (!g || !a) return false;
  if (g === a || g.includes(a) || a.includes(g)) return true;
  const clean = (s) => s.replace(/[《》\s]/g, '');
  const cg = clean(g);
  const ca = clean(a);
  return Boolean(cg) && cg === ca;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  let databaseUrl = process.env.DATABASE_URL;
  if (args.env) {
    const envPath = resolve(args.env);
    const env = loadEnvFile(envPath);
    if (!env.DATABASE_URL) throw new Error(`${envPath} 里没有 DATABASE_URL`);
    databaseUrl = env.DATABASE_URL;
  }
  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL(--env <path> 或环境变量)');
  }

  const file = resolve(args.file);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const sql = neon(databaseUrl);

  let inserted = 0;
  let skipped = 0;
  let errored = 0;
  const reasons = [];

  for (const [i, line] of lines.entries()) {
    const at = `${file}:${i + 1}`;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      skipped += 1;
      reasons.push(`${at} 解析失败: ${e.message}`);
      continue;
    }
    if (!isRecord(rec) || !isRecord(rec.labels)) {
      skipped += 1;
      reasons.push(`${at} labels 字段缺失或不是对象`);
      continue;
    }
    const title = rec.title ?? '';
    const labels = rec.labels;

    const guess = labels.title_guess ?? '';
    if (!titleMatches(guess, title)) {
      skipped += 1;
      reasons.push(`书名不符,疑似错书,跳过(记录: ${title} / 标签: ${guess})`);
      continue;
    }
    // 旧数据没有 text_quality 字段,按正常处理
    const quality = labels.text_quality;
    if (quality !== undefined && quality !== null && quality !== '正常') {
      skipped += 1;
      reasons.push(`文本质量异常(${quality}),跳过: ${title}`);
      continue;
    }

    try {
      // 分类规范化 + 质量分（quality = labels.quality.overall，0-10，非法置 null）
      const { primary, sub } = normalizeGenre(rec.category, labels.genre);
      const q = labels.quality;
      const overall =
        isRecord(q) && Number.isFinite(Number(q.overall)) && q.overall >= 0 && q.overall <= 10
          ? Number(q.overall)
          : null;
      await sql`
        INSERT INTO labeled_books
          (title, author, category, finish_status, source_site, source_url,
           chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)
        VALUES (${cleanString(String(title))}, ${cleanString(String(rec.author ?? ''))},
                ${cleanString(String(rec.category ?? ''))}, ${cleanString(String(rec.status ?? ''))},
                ${cleanString(String(rec.source ?? ''))}, ${cleanString(String(rec.url ?? ''))},
                ${Number.isFinite(Number(rec.chars)) ? Math.trunc(Number(rec.chars)) : 0},
                ${JSON.stringify(cleanJson(labels))}::jsonb, now(),
                ${primary}, ${JSON.stringify(sub)}::jsonb, ${overall})
        ON CONFLICT (lower(title), lower(author)) DO UPDATE SET
          labels = EXCLUDED.labels,
          finish_status = EXCLUDED.finish_status,
          chars_labeled = EXCLUDED.chars_labeled,
          source_url = EXCLUDED.source_url,
          primary_genre = EXCLUDED.primary_genre,
          sub_tags = EXCLUDED.sub_tags,
          quality = COALESCE(EXCLUDED.quality, labeled_books.quality),
          labeled_at = now()`;
      inserted += 1;
    } catch (e) {
      errored += 1;
      reasons.push(`入库失败: ${title} — ${e.message}`);
    }
  }

  if (reasons.length > 0) {
    console.log('跳过/失败明细:');
    for (const r of reasons) console.log(` - ${r}`);
  }
  console.log(
    `总数 ${lines.length} / 入库 ${inserted} / 跳过 ${skipped}${errored ? ` / 失败 ${errored}` : ''}`,
  );
  return errored > 0 ? 1 : 0;
}

// 导出纯函数便于本地自测;直接运行时才连库
export { cleanJson, cleanString, loadEnvFile, parseArgs, titleMatches };

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
