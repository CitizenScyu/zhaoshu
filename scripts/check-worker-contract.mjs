import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bookFilename } from '../src/lib/book-file-name.ts';
import { DOWNLOAD_TASK_STALE_MS } from '../src/lib/download-task-policy.ts';
import { validateSourceUrl } from '../src/lib/source-policy.ts';
import { runRuntimeBudgetContract } from './worker-runtime-budget-contract.mjs';

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
//   生产执行器走 runtime/ 新路线：scripts/build-runtime-download.mjs 调 scripts/runtime-download-template.mjs
//   的 wireDownloadExecutor()，把装配代码「注入」到兄弟仓 runtime/service/main.mjs 的固定接缝上，靠硬编码
//   锚点定位（接缝起点/终点 + 共享限速 supervisor 装配的 9 条锚点，要求各出现恰好一次且都在接缝之前）。
//   锚点失配只在**打包时**才抛（build-runtime-download.mjs 的 throw），反馈太晚——本组把它提前到 push 时。
//
// 设计（2026-10-23 改）：直接 import 生产用的那个纯函数，拿兄弟仓的 main.mjs 真跑一遍。
//   旧写法是用正则去 build 脚本源码里解析 `const START = '...'` 这类字面量；锚点搬进 template（8af9ecd,
//   2026-10-06）并扩成 9 条数组（c0f4374, 2026-10-14）之后就永久失配，而这条契约从没被执行过
//   （CI 不 checkout 兄弟仓、pre-push 钩子未激活），红了 17 天没人发现。改成调用真函数后，锚点原文
//   既不复写、也不可能与打包路径脱钩——template 改了这里跟着变，不需要第三处硬编码。
const shellMainRel = 'runtime/service/main.mjs';
const { wireDownloadExecutor } = await import(new URL('./runtime-download-template.mjs', import.meta.url).href);

// 兄弟仓的 runtime/ 源在不在。origin/main 从来没有 runtime/（它只存在于本地提交 4e960b3，已随空目录一起
// 丢失），所以**任何新克隆都会走「无 runtime/」这条**。缺失=无法验证，不等于验证通过：明确 warn 后跳过
// 第五/六组，其余四组（worker.mjs 所有权 / 文件名 / 源策略 / 心跳时序）照旧硬跑。
// runtime/ 在、但缺必需模块 → 仍然硬失败（残缺状态不能当可选契约放行，见第六组）。
const shellPresent = existsSync(resolve(workerRoot, 'runtime'));

if (!shellPresent) {
  console.warn('⚠ 跳过跨仓 runtime 契约（第五组注入锚点 + 第六组预算/限速）：兄弟仓没有 runtime/ 源目录。');
  console.warn('  这是「无法验证」，不是「通过」。补回 shell 源后两组自动重新武装，本文件不用改。');
  console.warn('  已知影响：全量 runtime 重建+部署路径当前不可用——phoenix 上只有构建产物，其 main.mjs 是');
  console.warn('  2026-10-07 代（verifySharedRateStartup / createSharedRateLimiter 内联装配，各出现 2 次），');
  console.warn('  与本仓 template 自 c0f4374 起要求的 startSharedRateSupervisor 装配不符（部署版 0 次）；');
  console.warn('  生产下载线靠单换 executor.mjs 维持，未走过全量重建。');
} else {
  const shellMainPath = resolve(workerRoot, shellMainRel);
  if (!existsSync(shellMainPath)) {
    throw new Error(
      `跨仓 runtime 锚点契约失败：兄弟仓有 runtime/ 但缺少 ${shellMainRel}（${shellMainPath}）。\n` +
      `  生产执行器走 runtime/ 新路线，打包脚本 scripts/build-runtime-download.mjs 会在打包时抛「runtime shell 未找到」。\n` +
      `  修法：把兄弟仓切到含 ${shellMainRel} 的版本。`,
    );
  }
  // 真跑一遍生产注入函数：锚点齐了就返回改写后的 main.mjs，缺任何一条就抛。
  try {
    assert.ok(wireDownloadExecutor(readFileSync(shellMainPath, 'utf8')).length > 0);
  } catch (error) {
    throw new Error(
      `跨仓 runtime 锚点契约失败：${shellMainRel} 过不了 scripts/runtime-download-template.mjs 的注入检查。\n` +
      `  打包器原文：${error.message}\n` +
      `  影响：scripts/build-runtime-download.mjs 打包注入会失配，在打包阶段才抛错（反馈太晚）。\n` +
      `  修法：要么把兄弟仓 ${shellMainRel} 的接缝/共享限速装配行改回 template 要求的原文，要么同步更新 template 的锚点。`,
    );
  }
  // 负向对照：证明上面那次「通过」不是空函数造成的假绿（template 被改成恒返回时这里会红）。
  assert.throws(() => wireDownloadExecutor('// 没有接缝也没有装配锚点的 shell'), /锚点缺失或不唯一/,
    'wireDownloadExecutor 必须在缺接缝时抛错，否则第五组是假绿');
  console.log(`Cross-repository runtime anchor contract: wireDownloadExecutor() ran clean on ${shellMainRel} (+1 negative control)`);
}

// 第六组：runtime 日预算退还 + 限速器错误名契约（41-EXEC-SRCUNAVAIL）。
//   实现在 worker-runtime-budget-contract.mjs（依赖全部可注入），本处与
//   scripts/check-worker-contract.test.ts 调的是**同一个函数**——不再把契约正文抄一份到测试里、
//   也不再靠「切源码文本 + VM eval」来跑它（那种写法对文件结构零容忍：锚点被包进 if 块，切到文件尾
//   就多一个不配对的 `}`，整段 SyntaxError；来龙去脉见该模块头部）。跳过 vs 拒绝的策略也在那个函数里，
//   改这里请连同它的测试一起改。shellPresent=false 时的 warn 由上面第五组那段负责，本处不重复打印。
await runRuntimeBudgetContract({ workerRoot, shellPresent });
