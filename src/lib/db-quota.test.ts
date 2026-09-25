import { afterEach, describe, expect, it } from 'vitest';
import { neon, neonConfig, NeonDbError } from '@neondatabase/serverless';
import {
  createDbQuotaLatch, DB_QUOTA_ERROR_CODE, DB_QUOTA_HEALTH_ROW, DbQuotaExceededError,
  dbQuotaBackoffMs, DEFAULT_DB_QUOTA_BACKOFF_MS, isDbQuotaError, recordDbQuotaSeen,
} from './db-quota';

// 生产 2026-09-25 实测的 402 响应体（dbquota-41-report §1.2；中间字段省略处按原样保留省略）。
const QUOTA_BODY = JSON.stringify({
  message: 'Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
  'neon:retryable': true,
});
// 假连接串：主机 .invalid 永不解析；fetch 由替身接管，不出网。
const FAKE_URL = 'postgresql://user:pass@db.example.invalid/neondb';

/** 让真驱动走一遍：替身 fetch 回指定状态与响应体，返回驱动实际抛出的错误。 */
async function driverError(status: number, body: string): Promise<unknown> {
  neonConfig.fetchFunction = async () => new Response(body, { status });
  try {
    await neon(FAKE_URL)`SELECT 1`;
  } catch (error) {
    return error;
  }
  throw new Error('driver did not throw');
}

describe('isDbQuotaError（用驱动真实错误形态）', () => {
  afterEach(() => { neonConfig.fetchFunction = undefined; });

  it('驱动对 402 抛 NeonDbError「Server error (HTTP status 402)」、无 code ⇒ 判为配额错误', async () => {
    const error = await driverError(402, QUOTA_BODY);
    expect(error).toBeInstanceOf(NeonDbError);
    expect((error as NeonDbError).code).toBeUndefined();
    expect((error as Error).message).toMatch(/^Server error \(HTTP status 402\): /);
    expect(isDbQuotaError(error)).toBe(true);
  });

  it('402 响应体不是 Neon 文案（如代理改写）也凭驱动措辞判中', async () => {
    expect(isDbQuotaError(await driverError(402, 'payment required'))).toBe(true);
  });

  it('其他服务端错误（500/503）、SQL 错误（400）不误判', async () => {
    expect(isDbQuotaError(await driverError(500, 'internal'))).toBe(false);
    expect(isDbQuotaError(await driverError(503, 'unavailable'))).toBe(false);
    const sqlError = await driverError(400, JSON.stringify({ message: 'relation "x" does not exist', code: '42P01' }));
    expect((sqlError as NeonDbError).code).toBe('42P01');
    expect(isDbQuotaError(sqlError)).toBe(false);
  });

  it('连不上库（fetch 抛错）不误判', async () => {
    neonConfig.fetchFunction = async () => { throw new TypeError('fetch failed'); };
    const error = await neon(FAKE_URL)`SELECT 1`.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(NeonDbError);
    expect(isDbQuotaError(error)).toBe(false);
  });

  it('pg 协议路径的 Neon 文案变体（compute time / data transfer quota）判中', () => {
    expect(isDbQuotaError(new Error('Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.'))).toBe(true);
    expect(isDbQuotaError(new Error('Your project has exceeded the data transfer quota.'))).toBe(true);
  });

  it('download-worker 吞成的 reason 文本（字符串）判中', async () => {
    const error = await driverError(402, QUOTA_BODY) as Error;
    expect(isDbQuotaError(error.message.slice(0, 4000))).toBe(true);
    expect(isDbQuotaError('publication_failed:unknown')).toBe(false);
  });

  it('沿 cause / sourceError 递归；DbQuotaExceededError 与 code 判中', async () => {
    const inner = await driverError(402, QUOTA_BODY);
    expect(isDbQuotaError(new Error('wrapped', { cause: inner }))).toBe(true);
    expect(isDbQuotaError({ sourceError: inner })).toBe(true);
    expect(isDbQuotaError(new DbQuotaExceededError())).toBe(true);
    expect(isDbQuotaError({ code: DB_QUOTA_ERROR_CODE })).toBe(true);
  });

  it('源站 HTTP 402 等其他措辞、空值不误判；环引用有界', () => {
    expect(isDbQuotaError('HTTP 402 Payment Required')).toBe(false);
    expect(isDbQuotaError(new Error('quota exceeded for upstream'))).toBe(false);
    expect(isDbQuotaError(null)).toBe(false);
    expect(isDbQuotaError(undefined)).toBe(false);
    expect(isDbQuotaError(402)).toBe(false);
    const loop: { message: string; cause?: unknown } = { message: 'x' };
    loop.cause = loop;
    expect(isDbQuotaError(loop)).toBe(false);
  });

  it('DbQuotaExceededError 对外只带固定短文案，原始驱动文本只在 cause', async () => {
    const inner = await driverError(402, QUOTA_BODY);
    const error = new DbQuotaExceededError({ cause: inner });
    expect(error.message).toBe('database quota exceeded');
    expect(error.message).not.toMatch(/Upgrade|HTTP status/);
    expect(error.cause).toBe(inner);
  });
});

describe('dbQuotaBackoffMs', () => {
  it('缺省 30 分钟；合法值生效；非法回落默认；夹到 [60s, 4h]', () => {
    expect(DEFAULT_DB_QUOTA_BACKOFF_MS).toBe(30 * 60_000);
    expect(dbQuotaBackoffMs({})).toBe(DEFAULT_DB_QUOTA_BACKOFF_MS);
    expect(dbQuotaBackoffMs({ DB_QUOTA_BACKOFF_MS: '3600000' })).toBe(3_600_000);
    expect(dbQuotaBackoffMs({ DB_QUOTA_BACKOFF_MS: 'abc' })).toBe(DEFAULT_DB_QUOTA_BACKOFF_MS);
    expect(dbQuotaBackoffMs({ DB_QUOTA_BACKOFF_MS: '-5' })).toBe(DEFAULT_DB_QUOTA_BACKOFF_MS);
    expect(dbQuotaBackoffMs({ DB_QUOTA_BACKOFF_MS: '1.5' })).toBe(DEFAULT_DB_QUOTA_BACKOFF_MS);
    expect(dbQuotaBackoffMs({ DB_QUOTA_BACKOFF_MS: '10' })).toBe(60_000);
    expect(dbQuotaBackoffMs({ DB_QUOTA_BACKOFF_MS: '999999999999' })).toBe(4 * 3_600_000);
  });
});

describe('createDbQuotaLatch', () => {
  it('note 进入冷却，到期自动恢复 ok；lastSeenAt 保留', () => {
    let t = Date.parse('2026-09-25T03:43:00.000Z');
    const latch = createDbQuotaLatch({ backoffMs: 1_800_000, now: () => t });
    expect(latch.status()).toEqual({ state: 'ok', lastSeenAt: null });
    expect(latch.note()).toBe(true);
    expect(latch.active()).toBe(true);
    expect(latch.remainingMs()).toBe(1_800_000);
    expect(latch.retryAt()).toBe('2026-09-25T04:13:00.000Z');
    expect(latch.status()).toEqual({ state: 'exceeded', lastSeenAt: '2026-09-25T03:43:00.000Z' });
    t += 1_800_000;
    expect(latch.active()).toBe(false);
    expect(latch.retryAt()).toBeNull();
    expect(latch.status()).toEqual({ state: 'ok', lastSeenAt: '2026-09-25T03:43:00.000Z' });
  });

  it('冷却中再 note 只延长、返回 false（调用方只打一行转入日志）', () => {
    let t = 0;
    const latch = createDbQuotaLatch({ backoffMs: 1000, now: () => t });
    expect(latch.note()).toBe(true);
    t = 500;
    expect(latch.note()).toBe(false);
    expect(latch.remainingMs()).toBe(1000);
  });

  it('recover 立即结束冷却；takeUnrecorded 取一次即清', () => {
    const latch = createDbQuotaLatch({ backoffMs: 1000, now: () => 5000 });
    latch.note();
    latch.recover();
    expect(latch.active()).toBe(false);
    expect(latch.takeUnrecorded()).toBe(new Date(5000).toISOString());
    expect(latch.takeUnrecorded()).toBeNull();
  });
});

describe('recordDbQuotaSeen', () => {
  it('upsert cron_health 的 db_quota_exceeded 行，GREATEST 防回拨', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('$'), values });
      return [];
    };
    await recordDbQuotaSeen(sql, '2026-09-25T03:43:00.000Z');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO cron_health/);
    expect(calls[0].text).toMatch(/GREATEST\(cron_health\.last_success_at, EXCLUDED\.last_success_at\)/);
    expect(calls[0].values).toEqual([DB_QUOTA_HEALTH_ROW, '2026-09-25T03:43:00.000Z']);
  });
});
