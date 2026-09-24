// scripts 下的 node:test 用例入口(41-MJSGATE;41-MJSGATE-FIX 复审整改)。
//
// 为什么需要这个 runner,而不是直接把 `node --test "scripts/*.test.mjs"` 写进 package.json:
//   1) fail-closed。node 自己的 glob 一个匹配都没有时报「0 tests」并**退出 0**——护栏会
//      静默消失(本仓最忌讳的失效模式,见 ci.yml 里对 pglite 用例静默跳过的断言)。这里
//      显式列文件,对文件数、用例数做下限断言,并要求每个文件都真的报了汇总。
//   2) 风格校验。这条门只跑 node:test 风格的 .test.mjs(describe/it + node:assert)。
//      vitest 风格的 .test.mjs 混进来会因缺 vitest 环境而跑不了,这里提前给出明确报错,
//      而不是留一个「看着绿、其实没跑」的假通过。
//   3) 跨平台一致,且**不经过任何 glob 解析**。见下。
//
// 【41-MJSGATE-FIX 复审整改】第 3 条原本写成「不依赖 node 的 glob 展开差异」,但实际是
//   `spawnSync(node, ['--test', ...绝对路径])`——而 Node 22 的 `node --test <参数>` 把**每个
//   参数都当 glob 模式**解析(不只是 shell 展开)。后果(复审实测,本仓桌面/CI 路径不含 `[]`
//   故当时看不出来,但文件名只要带 `[` 任何环境都会中):
//     - 目录名含 `[ab]` → `[...]` 被当字符类 → 零匹配 → node 报 `# tests 0` 并**退出 0**;
//     - 文件名含 `[4]`(如 `f[4].test.mjs`)→ 该文件被静默跳过,其余照跑,退出 0。
//   两者都恰好是这条门声称要防的静默失效。现改用 `node:test` 的 `run({ files })` API:
//   文件按字面路径加载,不经过 glob,并把逐文件的 `test:summary` 事件当作判据。
//   (另一可行修法是 `cwd: scriptsDir` + 传相对文件名 + 文件名白名单;此处选了 run() API,
//   因为它同时给出逐文件用例数,正好用于下面的用例数下限。)

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// 下限常量:新增 .test.mjs 时**不需要**改这里;只有删除或改名导致数量掉到 4 以下才触发,
// 而那正是这条门要拦的情况。4 = 接入时的既有文件数(backfill_authors / import_labels /
// normalize_author / shadow-batch)。
const MIN_EXPECTED_FILES = 4;

// 用例数下限(复审非阻断建议 1)。文件数下限拦不住「文件还在、用例没了」——文件顶层
// `process.exit(0)`、整段 `describe.skip`、用例被误删,都能让文件数不变而用例数缩水。
// 接入时实测 197 例(42+59+88+8),取 180 作下限:留 ~9% 余量,删掉零散几个用例不会误红,
// 但整块用例(最小的 shadow-batch 也有 8 例)或某个文件级静默失效必然触发。
// 与 MIN_EXPECTED_FILES 同理:确需下调时请一并说明原因。
const MIN_EXPECTED_TESTS = 180;

// 单测超时(复审非阻断建议 3)。node:test 默认无超时,一个挂起的用例会把 CI job 拖到
// 25 分钟上限才红;这里给每个用例 60s,超时按失败计,退出码非 0。
const TEST_TIMEOUT_MS = 60_000;

const files = readdirSync(scriptsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

if (files.length < MIN_EXPECTED_FILES) {
  console.error(
    `✖ scripts 的 node:test 用例只剩 ${files.length} 个(期望 ≥ ${MIN_EXPECTED_FILES}):${files.join(', ') || '(无)'}\n` +
      '  文件被删除或改名会让这条门静默变空,故 fail-closed。若确实要下线某个用例文件,' +
      '请同步下调 scripts/run-mjs-tests.mjs 的 MIN_EXPECTED_FILES 并说明原因。',
  );
  process.exit(1);
}

for (const name of files) {
  const source = readFileSync(join(scriptsDir, name), 'utf8');
  if (!/from\s+['"]node:test['"]/.test(source)) {
    console.error(
      `✖ scripts/${name} 不在 node:test 风格里(未 import 'node:test')。\n` +
        '  这条门只跑 node:test 用例;vitest 风格的 .test.mjs 请改用 .test.ts 并交给 vitest(见 vitest.config.ts 的 include)。',
    );
    process.exit(1);
  }
}

const targets = files.map((name) => join(scriptsDir, name));
console.log(`▶ scripts 的 node:test 用例:${files.length} 个文件 → ${files.join(', ')}`);

// 逐文件汇总:run() 每个文件跑完发一条带 `file` 的 test:summary;根汇总(file 为空)是总计。
// 用它而不是解析子进程 stdout,可避免 reporter 格式变化导致误判。
const perFile = new Map();
let rootSummary = null;
let exitCode = 0;

// 【踩坑记录】事件体有两种形态,不能只读 `event.data`:
//   - `for await (const e of stream)` 与在 `compose()` **之前**注册的 listener 拿到
//     `{ type, data }`;
//   - `stream.compose(reporter)` 会把 compose 之前**已缓冲**的事件重新 emit 一遍,而这一遍
//     发的是**裸数据体**(没有 `{ data }` 外壳)。若此时只手写 `event.data.file`,就会抛
//     `TypeError: Cannot read properties of undefined`,而该异常在 EventsStream 的发射路径里
//     被吞掉——表现为「汇总静默丢失、门禁放行」。这里统一取 payload,避免依赖事件形态。
const payloadOf = (event) =>
  event && typeof event === 'object' && event.data && typeof event.data === 'object'
    ? event.data
    : event;

try {
  const stream = run({ files: targets, timeout: TEST_TIMEOUT_MS });
  stream.on('test:summary', (event) => {
    const data = payloadOf(event);
    if (!data || typeof data !== 'object') return;
    if (data.file) perFile.set(data.file, data);
    else rootSummary = data;
  });
  // 用 spec reporter 打印,保持与 `node --test` 相近的可读输出。
  for await (const chunk of stream.compose(spec)) process.stdout.write(chunk);
} catch (err) {
  console.error(`✖ scripts runner 启动或汇总失败:${err && err.stack ? err.stack : err}`);
  process.exit(1);
}

if (!rootSummary) {
  console.error('✖ scripts runner 没有拿到根汇总(node:test 未正常结束),fail-closed。');
  process.exit(1);
}

const counts = rootSummary.counts;
const totalTests = counts.tests;
const totalFailed = counts.failed + counts.cancelled;

// 每个被扫描到的文件都必须报出汇总——少一个就说明有文件没被真正加载/执行
// (正是 glob 静默丢掉文件时会发生的情况,修复后不该再有)。
const silent = targets.filter((target) => !perFile.has(target));
if (silent.length > 0) {
  console.error(
    `✖ 以下 ${silent.length} 个文件没有报出汇总(未被加载或提前退出):\n` +
      silent.map((t) => `    - ${t}`).join('\n') +
      '\n  这条门要求每个 .test.mjs 都被真正执行,故 fail-closed。',
  );
  exitCode = 1;
}

if (totalTests < MIN_EXPECTED_TESTS) {
  console.error(
    `✖ scripts 的 node:test 用例只有 ${totalTests} 例(期望 ≥ ${MIN_EXPECTED_TESTS})。\n` +
      '  文件内用例被删、整段 describe.skip、或文件顶层提前 process.exit(0) 都会这样——' +
      '文件数下限拦不住,故再加一条用例数下限。确需下调请同步改 MIN_EXPECTED_TESTS 并说明原因。',
  );
  exitCode = 1;
}

if (totalFailed > 0) exitCode = 1;

console.log(
  `▶ 汇总:${perFile.size}/${files.length} 个文件、${totalTests} 例、失败 ${counts.failed}、取消 ${counts.cancelled}(下限:文件 ≥ ${MIN_EXPECTED_FILES}、用例 ≥ ${MIN_EXPECTED_TESTS})`,
);

process.exit(exitCode);