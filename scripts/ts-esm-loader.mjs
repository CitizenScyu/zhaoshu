// Node ESM 定制钩子：让运维脚本能直接 import 仓库里的 TS 模块（含 `@/` 别名、
// 无扩展名相对导入、TS 专有语法）。两种用法：
//   1. `node --import ./scripts/ts-esm-loader.mjs <entry>`（本文件被 --import 时自注册 hook，
//      engine-fetch.mjs CLI 走这条路）；
//   2. 在脚本顶部 `register('./ts-esm-loader.mjs', import.meta.url)` 后
//      `await import('../src/lib/rule-engine/admission.ts')`（seed-admission.mjs 走这条路）。
//
// 为什么不用 `node --experimental-strip-types`：本仓库 tsconfig 是 bundler 目标
// （moduleResolution=bundler、非 verbatimModuleSyntax），引擎/admission 依赖图里
// 既有 TS 参数属性（strip-only 不支持），又有「类型与值混在一个 import 里、不标 `type`」
// 的跨模块类型导入——strip/transform 都无法跨模块消除，只有真正的转译器能做到。
// 这里复用 vitest 同款转译器 esbuild（vite 传递依赖，仓库已装），语义与单测环境一致，
// rulesHash 等结论逐字相同。
//
// 历史：本文件由两份 shim 合并而来（tsc 转译的旧 ts-alias-hook.mjs + esbuild 版）。
// 旧版的目录 index 兜底（`@/x` → src/x/index.ts）在此保留——tsconfig paths 语义下的
// 无扩展名目录导入需要它；转译器换成 esbuild 后不再依赖 typescript devDep
// （phoenix 部署无需 `npm i typescript --no-save`，改装 esbuild）。

import { registerHooks } from 'node:module';
import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { transformSync } from 'esbuild';

const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), '..', '..');
const SRC_DIR = resolvePath(REPO_ROOT, 'src');

/** 给一个「可能缺扩展名」的绝对路径找到真实文件 URL；找不到返回 null（交回默认解析报错）。 */
function resolveFile(absPath) {
  const candidates = [
    absPath,
    `${absPath}.ts`, `${absPath}.tsx`, `${absPath}.mjs`, `${absPath}.js`,
    resolvePath(absPath, 'index.ts'), resolvePath(absPath, 'index.tsx'),
    resolvePath(absPath, 'index.mjs'), resolvePath(absPath, 'index.js'),
  ];
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return pathToFileURL(candidate).href; } catch { /* 试下一个 */ }
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  // `@/x` → <repo>/src/x（tsconfig paths `@/*` → ./src/* 同义；.ts/.tsx/index 兜底补全）。
  if (specifier.startsWith('@/')) {
    const url = resolveFile(resolvePath(SRC_DIR, specifier.slice(2)));
    if (url) return { url, shortCircuit: true };
  }
  // 无扩展名相对导入优先按 .ts/.tsx/index 解析（bundler 风格源码不写扩展名）；
  // 找不到交回默认解析（含裸包、node: 内置、显式扩展名文件）。
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const url = resolveFile(fileURLToPath(new URL(specifier, context.parentURL)));
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith('file://') && /\.tsx?$/.test(url)) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'esm',
      sourcefile: fileURLToPath(url),
      target: 'node22',
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}

// import 该模块即注册（与被 register() 注册同一份 hook，一处维护）。ts-alias-hook 的原语义：
// 被 `node --import ./scripts/ts-esm-loader.mjs` 加载时立即生效；被 register() 引用时
// register 自带注册语义（幂等：registerHooks 重复注册同一 hook 对象无害）。
const hook = { resolve, load };

registerHooks(hook);

export default hook;
