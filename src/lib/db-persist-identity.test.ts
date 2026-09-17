import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalWriter } from './personal-write';

// 止血点调用链的中间一段：find/route.ts → db.ts persistRecommendationsForUser →
// user-data.ts persistRecommendationsForUserQueries。
// 路由层由 find/route.test.ts 钉住（原样把 items 传给 persistRecommendationsForUser）；
// user-data 层由 user-data.identity.test.ts 钉住（绑定的已是归一值）；
// 这里补中间那段，证明 db.ts 这个 3 行透传不会把归一丢掉，链路无缺口。

const mocks = vi.hoisted(() => ({ neon: vi.fn(), sql: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));

// 与 db-profile.test.ts 同一套桩：db.ts 的写路径只关心被绑定的 SQL 参数。
const write: PersonalWriter = async (batch) =>
  await Promise.all(batch(mocks.sql as never)) as Record<string, unknown>[][];

const recordedQueries = () => mocks.sql.mock.calls.map(([parts, ...values]) => ({
  text: (parts as string[]).join('?'), values: values as unknown[],
}));

describe('db.ts persistRecommendationsForUser 透传不丢归一', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@database.invalid/test');
    mocks.neon.mockReturnValue(mocks.sql);
    mocks.sql.mockImplementation((parts: TemplateStringsArray, ...values: unknown[]) => ({
      parts, values,
    }));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('经 db.ts 写库时，绑定到 INSERT INTO books 的仍是归一后的 title/author', async () => {
    const { persistRecommendationsForUser } = await import('./db');
    await persistRecommendationsForUser(1, '找书', [{
      title: '《修真聊天群》', author: 'ＡＢＣ', category: '', wordCount: '',
      matchScore: 1, hitLikes: [], risks: '', reason: '',
    }] as never, write);

    const bookInsert = recordedQueries().find((q) => q.text.includes('INSERT INTO books'))!;
    expect(bookInsert.values[0]).toBe('修真聊天群');
    expect(bookInsert.values[1]).toBe('abc');
    expect(bookInsert.values).not.toContain('《修真聊天群》');
    expect(bookInsert.values).not.toContain('ＡＢＣ');
  });

  it('全角冒号经整条链路也落到半角身份', async () => {
    const { persistRecommendationsForUser } = await import('./db');
    await persistRecommendationsForUser(1, 'q', [{
      title: '修真聊天群：', author: 'Ｘ', category: '', wordCount: '',
      matchScore: 1, hitLikes: [], risks: '', reason: '',
    }] as never, write);
    expect(recordedQueries().find((q) => q.text.includes('INSERT INTO books'))!.values[0]).toBe('修真聊天群:');
  });
});
