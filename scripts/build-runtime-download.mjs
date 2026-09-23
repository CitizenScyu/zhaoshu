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
const START = '  // ---- 执行器接缝（T3 交付后替换）----';
const END = '\n  const loop = createDrainLoop({';
const startAt = original.indexOf(START);
const endAt = original.indexOf(END, startAt);
if (startAt < 0 || endAt < 0) {
  throw new Error('main.mjs 执行器接缝锚点未找到：shell 已变更，需人工复核（未生成 tar）');
}
const injection = `${START}
  let dummyTasks = 2;
  let productionRunOnce = null;
  const runOnce = async (signal) => {
    if (dummy) {
      if (dummyTasks <= 0) return LoopDecision.NO_TASK;
      const consumed = await budget.consume();
      if (!consumed.allowed) return LoopDecision.BUDGET_EXHAUSTED;
      dummyTasks -= 1;
      log('info', 'dummy 执行器完成一本（合成任务）', { used: consumed.used, limit: consumed.limit });
      return LoopDecision.TASK_DONE;
    }
    if (!productionRunOnce) {
      const { createDownloadExecutor } = await import('../executor/executor.mjs');
      const executor = await createDownloadExecutor({
        budget,
        // 与上文 createDailyBudget 同一状态文件：书源不可达的尝试凭它退还日预算（41-EXEC-SRCUNAVAIL）。
        budgetStatePath: join(stateDir, 'daily-budget.json'),
        // 与上文 createDailyBudget 同一上限：shell read() 不回上限，扣额度前预检据此判断「今天已满就不预检」。
        budgetLimit: config.dailyBookLimit,
        workDir: join(stateDir, 'download'),
        rateLimiter: new SourceRateLimiter(),
        decisions: LoopDecision,
        log,
      });
      productionRunOnce = executor.runOnce;
    }
    return productionRunOnce(signal);
  };`;
const patched = original.slice(0, startAt) + injection + original.slice(endAt);
// 限速器来自 shell 自身（单一实例，真实 HTTP 请求层共享）。
if (!patched.includes("from '../lib/rate-limiter.mjs'")) {
  const anchor = "import { createDailyBudget } from '../lib/daily-budget.mjs';";
  if (!patched.includes(anchor)) throw new Error('main.mjs rate-limiter 注入锚点未找到');
  writeFileSync(mainPath, patched.replace(anchor, `${anchor}\nimport { SourceRateLimiter } from '../lib/rate-limiter.mjs';`), 'utf8');
} else {
  writeFileSync(mainPath, patched, 'utf8');
}

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
