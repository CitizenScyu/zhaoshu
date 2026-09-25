import { afterEach, describe, expect, it, vi } from 'vitest';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createDbQuotaLatch, DB_QUOTA_ERROR_CODE, type DbQuotaLatch } from './db-quota';
import { createQuotaAwareFetch, dbQuotaResponse, requestHitDbQuota, withDbQuotaGuard } from './db-quota-guard';

// 41-q402fix：Vercel 侧配额闸。全部经真驱动（neonConfig.fetchFunction = 配额感知 fetch，底层 fetch 用替身，
// 主机 .invalid 不出网），断言的是「驱动实际抛什么、路由实际回什么」。

const FAKE_URL = 'postgresql://user:pass@db.example.invalid/neondb';
const QUOTA_BODY = JSON.stringify({
  message: 'Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
  'neon:retryable': true,
});
const okBody = JSON.stringify({ fields: [{ name: 'n', dataTypeID: 23 }], rows: [['1']], command: 'SELECT', rowCount: 1 });

function setup(status: () => number) {
  let t = Date.parse('2026-09-25T03:43:00.000Z');
  const latch: DbQuotaLatch = createDbQuotaLatch({ backoffMs: 30 * 60_000, now: () => t });
  const base = vi.fn(async () => {
    const s = status();
    return new Response(s === 200 ? okBody : QUOTA_BODY, { status: s });
  });
  neonConfig.fetchFunction = createQuotaAwareFetch(latch, base);
  const sql = neon(FAKE_URL);
  return { latch, base, sql, advance: (ms: number) => { t += ms; } };
}

afterEach(() => {
  neonConfig.fetchFunction = undefined;
  vi.restoreAllMocks();
});

describe('createQuotaAwareFetch（请求咽喉）', () => {
  it('真 402 ⇒ 布置冷却、只打一行结构化日志；冷却期内不再发网络请求，驱动照常抛 402', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    await expect(h.sql`SELECT 1`).rejects.toThrow(/HTTP status 402/);
    expect(h.latch.active()).toBe(true);
    for (let i = 0; i < 5; i += 1) await expect(h.sql`SELECT 1`).rejects.toThrow(/HTTP status 402/);
    expect(h.base).toHaveBeenCalledTimes(1); // 后 5 次都在本地合成，未碰 Neon
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(['db quota exceeded', {
      event: 'db_quota_exceeded', component: 'vercel', retryAt: '2026-09-25T04:13:00.000Z',
    }]);
  });

  it('本地合成的 402 不含上游文本', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    await h.sql`SELECT 1`.catch(() => {});
    const error = await h.sql`SELECT 1`.then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toMatch(/HTTP status 402/);
    expect(error?.message).not.toMatch(/Upgrade/);
  });

  it('冷却到期后再试；成功即恢复正常（不再合成）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let status = 402;
    const h = setup(() => status);
    await h.sql`SELECT 1`.catch(() => {});
    h.advance(30 * 60_000);
    status = 200;
    await expect(h.sql`SELECT 1`).resolves.toEqual([{ n: 1 }]);
    expect(h.latch.active()).toBe(false);
    await h.sql`SELECT 1`;
    expect(h.base).toHaveBeenCalledTimes(3);
    expect(h.latch.status().lastSeenAt).toBe('2026-09-25T03:43:00.000Z');
  });

  it('其他错误状态（500）不布置冷却', async () => {
    const h = setup(() => 500);
    await expect(h.sql`SELECT 1`).rejects.toThrow(/HTTP status 500/);
    expect(h.latch.active()).toBe(false);
  });
});

describe('withDbQuotaGuard（响应咽喉）', () => {
  async function json(res: Response) { return await res.json() as Record<string, unknown>; }

  it('路由自己 catch 成 500 INTERNAL ⇒ 改回 503 DB_QUOTA_EXCEEDED + Retry-After，不带驱动原文', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    const handler = withDbQuotaGuard(async () => {
      try {
        await h.sql`SELECT 1`;
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error), code: 'INTERNAL' }, { status: 500 });
      }
    });
    const res = await handler();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const payload = await json(res);
    expect(payload.code).toBe(DB_QUOTA_ERROR_CODE);
    expect(JSON.stringify(payload)).not.toMatch(/Upgrade|HTTP status|NeonDbError/);
  });

  it('处理器未 catch、直接抛配额错误 ⇒ 503（不是 Next 默认 500）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    const handler = withDbQuotaGuard(async () => { await h.sql`SELECT 1`; return Response.json({}); });
    const res = await handler();
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe(DB_QUOTA_ERROR_CODE);
  });

  it('路由回业务 503（如 AUTH/STATS 不可用）也统一成配额码', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    const handler = withDbQuotaGuard(async () => {
      await h.sql`SELECT 1`.catch(() => {});
      return Response.json({ code: 'STATS_UNAVAILABLE' }, { status: 503 });
    });
    expect((await json(await handler())).code).toBe(DB_QUOTA_ERROR_CODE);
  });

  it('撞过配额但路由降级回 200 / 4xx ⇒ 原样放行', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    const degraded = withDbQuotaGuard(async () => {
      await h.sql`SELECT 1`.catch(() => {});
      return Response.json({ ok: false }, { status: 200 });
    });
    expect((await degraded()).status).toBe(200);
    const unauthorized = withDbQuotaGuard(async () => {
      await h.sql`SELECT 1`.catch(() => {});
      return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    });
    expect((await unauthorized()).status).toBe(401);
  });

  it('没撞配额的 500 与普通异常原样透传', async () => {
    const h = setup(() => 500);
    const failing = withDbQuotaGuard(async () => {
      await h.sql`SELECT 1`.catch(() => {});
      return Response.json({ code: 'INTERNAL' }, { status: 500 });
    });
    expect((await failing()).status).toBe(500);
    const throwing = withDbQuotaGuard(async () => { throw new Error('boom'); });
    await expect(throwing()).rejects.toThrow('boom');
  });

  it('请求作用域互不串：并发的另一请求没撞配额就不受影响；作用域外恒 false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = setup(() => 402);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clean = withDbQuotaGuard(async () => {
      await gate;
      return Response.json({ hit: requestHitDbQuota() }, { status: 500 });
    });
    const hitting = withDbQuotaGuard(async () => {
      await h.sql`SELECT 1`.catch(() => {});
      release();
      return Response.json({}, { status: 500 });
    });
    const [a, b] = await Promise.all([clean(), hitting()]);
    expect(a.status).toBe(500);
    expect(await json(a)).toEqual({ hit: false });
    expect(b.status).toBe(503);
    expect(requestHitDbQuota()).toBe(false);
  });

  it('透传处理器参数（Next 的 req 与 context）', async () => {
    const seen: unknown[] = [];
    const handler = withDbQuotaGuard(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
      seen.push(req.url, (await ctx.params).id);
      return new Response(null, { status: 204 });
    });
    const res = await handler(new Request('https://app.example/a'), { params: Promise.resolve({ id: '7' }) });
    expect(res.status).toBe(204);
    expect(seen).toEqual(['https://app.example/a', '7']);
  });
});

describe('dbQuotaResponse', () => {
  it('Retry-After = 冷却剩余秒数（至少 60）', async () => {
    const latch = createDbQuotaLatch({ backoffMs: 30 * 60_000, now: () => 0 });
    latch.note();
    expect(dbQuotaResponse(latch).headers.get('Retry-After')).toBe('1800');
    expect(dbQuotaResponse(createDbQuotaLatch()).headers.get('Retry-After')).toBe('60');
  });
});
