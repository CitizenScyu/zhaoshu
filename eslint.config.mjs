import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { clientReachableFiles } from "./scripts/client-reachability.mjs";

// 浏览器基线:本仓要支持的浏览器早于 Chrome 116 / Safari 17.4。下列 API 在那个基线里
// 不存在,客户端代码一调就直接抛(TypeError),而纯服务端(Node ≥20)调用完全没问题。
// 因此规则**只作用于会进客户端 bundle 的文件**——由 scripts/client-reachability.mjs
// 从 `'use client'` 边界算 import 图得出,不按目录猜(本仓客户端组件与纯服务端 lib
// 混在 src/lib 下)。服务端文件不在列表里,天然不报。
const clientFiles = clientReachableFiles();

const browserBaselineMessage = (api, alternative) =>
  `${api} 超出本仓浏览器基线(Chrome 116 / Safari 17.4):基线以下的浏览器调用会直接抛。` +
  `这里是会进客户端 bundle 的代码,改用 ${alternative}。` +
  `(纯服务端文件不受此规则约束;判定见 scripts/client-reachability.mjs。)`;

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: clientFiles,
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "AbortSignal",
          property: "any",
          message: browserBaselineMessage(
            "AbortSignal.any",
            "src/lib/abort-merge.ts 的 mergeAbortSignals([...])",
          ),
        },
        {
          object: "AbortSignal",
          property: "timeout",
          message: browserBaselineMessage(
            "AbortSignal.timeout",
            "src/lib/abort-merge.ts 的 timeoutSignal(ms),并在请求结束时 dispose()",
          ),
        },
        {
          object: "Object",
          property: "hasOwn",
          message: browserBaselineMessage(
            "Object.hasOwn",
            "Object.prototype.hasOwnProperty.call(obj, key)",
          ),
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // shuyuan-refresh 打包产物:esbuild 生成的单文件 bundle(.gitignore 已排除)。
    // 不忽略则 `npm run lint` 会把它当源码 lint——实测 17 error/2184 warning 全来自
    // 打进来的第三方依赖(minified:单行 500+ 列、this 别名、无 displayName),
    // 把 pre-push 门(与 CI 同款 `npm run lint`)整体挡红。源码 lint 不受影响。
    "shuyuan-refresh/dist/**",
    // 子代理 worktree 目录:每个并行代理的完整 checkout 副本(含各自 dist 产物、
    // 临时 .tmp.test.ts)。不忽略则 `npm run lint` 会把每个 worktree 里的源码再 lint
    // 一遍,把 pre-push 门(与 CI 同款 `npm run lint`)整体挡红,而 CI 干净 checkout
    // 没有这些目录、反而是绿的——门禁红得毫无意义,还挡住所有 push。
    ".claude/**",
  ]),
]);

export default eslintConfig;
