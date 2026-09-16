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

  it('scopes profile reads to the required user id', async () => {
    mocks.sql.mockResolvedValue([{ seeds, content: '成员画像', updated_at: version }]);
    const { getProfileForUser } = await import('./db');
    expect(await getProfileForUser(7)).toEqual({ seeds, content: '成员画像', updatedAt: version });
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual([7]);
  });

  it('compares the supplied version and returns the new version in the same atomic write', async () => {
    mocks.sql.mockResolvedValue([{ updated_at: nextVersion }]);
    const { saveProfile } = await import('./db');
    expect(await saveProfile(seeds, '修订', version)).toBe(nextVersion);
    expect(mocks.sql).toHaveBeenCalledOnce();
    const [parts, ...values] = mocks.sql.mock.calls[0];
    expect(values).toEqual([JSON.stringify(seeds), '修订', 1, version]);
    expect(parts.join('?')).toMatch(/WHERE id = \? AND updated_at::text = \?/);
    expect(parts.join('?')).toContain("GREATEST(clock_timestamp(), profile.updated_at + interval '1 microsecond')");
    expect(parts.join('?')).toContain('RETURNING profile.updated_at::text AS updated_at');
    expect(parts.join('?')).toContain('FOR UPDATE');
    expect(parts.join('?')).toContain('INSERT INTO profile_seed_audit');
    expect(parts.join('?')).toContain('FROM previous, input, updated WHERE previous.seeds IS DISTINCT FROM input.seeds');
  });

  it('reports a lost comparison without falling back to an unconditional write', async () => {
    mocks.sql.mockResolvedValue([]);
    const { saveProfile } = await import('./db');
    expect(await saveProfile(seeds, '旧稿', version)).toBeNull();
    expect(mocks.sql).toHaveBeenCalledOnce();
  });

  it('compares both user id and version for isolated CAS writes', async () => {
    mocks.sql.mockResolvedValue([{ updated_at: nextVersion }]);
    const { saveProfileForUser } = await import('./db');
    expect(await saveProfileForUser(9, seeds, '成员修订', version)).toBe(nextVersion);
    const [parts, ...values] = mocks.sql.mock.calls[0];
    expect(values).toEqual([JSON.stringify(seeds), '成员修订', 9, version]);
    expect(parts.join('?')).toMatch(/WHERE id = \? AND updated_at::text = \?/);
  });

  it('keeps excluded books isolated by required user id', async () => {
    mocks.sql.mockResolvedValue([{ title: '同一本书', author: '同一作者' }]);
    const { getExcludedBookKeysForUser, getExcludedBookTitlesForUser } = await import('./db');
    await getExcludedBookKeysForUser(11);
    await getExcludedBookTitlesForUser(12);
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual([11]);
    expect(mocks.sql.mock.calls[1].slice(1)).toEqual([12]);
    expect(mocks.sql.mock.calls[0][0].join('?')).toContain('f.user_id = ?');
    expect(mocks.sql.mock.calls[1][0].join('?')).toContain('f.user_id = ?');
  });

  it('persists the same book and query independently for each user', async () => {
    const transaction = vi.fn().mockResolvedValue([]);
    mocks.sql.mockImplementation((queryParts: TemplateStringsArray, ...queryParams: unknown[]) => ({
      queryParts,
      queryParams,
    }));
    Object.assign(mocks.sql, { transaction });
    const item = {
      title: '隔离推荐', author: '测试作者', category: '玄幻', wordCount: 100,
      matchScore: 9, hitLikes: ['节奏快'], risks: '', reason: '符合偏好',
    };
    const { persistRecommendationsForUser } = await import('./db');
    await persistRecommendationsForUser(21, '同一查询', [item] as never);
    const queries = transaction.mock.calls[0][0] as { queryParts: TemplateStringsArray; queryParams: unknown[] }[];
    const recommendation = queries[1];
    expect(recommendation.queryParts.join('?')).toContain('ON CONFLICT (user_id, book_id, query)');
    expect(recommendation.queryParams).toContain(21);
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
