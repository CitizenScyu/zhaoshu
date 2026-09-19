// TS 加载 shim（薄路由 + tsc 转译），让纯 node 能加载 src/ 下的 TS 图，无需任何 --experimental 旗标。
//
// 背景（见 t4-engine-cli-report.md §import）：node 自带的 --experimental-strip-types 是「只剥不转」——
// 无法处理引擎图里的两类语法：① 参数属性（source-fetch.ts `constructor(readonly status)`）；
// ② 未加 `type` 标记的类型 import（jsonpath.ts/parse.ts `import { CssStep } from './types'`）。
// --experimental-transform-types 能解 ①，但 ② 需要跨文件类型信息才能判定该 import 是否为纯类型，
// strip/transform 都做不到。故本 shim 用仓库已装的 typescript（devDep，5.9.x）做单文件转译：
//   - transpileModule 按「未作为值引用即视为类型」的经典 TS 语义，正确 elide 纯类型 import（解 ②）；
//   - 参数属性/枚举等下降为运行时代码（解 ①）。
//
// 两个 hook：
//   resolve —— `@/x` → <repo>/src/x（tsconfig paths 只在 tsc/vitest 生效）；对 `@/`、`./`、`../`
//     的无扩展名 specifier 按 .ts/.tsx/.mjs/.js + index 兜底补全（node ESM 需显式扩展名）。
//   load    —— 命中 .ts/.tsx 的 file: URL 时读源 + transpileModule，返回 ES module 源码。
// 裸包（node_modules、node: 内置）与非 TS 文件一律交回默认。
//
// 用法：node --import ./scripts/ts-alias-hook.mjs <entry>（本文件被 --import 时自注册 hook）。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const SRC_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'src');

/** 给一个「可能缺扩展名」的绝对路径找到真实文件 URL；找不到返回 null（交回默认解析报错）。 */
function resolveFile(absPath) {
  const candidates = [
    absPath,
    `${absPath}.ts`, `${absPath}.tsx`, `${absPath}.mjs`, `${absPath}.js`,
    path.join(absPath, 'index.ts'), path.join(absPath, 'index.tsx'),
    path.join(absPath, 'index.mjs'), path.join(absPath, 'index.js'),
  ];
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return pathToFileURL(candidate).href; } catch { /* 试下一个 */ }
  }
  return null;
}

const hook = {
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const url = resolveFile(path.join(SRC_DIR, specifier.slice(2)));
      if (url) return { url, shortCircuit: true };
    } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
      const url = resolveFile(fileURLToPath(new URL(specifier, context.parentURL)));
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
      const fileName = fileURLToPath(url);
      const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
        fileName,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false, // 让 tsc elide 纯类型 import（本 shim 的核心）
          useDefineForClassFields: true,
          jsx: ts.JsxEmit.Preserve,
        },
      });
      return { format: 'module', source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
};

registerHooks(hook);

export default hook;
