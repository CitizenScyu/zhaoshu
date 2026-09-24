// scripts 下的 node:test 用例入口(41-MJSGATE)。
//
// 为什么需要这个 runner,而不是直接把 `node --test "scripts/*.test.mjs"` 写进 package.json:
//   1) fail-closed。node 自己的 glob 一个匹配都没有时报「0 tests」并**退出 0**——护栏会
//      静默消失(本仓最忌讳的失效模式,见 ci.yml 里对 pglite 用例静默跳过的断言)。这里
//      显式列文件并对文件数做下限断言,文件被删/改名就红。
//   2) 风格校验。这条门只跑 node:test 风格的 .test.mjs(describe/it + node:assert)。
//      vitest 风格的 .test.mjs 混进来会因缺 vitest 环境而跑不了,这里提前给出明确报错,
//      而不是留一个「看着绿、其实没跑」的假通过。
//   3) 跨平台一致。不依赖 shell 与 node 的 glob 展开差异(Windows cmd/PowerShell 不展开 glob)。
//
// 为什么不并进 vitest.config.ts 的 include:这 4 个文件用的是 node:test API,迁到 vitest
//   要改每个文件的 import 与断言,改动面远大于收益;两套 runner 各自跑各自风格的用例。

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// 下限常量:新增 .test.mjs 时**不需要**改这里;只有删除或改名导致数量掉到 4 以下才触发,
// 而那正是这条门要拦的情况。4 = 接入时的既有文件数(backfill_authors / import_labels /
// normalize_author / shadow-batch)。
const MIN_EXPECTED_FILES = 4;

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

const result = spawnSync(process.execPath, ['--test', ...targets], { stdio: 'inherit' });
process.exit(result.status ?? 1);