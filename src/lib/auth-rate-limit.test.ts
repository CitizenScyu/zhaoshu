import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  GLOBAL_RATE_LIMIT_KEY,
  LOGIN_SOURCE_RATE_LIMIT,
  bumpAuthRateLimit,
  decideRateLimit,
  peekAuthRateLimit,
  rateLimitKeyHash,
  requestSourceIdentifier,
} from './auth-rate-limit';

type Recorded = { text: string; values: unknown[] };

function fakeSql() {
  const calls: Recorded[] = [];
  const queued: unknown[][] = [];
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ''), '');
      calls.push({ text, values });
      return queued.length > 0 ? queued.shift() : [];
    },
    {
      transaction: async (builder: (tx: never) => unknown[]) => builder(sql as never),
    },
  );
  return { sql, calls, queued };
}

describe('atomic window counter', () => {
  it('increments atomically with an UPSERT computed on the database clock', async () => {
    const fake = fakeSql();
    fake.queued.push([{ attempts: 3, retry_after_seconds: 120 }]);
    const bump = await bumpAuthRateLimit(fake.sql as never, LOGIN_SOURCE_RATE_LIMIT, 'a'.repeat(64));
    const query = fake.calls[0];
    expect(bump).toEqual({ attempts: 3, retryAfterSeconds: 120 });
    expect(query.text).toContain('INSERT INTO auth_rate_limits');
    expect(query.text).toContain('ON CONFLICT (scope, key_hash, window_start)');
    expect(query.text).toContain('DO UPDATE SET attempts = auth_rate_limits.attempts + 1');
    // 窗口起点与到期都由数据库 now() 计算，跨实例共享同一窗口。
    expect(query.text).toContain('to_timestamp(floor(extract(epoch from now())');
    expect(query.values[0]).toBe(LOGIN_SOURCE_RATE_LIMIT.scope);
    expect(query.values[1]).toBe('a'.repeat(64));
  });

  it('reports zero attempts when the window has no row', async () => {
    const fake = fakeSql();
    const peek = await peekAuthRateLimit(fake.sql as never, LOGIN_SOURCE_RATE_LIMIT, 'b'.repeat(64));
    expect(peek).toEqual({ attempts: 0, retryAfterSeconds: 0 });
    expect(fake.calls[0].text).toContain('SELECT attempts');
  });

  it('reads the current window count without incrementing', async () => {
    const fake = fakeSql();
    fake.queued.push([{ attempts: 7, retry_after_seconds: 45 }]);
    const peek = await peekAuthRateLimit(fake.sql as never, LOGIN_SOURCE_RATE_LIMIT, 'b'.repeat(64));
    expect(peek).toEqual({ attempts: 7, retryAfterSeconds: 45 });
    expect(fake.calls[0].text).not.toContain('INSERT');
  });

  it('allows attempts up to the limit and reports a retry window beyond it', () => {
    expect(decideRateLimit({ attempts: 20, retryAfterSeconds: 0 }, 20)).toEqual({ allowed: true });
    expect(decideRateLimit({ attempts: 21, retryAfterSeconds: 137 }, 20)).toEqual({ allowed: false, retryAfterSeconds: 137 });
    expect(decideRateLimit({ attempts: 1, retryAfterSeconds: 599 }, 100)).toEqual({ allowed: true });
  });

  it('throws instead of guessing when the upsert returns nothing', async () => {
    const fake = fakeSql();
    fake.queued.push([]);
    await expect(bumpAuthRateLimit(fake.sql as never, LOGIN_SOURCE_RATE_LIMIT, 'c'.repeat(64))).rejects.toThrow('no row');
  });
});

describe('rate limit keys and source identifiers', () => {
  it('derives scoped HMAC keys that never store raw identifiers', () => {
    const secret = 'x'.repeat(32);
    const key = rateLimitKeyHash(secret, 'login-source', '203.0.113.9');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(rateLimitKeyHash(secret, 'login-source', '203.0.113.9')).toBe(key);
    expect(rateLimitKeyHash(secret, 'login-user', '203.0.113.9')).not.toBe(key);
    expect(rateLimitKeyHash('y'.repeat(32), 'login-source', '203.0.113.9')).not.toBe(key);
    expect(GLOBAL_RATE_LIMIT_KEY).toBe('all');
  });

  it('uses the platform-appended hop of X-Forwarded-For, not the client-controlled left side', () => {
    const request = (headers: Record<string, string>) =>
      new NextRequest('http://localhost/api/auth/login', { method: 'POST', headers });
    expect(requestSourceIdentifier(request({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(requestSourceIdentifier(request({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(requestSourceIdentifier(request({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
    expect(requestSourceIdentifier(request({}))).toBe('unknown');
  });
});
