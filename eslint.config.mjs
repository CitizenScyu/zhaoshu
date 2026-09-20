import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
  ]),
]);

export default eslintConfig;
