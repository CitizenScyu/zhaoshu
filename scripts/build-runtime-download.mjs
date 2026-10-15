#!/usr/bin/env node
// T8 打包脚本：把 runtime-download 绑定层 + T3 任务层打成一个自包含 ESM，
// 连同 zhaoshu-books/runtime 的 shell 与 @neondatabase/serverless 依赖一起产出可部署 tar。
//
// 用法：node scripts/build-runtime-download.mjs
//   必须显式指定 RUNTIME_SHELL_DIR（含共享限速监督者的 shell 源；不再默认使用 T7）
// 复现性：先清空 runtime-download/build 再全量生成；tar 只含 runtime/ + node_modules/。
//
// 说明：main.mjs 的「执行器接缝」是 T7 明确标注的替换点（runtime/service/main.mjs:59-78）。
// 本脚本在**构建产物**里注入装配代码（不动 zhaoshu-books 源文件）；锚点找不到即硬失败。

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireDownloadExecutor } from './runtime-download-template.mjs';
import { assertSharedRuntimeShell, renderPrefetchService } from './runtime-prefetch-template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const buildDir = join(repoRoot, 'runtime-download', 'build');
const shellInput = process.env.RUNTIME_SHELL_DIR;
if (!shellInput?.trim()) throw new Error('RUNTIME_SHELL_DIR_REQUIRED');
const shellDir = resolve(shellInput);
const runtimeOut = join(buildDir, 'runtime');
const executorOut = join(runtimeOut, 'executor', 'executor.mjs');
const prefetchEntryPath = join(repoRoot, 'runtime-download', 'prefetch-entry.ts');
const prefetchExecutorOut = join(runtimeOut, 'executor', 'prefetch.mjs');
const tarPath = join(buildDir, 'zhaoshu-download-runtime.tar.gz');
const NEON_DEP = '@neondatabase/serverless';

if (!existsSync(join(shellDir, 'service', 'main.mjs'))) {
  throw new Error(`runtime shell 未找到：${shellDir}（用 RUNTIME_SHELL_DIR 覆盖）`);
}

// 来源门在 rm/build/copy 之前：只读取 shell 源码，不 import 执行、不读取部署 env 文件。
// T7 缺共享装配即明确拒绝；不能仅靠记住覆盖目录来保证生成的预取服务可启动。
const shellSources = {};
for (const relative of ['service/main.mjs', 'lib/env.mjs', 'lib/shared-rate/limiter.mjs',
  'lib/shared-rate/startup.mjs', 'lib/shared-rate/supervisor.mjs']) {
  const path = join(shellDir, relative);
  if (!existsSync(path)) throw new Error('RUNTIME_SHELL_SHARED_SOURCE_MISSING');
  shellSources[relative] = readFileSync(path, 'utf8');
}
assertSharedRuntimeShell(shellSources);

if (!existsSync(prefetchEntryPath)) throw new Error('PREFETCH_ENTRY_MISSING');

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(dirname(executorOut), { recursive: true });

// dlfail42 根因：cheerio 链在 pnpm 锁文件里解析到 css-select@5.1.0 + nth-check@2.0.1（CJS-only），
// Node ESM / esbuild node-mode 互操作把 `import getNCheck from "nth-check"` 的 default 绑成
// namespace 对象 ⇒ 任何 `:nth-*` 伪类选择器编译即抛（book.qq TOC `ul:nth-of-type(2)` 速败根因，
// 池内 75 个源的规则含 nth 伪类）。顶层 css-select@5.2.2 + nth-check@2.1.1（真 ESM default）组合正常。
// 构建时把 cheerio 链的 css-select 重定向到顶层 5.2.2；正路修复（pnpm override 重装）受共享
// node_modules 约束暂缓，见 follow-up。
const require = createRequire(import.meta.url);
const cssSelectDir = resolve(require.resolve('css-select'), '../..');
if (!/css-select$/.test(cssSelectDir)) throw new Error(`css-select 别名解析异常：${cssSelectDir}`);
const SELECTOR_FIX_ALIAS = { 'css-select': cssSelectDir };

// 1) esbuild：绑定层 + T3 + 引擎模块 → 单文件 ESM（无 loader）。
const esbuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  tsconfig: join(repoRoot, 'tsconfig.json'),
  external: [NEON_DEP],
  alias: SELECTOR_FIX_ALIAS,
  logLevel: 'warning',
  banner: {
    // 让被打进来的 CJS 依赖（cheerio/entities 等）在 ESM 里拿到 require。
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};
await build({
  entryPoints: [join(repoRoot, 'runtime-download', 'entry.ts')],
  outfile: executorOut,
  ...esbuildOptions,
});
await build({
  entryPoints: [prefetchEntryPath],
  outfile: prefetchExecutorOut,
  ...esbuildOptions,
});

// dlfail42 门禁：别名没生效时 cheerio 链会打回 nth-check@2.0.1（CJS-only，nth 伪类互操作坏副本）。
for (const bundle of [executorOut, prefetchExecutorOut]) {
  if (readFileSync(bundle, 'utf8').includes('nth-check@2.0.1')) {
    throw new Error(`nth-check 互操作坏副本打进 bundle：${bundle}（css-select 别名未生效）`);
  }
}

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
writeFileSync(join(runtimeOut, 'service', 'prefetch.mjs'), renderPrefetchService(), 'utf8');

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
