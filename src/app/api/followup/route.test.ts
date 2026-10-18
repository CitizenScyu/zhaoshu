// zhuigeng42：追更轮路由的鉴权闸。
//
// 整轮逻辑不在这里验（真库行为在 lib/followup.pglite.test.ts）。这里只钉一件事：
// **没有 CRON_SECRET 就绝不放行**，且未授权请求连库都不碰。追更轮会按书架上的书去探测上游，
// 漏掉这道闸等于让任何人都能借它驱动外部请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { runFollowupRound } = vi.hoisted(() => ({ runFollowupRound: vi.fn() }));

vi.mock('@/lib/followup', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/followup')>(), runFollowupRound,
}));

import { POST, maxDuration } from './route';
import { FOLLOWUP_ROUND_BUDGET_MS } from '@/lib/followup';

const SECRET = 'followup-round-test-secret';

function request(secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return new NextRequest('http://localhost/api/followup', { method: 'POST', headers });
}

describe('POST /api/followup（追更轮）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runFollowupRound.mockResolvedValue({ candidates: 1, probed: 1, enqueued: 1, rebased: 0, failed: 0, items: [], elapsedMs: 12 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('maxDuration 覆盖整轮预算（systemd timer 那一侧同样照此预算）', () => {
    expect(FOLLOWUP_ROUND_BUDGET_MS).toBeLessThan(maxDuration * 1000);
  });

  it('未配置 CRON_SECRET 时 fail closed（带对得上的头也一样）', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await POST(request('anything'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', code: 'FORBIDDEN' });
    expect(runFollowupRound).not.toHaveBeenCalled();
  });

  it.each([
    ['错误 secret', 'wrong-secret'],
    ['缺 Authorization 头', undefined],
    ['同长度错误 secret', 'x'.repeat(SECRET.length)],
    ['非 Bearer 前缀', null],
  ] as const)('%s ⇒ 403，整轮不启动', async (_label, secret) => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const res = await POST(secret === null
      ? new NextRequest('http://localhost/api/followup', { method: 'POST', headers: { Authorization: SECRET } })
      : request(secret));
    expect(res.status).toBe(403);
    expect(runFollowupRound).not.toHaveBeenCalled();
  });

  it('secret 对得上 ⇒ 原样回整轮报告，并把请求信号传进去', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const req = request(SECRET);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 1, candidates: 1 });
    expect(runFollowupRound).toHaveBeenCalledWith(req.signal);
  });

  it('整轮抛错 ⇒ 502 + 固定文案，不把上游错误原文回给调用方', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    runFollowupRound.mockRejectedValue(new Error('source https://upstream.example exploded'));
    const res = await POST(request(SECRET));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: '追更轮失败', code: 'FOLLOWUP_FAILED' });
    expect(JSON.stringify(body)).not.toContain('upstream.example');
  });

  it('拿不到租约（skipped）不是错误，照常 200 回给 timer', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    runFollowupRound.mockResolvedValue({ skipped: 'lease', candidates: 0, probed: 0, enqueued: 0, rebased: 0, failed: 0, items: [], elapsedMs: 3 });
    const res = await POST(request(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'lease' });
  });
});
