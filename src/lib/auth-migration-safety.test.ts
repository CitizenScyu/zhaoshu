import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertAuthSchema, AuthSchemaRequiredError } from './auth-store';
import { requireUserId } from './user-data';

// 三个用例组各 spawnSync 一个 node 子进程跑真实脚本（type-stripping 加载 TS 模块图，
// 机器忙时冷启动可达数秒）。脚本本身已带 10s timeout，vitest 外层超时必须比它宽，
// 否则并行饥饿时外层先到点、留下孤儿进程（2026-09-17 flake 排查：默认 5s testTimeout
// 与脚本 10s timeout 倒挂）。只放宽本文件，不改全局缺省。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('迁移入口与冷启动边界', () => {
  it.each([3, 4, null])('版本 %s 不能被普通请求自动修复', async (version) => {
    const sql = vi.fn().mockResolvedValue([{ version }]);
    await expect(assertAuthSchema(sql as never)).rejects.toBeInstanceOf(AuthSchemaRequiredError);
    expect(sql).toHaveBeenCalledOnce(); expect(sql.mock.calls[0][0].join('')).toMatch(/^SELECT max\(version\)/);
  });
  it('v6 校验只读；连接故障不会被伪装成缺迁移', async () => {
    const sql = vi.fn().mockResolvedValue([{ version: 6 }]);
    await assertAuthSchema(sql as never);
    const error = { code: '08006' }; sql.mockRejectedValueOnce(error);
    await expect(assertAuthSchema(sql as never)).rejects.toBe(error);
  });
  it('业务 schema 声明没有旧全局唯一索引、owner 默认值或迁移调用', () => {
    const text = readFileSync(new URL('./business-schema.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/recommendations_book_query_idx|UNIQUE\s*\(book_id, query\)|user_id[^\n]*DEFAULT 1|initializeAuthSchema/);
    expect(text).toContain('recommendations_user_book_query_idx');
    const db = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    expect(db.indexOf('await assertAuthSchema(s)')).toBeLessThan(db.indexOf('await initializeBusinessSchema(s)'));
    expect(db).not.toMatch(/export async function (?:getProfile|saveProfile|getExcludedBookKeys|getExcludedBookTitles|persistRecommendations)\(/);
  });
  it.each([undefined, null, 0, -1, 1.5, Number.NaN])('拒绝缺失或无效 userId %s', (userId) => {
    expect(() => requireUserId(userId as number)).toThrow('explicit userId is required');
  });
  it.each(['scripts/migrate-user-auth.mjs', 'scripts/test-auth-db.mjs'])('%s 缺 TEST_DATABASE_URL 退出 2，不回退业务连接', (script) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: 'postgresql://must-not-be-used.invalid/production', NODE_NO_WARNINGS: '1' };
    delete env.TEST_DATABASE_URL;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script], { env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(2); expect(result.stderr).toContain('TEST_DATABASE_URL');
    expect(result.stdout + result.stderr).not.toContain('must-not-be-used');
  });
  it.each(['--case=unknown', '--case='])('未知 case %s 不执行数据库测试也不能空跑成功', (argument) => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/test-auth-db.mjs', argument], {
      env: { ...process.env, TEST_DATABASE_URL: 'postgresql://must-not-connect.invalid/test', NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1); expect(result.stdout).not.toContain('检查通过');
    expect(result.stderr).not.toContain('must-not-connect');
  });
});
