import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bookFilename } from '../src/lib/book-file-name.ts';
import { DOWNLOAD_TASK_STALE_MS } from '../src/lib/download-task-policy.ts';
import { validateSourceUrl } from '../src/lib/source-policy.ts';

// Explicit cross-repository check; normal unit tests also run these fixtures in each repo.
const workerRoot = resolve(process.argv[2] || '../zhaoshu-books');
const workerSource = readFileSync(resolve(workerRoot, 'worker.mjs'), 'utf8');
assert.match(workerSource, /CREATE TABLE IF NOT EXISTS download_tasks/);
assert.match(workerSource, /UPDATE download_tasks SET status = 'running'[\s\S]*RETURNING \*/);
assert.doesNotMatch(workerSource, /(?:user[_-]?token|session[_-]?token|owner[_-]?token)/i);
assert.doesNotMatch(workerSource, /UPDATE download_tasks SET[\s\S]{0,300}user_id\s*=/);
console.log('Worker ownership contract: additive schema and column-preserving updates passed');
const worker = await import(pathToFileURL(resolve(workerRoot, 'book-file-name.mjs')).href);
const cases = JSON.parse(readFileSync(new URL('../src/lib/fixtures/book-filenames.json', import.meta.url), 'utf8'));
assert.deepEqual(JSON.parse(readFileSync(resolve(workerRoot, 'test/fixtures/book-filenames.json'), 'utf8')), cases);
for (const { title, author, expected } of cases) {
  assert.equal(bookFilename(title, author), expected);
  assert.equal(worker.bookFilename(title, author), expected);
  assert.equal(bookFilename(title, author), worker.bookFilename(title, author));
}
console.log(`Cross-repository filename contract: ${cases.length} inputs passed`);
const heartbeat = await import(pathToFileURL(resolve(workerRoot, 'task-heartbeat.mjs')).href);
assert.ok(heartbeat.HEARTBEAT_INTERVAL_MS + heartbeat.HEARTBEAT_QUERY_TIMEOUT_MS < DOWNLOAD_TASK_STALE_MS);
const sourcePolicy = await import(pathToFileURL(resolve(workerRoot, 'lib/source-policy.mjs')).href);
const sourceCases = JSON.parse(readFileSync(new URL('../src/lib/fixtures/source-policy.json', import.meta.url), 'utf8'));
assert.deepEqual(JSON.parse(readFileSync(resolve(workerRoot, 'test/fixtures/source-policy.json'), 'utf8')), sourceCases);
for (const { input, base, expected } of sourceCases) {
  for (const validate of [validateSourceUrl, sourcePolicy.validateSourceUrl]) {
    if (expected) assert.equal(validate(input, base).href, expected);
    else assert.throws(() => validate(input, base));
  }
}
console.log('Cross-repository source policy contract: ' + sourceCases.length + ' inputs passed');
console.log(`Task timing contract: heartbeat ${heartbeat.HEARTBEAT_INTERVAL_MS}ms + query ${heartbeat.HEARTBEAT_QUERY_TIMEOUT_MS}ms < reclaim ${DOWNLOAD_TASK_STALE_MS}ms`);

// 第五组：runtime/ 新路线的注入锚点契约（T8 打包脚本）。
//   生产执行器走 runtime/ 新路线：scripts/build-runtime-download.mjs 把装配代码「注入」到兄弟仓
//   runtime/service/main.mjs 的固定接缝上，靠三条硬编码字符串锚点定位（其 :63 起点、:64 终点、:98 限速器导入）。
//   锚点失配只在**打包时**才抛（build-runtime-download.mjs 的 throw），反馈太晚——本组把它提前到 push 时。
//
// 设计：锚点原文**不在本文件复写**（否则成第三处硬编码，改一处漏两处），而是从 build-runtime-download.mjs
//   的源码里解析出那三条字面量。解析失败即硬失败（fail-closed），不静默跳过。
const buildScriptPath = fileURLToPath(new URL('./build-runtime-download.mjs', import.meta.url));
const shellMainRel = 'runtime/service/main.mjs';

// 把 JS 字符串字面量（含两侧引号）还原成真实值，处理 \n \t \uXXXX 等转义。
// 转义用字符码表示，避免源码里出现控制字符。
function unescapeLiteral(literal) {
  const body = literal.slice(1, -1);
  const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, 0: 0 };
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[(i += 1)];
    if (next === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; continue; }
    if (next === 'x') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; continue; }
    out += Object.prototype.hasOwnProperty.call(simple, next) ? String.fromCharCode(simple[next]) : next;
  }
  return out;
}

// 从 build-runtime-download.mjs 源码里按「声明名 + 字符串字面量」提取三条锚点。
// 只依赖声明名（START / END / anchor）与字符串字面量形状，锚点原文不进本文件。
function extractShellAnchors(source) {
  const decls = [
    ['START', '执行器接缝起点'],
    ['END', '执行器接缝终点'],
    ['anchor', 'rate-limiter 注入锚点'],
  ];
  return decls.map(([name, label]) => {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`);
    const m = re.exec(source);
    if (!m) {
      throw new Error(`跨仓 runtime 锚点契约自检失败：在 scripts/build-runtime-download.mjs 里解析不到锚点 "${name}" 的字符串字面量（被重命名或改写法）。请同步更新 scripts/check-worker-contract.mjs 的声明名清单。`);
    }
    return { name, label, value: unescapeLiteral(m[1]) };
  });
}

if (!existsSync(workerRoot)) {
  // 与 pre-push 钩子的 `[ -d ../zhaoshu-books ]` 约定一致：兄弟仓不在就跳过，不拒绝 push。
  console.log('○ 跳过跨仓 runtime 锚点契约：本地无兄弟仓');
} else {
  const anchors = extractShellAnchors(readFileSync(buildScriptPath, 'utf8'));
  const shellMainPath = resolve(workerRoot, shellMainRel);
  if (!existsSync(shellMainPath)) {
    throw new Error(
      `跨仓 runtime 锚点契约失败：兄弟仓缺少 ${shellMainRel}（${shellMainPath}）。\n` +
      `  生产执行器走 runtime/ 新路线，打包脚本 scripts/build-runtime-download.mjs 会在打包时抛「runtime shell 未找到」。\n` +
      `  修法：把兄弟仓切到含 runtime/ 的版本（或在兄弟仓补上 runtime/service/main.mjs）。`,
    );
  }
  const shellSource = readFileSync(shellMainPath, 'utf8');
  for (const { name, label, value } of anchors) {
    if (shellSource.includes(value)) continue;
    throw new Error(
      `跨仓 runtime 锚点契约失败：锚点 "${name}"（${label}）在兄弟仓 ${shellMainRel} 里找不到。\n` +
      `  锚点原文（读自 scripts/build-runtime-download.mjs）：${JSON.stringify(value)}\n` +
      `  影响：scripts/build-runtime-download.mjs 打包注入会失配，在打包阶段才抛错（反馈太晚）。\n` +
      `  修法：要么把兄弟仓 ${shellMainRel} 的对应接缝/导入行改回原文，要么同步更新本仓 scripts/build-runtime-download.mjs 的锚点。`,
    );
  }
  console.log(`Cross-repository runtime anchor contract: ${anchors.length} anchors present in ${shellMainRel}`);
}
