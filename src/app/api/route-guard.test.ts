import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// 41-q402fix：每个 API 路由导出的 HTTP 方法都必须经 withDbQuotaGuard 包装，
// 否则 Neon 配额耗尽（402）时该路由会回 500 / 驱动原文，前端与 cron 照常高频重打。
// 这是门禁而不是逐处补丁：新增路由忘了包装，这条就红。

const API_ROOT = join(__dirname);
const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

describe('API 路由配额闸覆盖（withDbQuotaGuard）', () => {
  const files = routeFiles(API_ROOT);

  it('找得到路由文件（扫描本身没失效）', () => {
    expect(files.length).toBeGreaterThanOrEqual(36);
  });

  it.each(files.map(f => [relative(API_ROOT, f).replace(/\\/g, '/'), f]))('%s：每个导出的 HTTP 方法都经包装', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    // 任何形态的直接导出（function 声明 / 未包装的 const / re-export）都算漏网。
    expect(text).not.toMatch(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(?:${METHODS})\\b`, 'm'));
    expect(text).not.toMatch(new RegExp(`^export\\s*\\{[^}]*\\b(?:${METHODS})\\b`, 'm'));
    const exported = [...text.matchAll(new RegExp(`^export\\s+(?:const|let|var)\\s+(${METHODS})\\s*=\\s*(.*)$`, 'gm'))];
    expect(exported.length).toBeGreaterThan(0);
    for (const [, method, rhs] of exported) {
      expect(rhs, `${method} 未经 withDbQuotaGuard 包装`).toMatch(/^withDbQuotaGuard\(/);
    }
  });
});
