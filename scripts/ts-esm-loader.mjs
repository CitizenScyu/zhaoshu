// Node ESM 定制钩子：让运维脚本能直接 import 仓库里的 TS 模块（含 `@/` 别名、
// 无扩展名相对导入、TS 专有语法）。用法：在脚本顶部
//   import { register } from 'node:module';
//   register('./ts-esm-loader.mjs', import.meta.url);
//   const mod = await import('../src/lib/rule-engine/admission.ts');
//
// 为什么不用 `node --experimental-strip-types`：本仓库 tsconfig 是 bundler 目标
// （moduleResolution=bundler、非 verbatimModuleSyntax），admission.ts 的依赖图里
// 既有 TS 参数属性（strip-only 不支持），又有「类型与值混在一个 import 里、不标 `type`」
// 的跨模块类型导入——strip/transform 都无法跨模块消除，只有真正的转译器能做到。
// 这里复用 vitest 同款转译器 esbuild（仓库已装），语义与单测环境一致，rulesHash 等结论逐字相同。

import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const SRC = pathToFileURL(resolvePath(process.cwd(), 'src') + '/').href;
const bare = (u) => u.slice(u.lastIndexOf('/') + 1);

export async function resolve(specifier, context, nextResolve) {
  // `@/foo` → <repo>/src/foo（.ts 补全）：与 tsconfig paths `@/*` → ./src/* 同义。
  if (specifier.startsWith('@/')) {
    let url = SRC + specifier.slice(2);
    if (!bare(url).includes('.')) url += '.ts';
    return nextResolve(url, context);
  }
  // 无扩展名相对导入优先按 .ts 解析（bundler 风格源码不写扩展名）；失败再回落默认解析。
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!bare(specifier).includes('.')) {
      try { return await nextResolve(specifier + '.ts', context); } catch { /* 回落 */ }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
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
