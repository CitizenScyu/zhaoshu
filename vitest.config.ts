import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // 单元测试只使用显式 mock 的凭据，不读取部署用的 .env*。
  envDir: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // 组件测试(*.test.tsx)走 jsdom + Testing Library。tsconfig 的 jsx 是 react-jsx
  // (automatic runtime),但本仓这套 vite/esbuild 管道不读 tsconfig 的 jsx 字段,
  // 默认按 classic 转换(要求 React 在作用域)会报 "React is not defined"。
  // 在配置里显式指定 automatic,不额外装 @vitejs/plugin-react。
  // 全局环境仍是 node:现有 .test.ts 一个都不受影响;需要 DOM 的组件测试
  // 在自己文件顶部用 `// @vitest-environment jsdom` 单独声明。
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts', 'runtime-download/**/*.test.ts'],
    environment: 'node',
  },
});
