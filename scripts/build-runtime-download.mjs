#!/usr/bin/env node
// T8 打包脚本：把 runtime-download 绑定层 + T3 任务层打成一个自包含 ESM，
// 连同 zhaoshu-books/runtime 的 shell 与 @neondatabase/serverless 依赖一起产出可部署 tar。
//
// 用法：node scripts/build-runtime-download.mjs
//   env RUNTIME_SHELL_DIR 覆盖 shell 目录（默认 ../zhaoshu-books/runtime）
// 复现性：先清空 runtime-download/build 再全量生成；tar 只含 runtime/ + node_modules/。
//
// 说明：main.mjs 的「执行器接缝」是 T7 明确标注的替换点（runtime/service/main.mjs:59-78）。
// 本脚本在**构建产物**里注入装配代码（不动 zhaoshu-books 源文件）；锚点找不到即硬失败。

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireDownloadExecutor } from './runtime-download-template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const buildDir = join(repoRoot, 'runtime-download', 'build');
const shellDir = resolve(process.env.RUNTIME_SHELL_DIR ?? join(repoRoot, '..', 'zhaoshu-books', 'runtime'));
const runtimeOut = join(buildDir, 'runtime');
const executorOut = join(runtimeOut, 'executor', 'executor.mjs');
const tarPath = join(buildDir, 'zhaoshu-download-runtime.tar.gz');
const NEON_DEP = '@neondatabase/serverless';

if (!existsSync(join(shellDir, 'service', 'main.mjs'))) {
  throw new Error(`runtime shell 未找到：${shellDir}（用 RUNTIME_SHELL_DIR 覆盖）`);
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(dirname(executorOut), { recursive: true });

// 1) esbuild：绑定层 + T3 + 引擎模块 → 单文件 ESM（无 loader、无别名）。
await build({
  entryPoints: [join(repoRoot, 'runtime-download', 'entry.ts')],
  outfile: executorOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  tsconfig: join(repoRoot, 'tsconfig.json'),
  external: [NEON_DEP],
  logLevel: 'warning',
  banner: {
    // 让被打进来的 CJS 依赖（cheerio/entities 等）在 ESM 里拿到 require。
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// 2) 拷贝 shell（用 T7 的目录形态：runtime/service + runtime/lib + runtime/timer + docs）。
cpSync(join(shellDir, 'service'), join(runtimeOut, 'service'), { recursive: true });
cpSync(join(shellDir, 'lib'), join(runtimeOut, 'lib'), { recursive: true });
for (const extra of ['timer', 'docs', 'systemd', 'README.md']) {
  const src = join(shellDir, extra);
  if (existsSync(src)) cpSync(src, join(runtimeOut, extra), { recursive: true });
}

// 3) 注入执行器接缝到构建产物里的 main.mjs（源文件零改动）。
const mainPath = join(runtimeOut, 'service', 'main.mjs');
const original = readFileSync(mainPath, 'utf8');
writeFileSync(mainPath, wireDownloadExecutor(original), 'utf8');

// 4) 依赖：把 external 的 @neondatabase/serverless 随包分发（与 T7 tar 策略一致）。
const neonSrc = join(repoRoot, 'node_modules', NEON_DEP);
if (!existsSync(neonSrc)) throw new Error(`缺少依赖 ${NEON_DEP}（先 npm ci）`);
cpSync(neonSrc, join(runtimeOut, '..', 'node_modules', NEON_DEP), { recursive: true });
rmSync(join(runtimeOut, '..', 'node_modules', NEON_DEP, 'test'), { recursive: true, force: true });

// 5) tar（GNU tar 兼容；cwd 切到 build 目录避免 Windows 盘符被当远程主机）。
execFileSync('tar', ['-czf', 'zhaoshu-download-runtime.tar.gz', 'runtime', 'node_modules'], { cwd: buildDir, stdio: 'inherit' });
const hash = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
writeFileSync(`${tarPath}.sha256`, `${hash}  zhaoshu-download-runtime.tar.gz\n`, 'utf8');

console.log(JSON.stringify({
  executor: executorOut,
  tar: tarPath,
  sha256: hash,
  bytes: readFileSync(tarPath).byteLength,
}, null, 2));
