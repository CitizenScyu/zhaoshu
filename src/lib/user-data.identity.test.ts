import { describe, expect, it } from 'vitest';
import { mockSql } from './fixtures/mock-sql';
import {
  addShelfForUserQueries,
  feedbackForUserQueries,
  feedbackSnapshotForUserQuery,
  persistRecommendationsForUserQueries,
  shelfExistsForUserQuery,
} from './user-data';

// task-49 止血点的验收：凡经 user-data 的身份查询边界写进 books 的 title/author，
// 必须已经是归一值（NFKC + 剥外层《》 + btrim(U+0020) + 小写）。
// 这里断言的是**绑定到 SQL 的参数**，而不是"某处调用过归一函数"——
// 断言绑定值才能证明脏数据真的写不进去。

type Bound = { text: string; values: unknown[] };
const bound = (queries: unknown): Bound[] => queries as Bound[];

const ITEM = {
  title: '《修真聊天群》', author: 'ＡＢＣ', category: '', wordCount: '',
  matchScore: 1, hitLikes: [], risks: '', reason: '',
};

describe('persistRecommendationsForUserQueries（/api/find 写回路径）', () => {
  it('books 的 INSERT 绑定的是归一后的 title/author，不是原始拼写', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, '找书', [ITEM as never]));
    const bookInsert = queries.find((q) => q.text.includes('INSERT INTO books'))!;
    expect(bookInsert.values[0]).toBe('修真聊天群');
    expect(bookInsert.values[1]).toBe('abc');
    expect(bookInsert.values).not.toContain('《修真聊天群》');
    expect(bookInsert.values).not.toContain('ＡＢＣ');
  });

  it('recommendations 的第二条语句用同一份归一值回查，否则找不到刚写的那行', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, '找书', [ITEM as never]));
    const recommendation = queries.find((q) => q.text.includes('INSERT INTO recommendations'))!;
    expect(recommendation.text).toContain('lower(title) = lower(?)');
    expect(recommendation.values).toContain('修真聊天群');
    expect(recommendation.values).toContain('abc');
    expect(recommendation.values).not.toContain('《修真聊天群》');
    expect(recommendation.values).not.toContain('ＡＢＣ');
  });

  it('全角冒号与书名号变体写进同一个身份', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, 'q', [
      { ...ITEM, title: '修真聊天群：', author: 'Ｘ' } as never,
    ]));
    expect(queries.find((q) => q.text.includes('INSERT INTO books'))!.values[0]).toBe('修真聊天群:');
  });
});

describe('addShelfForUserQueries / shelfExistsForUserQuery（/api/shelf 路径）', () => {
  it('加入书架时绑定归一值', () => {
    const db = mockSql();
    const [bookInsert, recommendationInsert] = bound(addShelfForUserQueries(db.sql, 7, '《修真聊天群》', 'ＡＢＣ'));
    expect(bookInsert.values[0]).toBe('修真聊天群');
    expect(bookInsert.values[1]).toBe('abc');
    expect(recommendationInsert.values).toContain('修真聊天群');
    expect(recommendationInsert.values).not.toContain('《修真聊天群》');
  });

  it('查重与写入用同一个函数，否则会重复入架', () => {
    const db = mockSql();
    const [exists] = bound([shelfExistsForUserQuery(db.sql, 7, '《修真聊天群》', 'ＡＢＣ')]);
    expect(exists.values).toContain('修真聊天群');
    expect(exists.values).toContain('abc');
  });
});

describe('feedback 写查两侧同一身份', () => {
  it('feedbackForUserQueries 五条语句全部绑定归一值', () => {
    const db = mockSql();
    const queries = bound(feedbackForUserQueries(db.sql, 3, { title: '《修真聊天群》', author: 'ＡＢＣ' }, 'want', 'n', 0));
    expect(queries).toHaveLength(5);
    for (const query of queries) {
      expect(query.values).toContain('修真聊天群');
      expect(query.values).toContain('abc');
      expect(query.values).not.toContain('《修真聊天群》');
      expect(query.values).not.toContain('ＡＢＣ');
    }
  });

  it('feedbackSnapshotForUserQuery 也绑定归一值，GET 不会读成"无反馈"', () => {
    const db = mockSql();
    const [snapshot] = bound([feedbackSnapshotForUserQuery(db.sql, 3, '《修真聊天群》', 'ＡＢＣ')]);
    expect(snapshot.values).toContain('修真聊天群');
    expect(snapshot.values).toContain('abc');
  });

  it('回归护栏：客户端传原始拼写、库里存归一值 —— 两侧仍是同一个键', () => {
    const db = mockSql();
    // find 回传的是召回阶段原始拼写（ＡＢＣ/《…》），写库时归一；
    // 反馈按原始拼写回查，必须落到同一身份，否则 404。
    const written = bound(persistRecommendationsForUserQueries(db.sql, 1, 'q', [ITEM as never]));
    const read = bound(feedbackForUserQueries(db.sql, 1, { title: ITEM.title, author: ITEM.author }, 'done', 'n', 0));
    const writtenTitle = written.find((q) => q.text.includes('INSERT INTO books'))!.values[0];
    // 两侧都必须落在归一值上（不写成 writtenTitle === read 值，否则摘掉归一也成立）
    expect(writtenTitle).toBe('修真聊天群');
    expect(read[0].values).toContain('修真聊天群');
    expect(read[0].values).not.toContain('《修真聊天群》');
  });
});
