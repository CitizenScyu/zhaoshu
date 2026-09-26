#!/usr/bin/env node
// 换源覆盖率基准 CLI（纯离线：只读已保存的结果 JSON，不联网、不连库）。
// 联网实测在 scripts/coverage-bench.run.test.ts（生产 getFanoutPool 需注入 DB，只能走 vitest 的 db mock 路径）。
//
// 用法：
//   node scripts/coverage-bench.mjs summarize <raw.json> [--out summary.json] [--md report.md] [--label 名] [--prev 上次summary.json]
//   node scripts/coverage-bench.mjs compare <prevSummary.json> <currSummary.json> [--md out.md]
//
// raw.json：数组，或 { meta, results: [...] }；每本 { title, author, tier, genre, perSource:[{host,name,status,readable,ms,idExact}] }。
import { readFileSync, writeFileSync } from 'node:fs';
import { summarize, compare, renderMarkdown } from './coverage-bench-stats.mjs';

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else pos.push(argv[i]);
  }
  return { flags, pos };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function loadRaw(p) {
  const j = readJson(p);
  const results = Array.isArray(j) ? j : j.results || [];
  const meta = Array.isArray(j) ? {} : j.meta || {};
  return { results, meta };
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseFlags(rest);

if (cmd === 'summarize') {
  const rawPath = pos[0];
  if (!rawPath) { console.error('用法: summarize <raw.json> [--out] [--md] [--label] [--prev]'); process.exit(2); }
  const { results, meta } = loadRaw(rawPath);
  const summary = summarize(results, { ...meta, label: flags.label || meta.label });
  const cmp = flags.prev ? compare(readJson(flags.prev), summary) : null;
  const md = renderMarkdown(summary, { title: flags.label || meta.label || undefined, compare: cmp });
  if (flags.out) writeFileSync(flags.out, JSON.stringify(summary, null, 2));
  if (flags.md) writeFileSync(flags.md, md);
  if (!flags.out && !flags.md) console.log(md);
  else console.error(`summarize: ${results.length} 本，覆盖率 ${(summary.totals.coverageRate * 100).toFixed(1)}%` + (flags.out ? ` → ${flags.out}` : '') + (flags.md ? ` / ${flags.md}` : ''));
} else if (cmd === 'compare') {
  const [prevP, currP] = pos;
  if (!prevP || !currP) { console.error('用法: compare <prevSummary.json> <currSummary.json> [--md]'); process.exit(2); }
  const prev = readJson(prevP);
  const curr = readJson(currP);
  const cmp = compare(prev, curr);
  const md = renderMarkdown(curr, { title: '对比', compare: cmp });
  if (flags.md) { writeFileSync(flags.md, md); console.error(`compare → ${flags.md}`); }
  else console.log(md);
} else {
  console.error('未知命令。用法：summarize | compare');
  process.exit(2);
}
