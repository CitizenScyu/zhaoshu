import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ neon: vi.fn(), sql: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));

const version = '2026-09-15 00:00:00.123456+00';
const nextVersion = '2026-09-15 00:00:00.123457+00';
const seeds = [{ title: '测试书', kind: 'love' }];

describe('profile database version contract (mocked HTTP queries)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@database.invalid/test');
    mocks.neon.mockReturnValue(mocks.sql);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('reads the database text version without a Date round trip', async () => {
    mocks.sql.mockResolvedValue([{ seeds, content: '画像', updated_at: version }]);
    const { getProfile } = await import('./db');
    expect(await getProfile()).toEqual({ seeds, content: '画像', updatedAt: version });
    expect(mocks.sql.mock.calls[0][0].join('?')).toContain('updated_at::text AS updated_at');
  });

  it('compares the supplied version and returns the new version in the same atomic write', async () => {
    mocks.sql.mockResolvedValue([{ updated_at: nextVersion }]);
    const { saveProfile } = await import('./db');
    expect(await saveProfile(seeds, '修订', version)).toBe(nextVersion);
    expect(mocks.sql).toHaveBeenCalledOnce();
    const [parts, ...values] = mocks.sql.mock.calls[0];
    expect(values).toEqual([JSON.stringify(seeds), '修订', version]);
    expect(parts.join('?')).toMatch(/WHERE id = 1 AND updated_at::text = \?/);
    expect(parts.join('?')).toContain("GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')");
    expect(parts.join('?')).toContain('RETURNING updated_at::text AS updated_at');
  });

  it('reports a lost comparison without falling back to an unconditional write', async () => {
    mocks.sql.mockResolvedValue([]);
    const { saveProfile } = await import('./db');
    expect(await saveProfile(seeds, '旧稿', version)).toBeNull();
    expect(mocks.sql).toHaveBeenCalledOnce();
  });

  it('rejects an omitted version at both the type and runtime boundaries', async () => {
    const { saveProfile } = await import('./db');
    // @ts-expect-error 业务写入必须携带读取时的版本。
    await expect(saveProfile(seeds, '无版本稿')).rejects.toThrow('profile version is required');
    expect(mocks.neon).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('rejects an empty version %j without database access', async (expected) => {
    const { saveProfile } = await import('./db');
    await expect(saveProfile(seeds, '空版本稿', expected)).rejects.toThrow('profile version is required');
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
