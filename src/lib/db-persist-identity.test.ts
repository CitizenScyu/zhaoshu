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

// P2-4 批量改写后身份值整体 JSON 化进 jsonb_to_recordset 参数；
// 归一断言改为解析 JSON 后核对（判别力等价：脏值仍在参数文本里可见）。
const batchRows = (query: { text: string; values: unknown[] }) =>
  JSON.parse(String(query.values.find((value) => String(value).startsWith('[')))) as { title: string; author: string }[];

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

  it('经 db.ts 写库时，批量参数里的仍是归一后的 title/author', async () => {
    const { persistRecommendationsForUser } = await import('./db');
    await persistRecommendationsForUser(1, '找书', [{
      title: '《修真聊天群》', author: 'ＡＢＣ', category: '', wordCount: '',
      matchScore: 1, hitLikes: [], risks: '', reason: '',
    }] as never, write);

    const bookInsert = recordedQueries().find((q) => q.text.includes('INSERT INTO books'))!;
    expect(bookInsert.values).toHaveLength(1); // 批量形态：单个 jsonb 参数
    expect(batchRows(bookInsert)[0]).toMatchObject({ title: '修真聊天群', author: 'abc' });
    expect(bookInsert.values[0]).not.toContain('《修真聊天群》');
    expect(bookInsert.values[0]).not.toContain('ＡＢＣ');
  });

  it('全角冒号经整条链路也落到半角身份', async () => {
    const { persistRecommendationsForUser } = await import('./db');
    await persistRecommendationsForUser(1, 'q', [{
      title: '修真聊天群：', author: 'Ｘ', category: '', wordCount: '',
      matchScore: 1, hitLikes: [], risks: '', reason: '',
    }] as never, write);
    expect(batchRows(recordedQueries().find((q) => q.text.includes('INSERT INTO books'))!)[0].title).toBe('修真聊天群:');
  });
});
