// 给没有质量分的已入库书补打分：重抓前 40 万字 → 一次 LLM 调用只问质量四维分。
// 用法: node scripts/backfill_quality.mjs --env <env文件> --limit 20
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseQuality } from './import_labels.mjs';

const LLM_URL = 'https://api.cloud.us.kg/v1/chat/completions';
const TARGET_CHARS = 400_000;
const CHAPTER_DELAY = 0.3;
const RETRY = 3;
const LLM_INTERVAL_SEC = 30; // 调用方频率限制,两本之间隔 30s
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu-backfill/1.0)' };

const SYSTEM_PROMPT =
  '你是网文编目员。阅读给定文本,只输出一个 JSON 对象(不要 markdown 代码块):' +
  '{"prose": 文笔0-10, "worldbuilding": 设定0-10, "pacing": 节奏0-10, ' +
  '"enjoyment": 读感0-10, "overall": 综合0-10}。整数或一位小数。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseQualityResponse(value) {
  const overall = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? parseQuality(value.overall) : null;
  if (overall === null) throw new Error('overall 必须是 0 到 10 的有效数值');
  return overall;
}

function parseArgs(argv) {
  const args = { env: null, limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env') args.env = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]) || 20;
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
    // vercel env pull 写的值带引号，必须剥掉（曾因此报 invalid URL）
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

async function httpGet(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// 抓取规则同 labeler.py(book15 系站点,已实测)
async function fetchBookText(sourceUrl, targetChars) {
  const origin = new URL(sourceUrl).origin;
  const html = await httpGet(sourceUrl);
  const re = /<dd[^>]*>\s*<a[^>]*href="(\/chapter\/index\d+-\d+\.html)"[^>]*>([^<]{1,60})<\/a>/g;
  const chapters = [];
  for (let m = re.exec(html); m; m = re.exec(html)) chapters.push({ href: m[1], title: m[2].trim() });
  const parts = [];
  let chars = 0;
  for (const ch of chapters) {
    if (chars >= targetChars) break;
    let text = '';
    for (let attempt = 1; attempt <= RETRY; attempt++) {
      try {
        const chHtml = await httpGet(origin + ch.href);
        const start = chHtml.indexOf('chapter-content-panel');
        const seg = chHtml.slice(start, start + 25_000);
        const paras = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
          .map((m) => m[1].replace(/<[^>]+>|&nbsp;/g, '').trim())
          .filter(Boolean);
        text = paras.join('\n');
        break;
      } catch {
        if (attempt < RETRY) await sleep(2000 * attempt);
      }
    }
    if (text.length > 100) {
      parts.push(`【${ch.title}】\n${text}`);
      chars += text.length;
    }
    await sleep(CHAPTER_DELAY * 1000);
  }
  return parts.join('\n\n');
}

async function llmQuality(apiKey, model, text) {
  const body = JSON.stringify({
    model, stream: true, max_tokens: 300,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
  });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { ...UA, 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const raw = await res.text();
      let content = '';
      for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const delta = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content;
          if (delta) content += delta;
        } catch { /* 坏行忽略 */ }
      }
      content = content.trim();
      if (content.startsWith('```')) {
        content = content.replace(/^```[a-zA-Z0-9_-]*/, '').replace(/```/g, '').trim();
      }
      return parseQualityResponse(JSON.parse(content));
    } catch (e) {
      lastErr = e;
      console.error(`    LLM 尝试 ${attempt} 失败: ${e.message}`);
      await sleep(20_000 * attempt);
    }
  }
  throw lastErr;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.env) throw new Error('缺少 --env <path>');
  const env = loadEnvFile(resolve(args.env));
  if (!env.DATABASE_URL || !env.LLM_API_KEY) throw new Error('env 文件缺 DATABASE_URL / LLM_API_KEY');
  const model = env.LLM_MODEL || 'deepseek-v4-flash-bohe';
  const sql = neon(env.DATABASE_URL);

  const rows = (await sql`
    SELECT id, title, source_url FROM labeled_books
    WHERE quality IS NULL AND source_url <> ''
    ORDER BY id LIMIT ${args.limit}`) || [];
  console.log(`待补分: ${rows.length} 本`);

  let ok = 0;
  for (const [i, r] of rows.entries()) {
    console.log(`[${i + 1}/${rows.length}] ${r.title} ...`);
    try {
      const text = await fetchBookText(r.source_url, TARGET_CHARS);
      if (text.length < 10_000) throw new Error(`仅抓到 ${text.length} 字`);
      const overall = await llmQuality(env.LLM_API_KEY, model, text);
      await sql`UPDATE labeled_books SET quality = ${overall} WHERE id = ${r.id}`;
      console.log(`  quality = ${overall}`);
      ok += 1;
    } catch (e) {
      console.error(`  失败: ${e.message}`);
    }
    await sleep(LLM_INTERVAL_SEC * 1000);
  }
  console.log(`完成: ${ok}/${rows.length}`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
