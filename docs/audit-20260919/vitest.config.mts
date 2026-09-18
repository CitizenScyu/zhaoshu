import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';

// Separate characterization suite: passing means the reported defect exists.
export default defineConfig({
  ...base,
  test: { include: ['docs/audit-20260919/*.test.ts'], fileParallelism: false },
});
