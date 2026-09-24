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
//
// 【41-MJSGATE-FIX 复审非阻断 4】原先只 `readdirSync(scriptsDir)` 扫顶层:子目录或仓库别处
//   新增的 .test.mjs 既不进这道门,也没有任何提示——又一个「静默漏跑」。现在先用 git 的
//   文件清单清点**全仓**的 .test.mjs,落在 scripts/ 顶层之外的**判红**(fail-closed),
//   而不是自动纳入运行。选 fail-closed 的理由:
//     - 落在别处的 .test.mjs 可能是 vitest 风格(缺 vitest 环境跑不了)、可能依赖别的
//       tsconfig/构建产物、也可能只是没清掉的草稿。自动跑会把「这文件该不该进这道门」这个
//       需要人来定的问题,悄悄塞给 CI 去猜,猜错就是假红或不稳。
//     - 本仓一贯的做法是把护栏写成显式断言(文件数下限、用例数下限、pglite 不许静默跳过),
//       这里同类:让契约显式化——「这道门只跑 scripts/ 顶层的 node:test 用例」,违反了就报
//       路径让人处理。真要把别处的文件纳入,应显式挪进 scripts/ 顶层,而不是让扫描范围漂移。

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);

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

// ---------------------------------------------------------------------------
// 全仓清点 *.test.mjs(复审非阻断 4)
// ---------------------------------------------------------------------------
// 用 git 自己的清单,而不是手写递归遍历 + 排除表:
//   --cached            已入库的
//   --others            还没入库的新文件(用例刚写、尚未 commit 时也要算数,否则又漏)
//   --exclude-standard  交给仓库自己的 .gitignore —— node_modules(本仓是指向主 checkout 的
//                       链接目录)、.next、.git、build 产物等都在其中,不必维护第二份排除表
//   -z                  用 NUL 分隔,文件名里的特殊字符(如 `[`)、空格、换行都不会被转义或截断
// 代价是依赖 git 可执行。这是 fail-closed 的一环而非缺陷:枚举不出仓库文件就不能保证
// 「没有漏跑的文件」,此时宁可红,也不能静默只跑已知的 4 个。CI 有 checkout、pre-push
// 本身就要 git,正常路径不会缺。
const listed = spawnSync(
  'git',
  ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.test.mjs'],
  { encoding: 'utf8' },
);

if (listed.error || listed.status !== 0) {
  console.error(
    `✖ 无法用 git 清点仓库里的 *.test.mjs(${listed.error ? listed.error.message : `git 退出码 ${listed.status}`})。\n` +
      '  这道门靠 git 的文件清单保证「全仓 .test.mjs 都交代过」,枚举不出来就不能保证没漏跑,故 fail-closed。\n' +
      '  请确认在 git 工作副本里跑(CI 有 checkout;pre-push 钩子本身要求 git)。',
  );
  process.exit(1);
}

// git 输出的是仓库根相对、以 `/` 分隔的路径;统一成平台分隔符便于按目录判断与展示。
const repoTestFiles = listed.stdout
  .split('\0')
  .filter(Boolean)
  .map((p) => p.split('/').join(sep))
  .sort();

const isTopLevelScripts = (relPath) => {
  const parts = relPath.split(sep);
  return parts.length === 2 && parts[0] === 'scripts';
};

const misplaced = repoTestFiles.filter((p) => !isTopLevelScripts(p));
if (misplaced.length > 0) {
  console.error(
    `✖ 发现 ${misplaced.length} 个 .test.mjs 不在 scripts/ 顶层——它们不在任何门禁里(会被静默漏跑):\n` +
      misplaced.map((p) => `    - ${p}`).join('\n') +
      '\n  这道门只跑 scripts/ 顶层的 node:test 用例。请二选一后重跑:\n' +
      '    · 若它是 node:test 用例 → 挪到 scripts/ 顶层,本门会自动收录;\n' +
      '    · 若它是 vitest 用例 → 改名 .test.ts 交给 vitest(见 vitest.config.ts 的 include),别用 .test.mjs。',
  );
  process.exit(1);
}

const files = repoTestFiles.map((p) => basename(p));

if (files.length < MIN_EXPECTED_FILES) {
  console.error(
    `✖ scripts 的 node:test 用例只剩 ${files.length} 个(期望 ≥ ${MIN_EXPECTED_FILES}):${files.join(', ') || '(无)'}\n` +
      '  文件被删除或改名会让这条门静默变空,故 fail-closed。若确实要下线某个用例文件,' +
      '请同步下调 scripts/run-mjs-tests.mjs 的 MIN_EXPECTED_FILES 并说明原因。',
  );
  process.exit(1);
}

for (const name of files) {
  const abs = join(scriptsDir, name);
  // git 清单来自 index:文件已 staged 但工作区里被删掉时仍会列出,此时读取会抛 ENOENT。
  // 这是改用 git 清点后新出现的路径,显式挡住并给出人话,别留给未捕获异常。
  if (!existsSync(abs)) {
    console.error(
      `✖ scripts/${name} 在 git 清单里但工作区不存在(被删了却没提交?)。\n` +
        '  这道门要求被清点到的文件都真实存在可跑,故 fail-closed。',
    );
    process.exit(1);
  }
  const source = readFileSync(abs, 'utf8');
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