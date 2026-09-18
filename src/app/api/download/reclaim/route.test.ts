import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, sql } = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  sql: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));

import { GET } from './route';
import { isLeaseExpired } from '@/lib/download-task-reclaim';

const SECRET = 'download-reclaim-test-secret';

function request(secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return new NextRequest('http://localhost/api/download/reclaim', { headers });
}

function queryText(index: number) {
  return sql.mock.calls[index][0].join('?').replace(/\s+/g, ' ').trim();
}

describe('GET /api/download/reclaim (F16 周期回收)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockReturnValue(sql);
    sql.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('未配置 CRON_SECRET 时 fail closed', async () => {
    const res = await GET(request('anything'));
    expect(res.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });

  it('拒绝错误 secret，且不触达数据库', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const res = await GET(request('wrong-secret'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', code: 'FORBIDDEN' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('正确 secret 触发过期租约回收——回收不依赖用户 POST', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const res = await GET(request(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 复用与 POST 相同的回收谓词：running 且心跳过期；活跃心跳不在其中。
    const query = queryText(0);
    expect(query).toMatch(/^UPDATE download_tasks SET status = 'failed',/);
    expect(query).toContain("status = 'running' AND updated_at < now()");
    expect(query).toContain("interval '1 millisecond'");
    expect(sql.mock.calls[0].slice(1)).toEqual(['\nworker 中断自动回收', 30 * 60_000]);
  });

  it('回收失败返回受控 500', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    sql.mockRejectedValueOnce(new Error('database unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request(SECRET));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'db error', code: 'DB_ERROR' });
  });
});

describe('isLeaseExpired 派生边界', () => {
  const now = Date.parse('2026-09-19T00:30:00.000Z');
  it('只有 running 且心跳超过 30 分钟才算过期', () => {
    expect(isLeaseExpired('running', '2026-09-18T23:59:59.000Z', now)).toBe(true); // 30 分钟前
    expect(isLeaseExpired('running', '2026-09-19T00:00:01.000Z', now)).toBe(false); // 略新于心跳阈值
    expect(isLeaseExpired('failed', '2020-01-01T00:00:00.000Z', now)).toBe(false);
    expect(isLeaseExpired('partial', '2020-01-01T00:00:00.000Z', now)).toBe(false);
  });
  it('时间无法解析时不宣称过期（避免误报诱导重复提交）', () => {
    expect(isLeaseExpired('running', 'not-a-date', now)).toBe(false);
  });
});
