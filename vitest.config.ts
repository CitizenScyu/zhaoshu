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
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'runtime-download/**/*.test.ts'],
    environment: 'node',
  },
});
