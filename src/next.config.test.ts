// next.config.ts 的安全响应头（review-42 MS-11）：直接导入待测模块的纯函数断言，
// 不起 Next 服务、不走构建产物。导入的是 next/dist/config 的已解析默认导出。
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

describe('global security response headers (MS-11)', () => {
  it('applies the three baseline headers to every route', async () => {
    const headers = typeof nextConfig.headers === 'function' ? await nextConfig.headers() : [];
    const applied = headers.find((entry) => entry.source === '/:path*');
    expect(applied, '缺少 source "/:path*" 的全站规则').toBeDefined();
    if (!applied) return;

    const map: Record<string, string> = {};
    for (const { key, value } of applied.headers) map[key] = value;

    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(map[key], `缺少响应头 ${key}`).toBe(value);
    }
  });

  it('uses the catch-all source so static assets and api routes are covered too', async () => {
    const headers = typeof nextConfig.headers === 'function' ? await nextConfig.headers() : [];
    expect(headers.some((entry) => entry.source === '/:path*')).toBe(true);
  });
});
