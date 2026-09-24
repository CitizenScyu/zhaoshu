#!/usr/bin/env node
// B2-05 快照卷 GC 只读核对(dry-run,永不删除)。逐书串行,只发 GET。
//
// 用法:
//   node scripts/snapshot-gc-dry-run.mjs [--env-file <path>] [--limit N] [--offset N] [--stem <编码stem>]... [--min-rate N] [--json]
// 凭据:GITHUB_TOKEN / GITHUB_REPOSITORY / DOWNLOAD_TARGET_BRANCH(缺省 main)。--env-file 按键名白名单逐行读,
// 文件里其它键不进进程;不给则取进程环境。输出不含凭据。
// 主体在 runtime-download/snapshot-gc-cli.ts(经 ts-esm-loader 加载仓库 TS)。

import { register } from 'node:module';

register('./ts-esm-loader.mjs', import.meta.url);
const { main } = await import('../runtime-download/snapshot-gc-cli.ts');

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`snapshot-gc-dry-run: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
