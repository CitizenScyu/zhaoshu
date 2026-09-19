import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';

// F15 残留③：drain 入口的安全与接线。真正的租约/退避/水位语义在
// user-data.feedback-lease.pglite.test.ts（真库）；吸收路径的状态机在
// absorb/route.test.ts。这里钉住：cron 鉴权 fail closed、drain 复用同一条吸收路径、
// 单用户失败不拖垮批次、错误摘要不带原文。

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  drainableProfileFeedbackUsers: vi.fn(),
  absorbPendingProfileFeedback: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  ensureSchema: mocks.ensureSchema,
  drainableProfileFeedbackUsers: mocks.drainableProfileFeedbackUsers,
  getSql: vi.fn(() => { throw new Error('drain 测试不触达真实连接'); }),
}));
vi.mock('@/lib/profile-absorption', () => ({
  absorbPendingProfileFeedback: mocks.absorbPendingProfileFeedback,
}));

import { GET, maxDuration } from './route';

const SECRET = 'absorb-drain-test-secret';

function request(secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return new NextRequest('http://localhost/api/profile/absorb/drain', { headers });
}

describe('GET /api/profile/absorb/drain (F15 兜底 drain)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('LLM_TOTAL_TIMEOUT_MS', '260000');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.absorbPendingProfileFeedback.mockResolvedValue({ status: 'applied', pendingFeedbackId: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('R1：每日 cron 直接调用拥有 295s 预算的 drain 路由', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(config.crons).toContainEqual({ path: '/api/profile/absorb/drain', schedule: '30 21 * * *' });
    expect(maxDuration).toBe(295);
  });

  it('R2：两用户各需 200s 时只处理第一人，预算不足不领取第二人', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv('CRON_SECRET', SECRET);
    mocks.drainableProfileFeedbackUsers.mockResolvedValue([4, 5]);
    mocks.absorbPendingProfileFeedback.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 200_000);
      return { status: 'applied', pendingFeedbackId: null };
    });
    const res = await GET(request(SECRET));
    expect(await res.json()).toMatchObject({
      ok: true, drained: 1, stoppedForBudget: true,
      results: [{ userId: 4, status: 'applied' }],
    });
    expect(mocks.absorbPendingProfileFeedback).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(200_000);
  });

  it('R2：初始化耗时也扣宿主预算，余量不足不领取用户', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv('CRON_SECRET', SECRET);
    mocks.ensureSchema.mockImplementation(async () => { vi.setSystemTime(280_000); });
    mocks.drainableProfileFeedbackUsers.mockResolvedValue([4]);
    const res = await GET(request(SECRET));
    expect(await res.json()).toMatchObject({ drained: 0, stoppedForBudget: true });
    expect(mocks.absorbPendingProfileFeedback).not.toHaveBeenCalled();
  });

  it('未配置 CRON_SECRET 时 fail closed，不触达数据库', async () => {
    const res = await GET(request('anything'));
    expect(res.status).toBe(403);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
  });

  it('拒绝错误 secret，不扫描队列', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const res = await GET(request('wrong-secret'));
    expect(res.status).toBe(403);
    expect(mocks.drainableProfileFeedbackUsers).not.toHaveBeenCalled();
  });

  it('正确 secret：扫描 drain 候选并对每个用户走同一条吸收路径', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    mocks.drainableProfileFeedbackUsers.mockResolvedValue([4, 5]);

    const res = await GET(request(SECRET));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, drained: 2 });
    expect(mocks.absorbPendingProfileFeedback).toHaveBeenCalledTimes(2);
    for (const call of mocks.absorbPendingProfileFeedback.mock.calls) {
      // 与浏览器触发同一条路径：leaseToken 非空，所有用户共享宿主 signal。
      expect(call[0]).toMatchObject({ userId: expect.any(Number) });
      expect(typeof call[0].leaseToken).toBe('string');
      expect(call[0].leaseToken.length).toBeGreaterThan(0);
      expect(call[0].modelBudgetMs).toBeGreaterThan(0);
    }
    expect(mocks.absorbPendingProfileFeedback.mock.calls.map((c) => c[0].userId)).toEqual([4, 5]);
    expect(mocks.absorbPendingProfileFeedback.mock.calls[0][0].signal)
      .toBe(mocks.absorbPendingProfileFeedback.mock.calls[1][0].signal);
  });

  it('无候选时 drained=0，不调吸收路径', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    mocks.drainableProfileFeedbackUsers.mockResolvedValue([]);

    const res = await GET(request(SECRET));

    expect(await res.json()).toMatchObject({ ok: true, drained: 0 });
    expect(mocks.absorbPendingProfileFeedback).not.toHaveBeenCalled();
  });

  it('单用户失败不拖垮批次：记为 failed 并继续下一个用户', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    mocks.drainableProfileFeedbackUsers.mockResolvedValue([4, 5]);
    mocks.absorbPendingProfileFeedback
      .mockRejectedValueOnce(Object.assign(new Error('synthetic timeout'), { name: 'DeadlineExceededError' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request(SECRET));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      drained: 2,
      results: [{ userId: 4, status: 'failed' }, { userId: 5, status: 'applied' }],
    });
  });

  it('扫描失败返回受控 500，不回显错误原文', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    mocks.drainableProfileFeedbackUsers.mockRejectedValue(new Error('postgres://secret.invalid/db 连接失败'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request(SECRET));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'db error', code: 'DB_ERROR' });
    expect(JSON.stringify(body)).not.toContain('postgres://');
    expect(JSON.stringify(body)).not.toContain('secret.invalid');
  });
});
