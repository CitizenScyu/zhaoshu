import { describe, expect, it } from 'vitest';
import { mockSql } from './fixtures/mock-sql';
import {
  addShelfForUserQueries,
  excludedBooksForUserQuery,
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

// T57R-2（428C9 面）：title_key/author_key 是 STORED 生成列，显式往列清单里写值会被
// PostgreSQL 以 428C9（cannot insert a non-DEFAULT value into column）拒绝。身份键只允许
// 出现在 ON CONFLICT 冲突目标里；把 INSERT 的列清单单独取出来断言，才不会因为冲突目标
// 里合法地出现同一个词而误判。
const insertColumns = (text: string): string => /INSERT INTO books \(([^)]*)\)/.exec(text)?.[1] ?? '';

const ITEM = {
  title: '《修真聊天群》', author: 'ＡＢＣ', category: '', wordCount: '',
  matchScore: 1, hitLikes: [], risks: '', reason: '',
};

describe('persistRecommendationsForUserQueries（/api/find 写回路径）', () => {
  // P2-4 批量改写后语句恒为两条：[0] books 批量 upsert、[1] recommendations 批量落库。
  // 身份值不再逐条绑定，而是整体 JSON 化进 jsonb_to_recordset——归一断言改为解析该
  // JSON 参数后逐行核对，判别力与逐条绑定断言等价（脏值仍在参数里可见）。
  const batchRows = (query: Bound) => JSON.parse(String(query.values.find((v) => String(v).startsWith('[')))) as {
    title: string; author: string;
  }[];

  it('books 的批量 INSERT 绑定的是归一后的 title/author，不是原始拼写', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, '找书', [ITEM as never]));
    expect(queries).toHaveLength(2);
    const [rows, serialized] = [batchRows(queries[0]), JSON.stringify(queries[0].values)];
    expect(rows[0].title).toBe('修真聊天群');
    expect(rows[0].author).toBe('abc');
    expect(serialized).not.toContain('《修真聊天群》');
    expect(serialized).not.toContain('ＡＢＣ');
  });

  it('recommendations 的第二条语句用同一份归一值经身份键回查', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, '找书', [ITEM as never]));
    const recommendation = queries.find((q) => q.text.includes('INSERT INTO recommendations'))!;
    // 身份回查钉在生成列键上（与 books upsert 的冲突目标同一套键）；
    // 传参里的身份值必须是归一值。
    expect(recommendation.text).toContain('b.title_key = j.title AND b.author_key = j.author');
    const rows = batchRows(recommendation);
    expect(rows[0].title).toBe('修真聊天群');
    expect(rows[0].author).toBe('abc');
    expect(JSON.stringify(recommendation.values)).not.toContain('《修真聊天群》');
    expect(JSON.stringify(recommendation.values)).not.toContain('ＡＢＣ');
  });

  it('全角冒号与书名号变体写进同一个身份', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, 'q', [
      { ...ITEM, title: '修真聊天群：', author: 'Ｘ' } as never,
    ]));
    expect(batchRows(queries[0])[0].title).toBe('修真聊天群:');
  });

  // task-53 收口后的冲突目标护栏（T53R-6）：身份唯一索引已从表达式索引
  // (lower(title), lower(author)) 换成生成列 title_key/author_key。
  // 冲突目标与索引不一致时 PostgreSQL 报「no unique or exclusion constraint
  // matching」，但那要连真库才会暴露；单测里若不钉这段文本，改回旧表达式仍全绿。
  // 判别力：把 ON CONFLICT 目标改回 (lower(title), lower(author))，本用例必须失败。
  it('books 的 INSERT 冲突目标钉在生成列身份键 title_key/author_key 上', () => {
    const db = mockSql();
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, '找书', [ITEM as never]));
    const bookInsert = queries.find((q) => q.text.includes('INSERT INTO books'))!;
    expect(bookInsert.text).toContain('ON CONFLICT (title_key, author_key)');
    expect(bookInsert.text).not.toMatch(/ON CONFLICT\s*\(\s*lower\(/);
    // 同一处再钉 428C9 面：身份键不得进入 INSERT 的列清单（生成列不可显式写入）。
    expect(insertColumns(bookInsert.text)).not.toContain('title_key');
    expect(insertColumns(bookInsert.text)).not.toContain('author_key');
  });

  // P2-4 专属护栏：批量改写的意义就是语句数不随 N 膨胀（原 2N，现恒 2）。
  // 判别力：退回逐本 INSERT 时，10 本会渲染出 20 条语句，本用例必须失败。
  it('语句数恒为 2，不随本数膨胀（P2-4）', () => {
    const db = mockSql();
    const items = Array.from({ length: 10 }, (_, i) => ({ ...ITEM, title: `批量书${i}` }));
    const queries = bound(persistRecommendationsForUserQueries(db.sql, 1, '找书', items as never));
    expect(queries).toHaveLength(2);
    const rows = batchRows(queries[0]);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.title)).toEqual(items.map((item) => item.title));
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

  // 与 find 写回路径同一冲突目标：书架入口也不能写回旧表达式索引。
  it('加入书架的 books INSERT 用同一个冲突目标 title_key/author_key', () => {
    const db = mockSql();
    const [bookInsert] = bound(addShelfForUserQueries(db.sql, 7, '《修真聊天群》', 'ＡＢＣ'));
    expect(bookInsert.text).toContain('ON CONFLICT (title_key, author_key)');
    expect(bookInsert.text).not.toMatch(/ON CONFLICT\s*\(\s*lower\(/);
    // 同一处再钉 428C9 面：身份键不得进入 INSERT 的列清单（生成列不可显式写入）。
    expect(insertColumns(bookInsert.text)).not.toContain('title_key');
    expect(insertColumns(bookInsert.text)).not.toContain('author_key');
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
    const writtenRows = JSON.parse(String(written.find((q) => q.text.includes('INSERT INTO books'))!.values
      .find((value) => String(value).startsWith('[')))) as { title: string }[];
    // 两侧都必须落在归一值上（不写成 writtenTitle === read 值，否则摘掉归一也成立）
    expect(writtenRows[0].title).toBe('修真聊天群');
    expect(read[0].values).toContain('修真聊天群');
    expect(read[0].values).not.toContain('《修真聊天群》');
  });
});

// task-56 T56-1：召回排除集合要覆盖「已在书架的书」，否则同一本书会被每个 query 重推。
// 书架状态在 recommendations.status 上（'new' = find 自动落库、用户未处理；
// want/reading/done/dropped = 用户显式动作），books 表本身没有 user 归属。
describe('excludedBooksForUserQuery（召回排除集合）', () => {
  it('排除集合同时覆盖书架已有书与反馈记录', () => {
    const db = mockSql();
    const [query] = bound([excludedBooksForUserQuery(db.sql, 5)]);
    expect(query.text).toContain('FROM recommendations r');
    expect(query.text).toContain("r.status <> 'new'");
    expect(query.text).toContain('FROM feedback f');
    // 两条子查询各自限定到当前用户，且都绑定同一个 userId
    expect(query.text.match(/user_id = \?/g)).toHaveLength(2);
    expect(query.values).toEqual([5, 5]);
  });

  // 语义边界：仅出现在历史推荐里（status = 'new'）的书不排除，否则用户重搜同题材
  // 时这些书永远回不来，相似书也被整片屏蔽。判别力：把条件改成 `r.status = 'new'`、
  // 或去掉 `<>` 直接 EXISTS 任何 recommendation，本用例必须失败。
  it('不排除仅有历史推荐（status = new）的书', () => {
    const db = mockSql();
    const [query] = bound([excludedBooksForUserQuery(db.sql, 5)]);
    expect(query.text).not.toMatch(/status\s*=\s*'new'/);
    expect(query.text).not.toMatch(/r\.status\s+IN/);
    expect(query.text).toContain("r.status <> 'new'");
  });
});
