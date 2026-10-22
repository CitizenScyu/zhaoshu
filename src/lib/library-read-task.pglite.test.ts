import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import { createProductionSchema } from '@/lib/fixtures/production-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';

// readerlocal42 修订（2026-10-22）：findDoneReadTask 的身份归一两侧此前不对称——
// SQL 侧只 lower(btrim(dt.title))，JS 侧传 normalizeBookTitle（NFKC + 剥《》）；
// 作者侧 JS 空值 '' vs SQL COALESCE '佚名' 恒不等 ⇒ 提示条对这类行静默失效。
// 本文件在真 PG（PGlite）上钉住修复后的口径：
//   - SQL 侧内联 0002 权威键生成式（normalize(x, NFKC) + 剥一层《》）；
//   - JS 侧同一归一函数 + 空作者映射 '佚名'（与 user-data booksReadTask 逐字一致）。
// route.donehint.test.ts 把 findDoneReadTask 整个 mock 掉，测不出这类分叉，故独立成文件。

const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn() }));
vi.mock('@/lib/db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('findDoneReadTask：两侧归一同口径', () => {
  let pg: PGliteLike;
  let mod: typeof import('./library-read-task');

  beforeAll(async () => {
    pg = new PGliteCtor!();
    const sql = createPGliteSql(pg as never);
    // 生产 schema 同源（含 0002 身份键迁移）：download_tasks 无 title_key 生成列，
    // 实现必须内联权威键表达式——建表走 production-schema，不手抄。
    await createProductionSchema(sql as never, (statement) => pg.exec(statement));
    mod = await import('./library-read-task');
  }, 60_000);

  async function seedTask(id: number, title: string, author: string | null) {
    // download_tasks.author 是 NOT NULL，所以「空作者」以空串形态入库（生产 download_tasks
    // 的空作者即空串，NULLIF(...,'') 兜 '佚名' 正是为它设的）。
    const book = (await pg.query(
      `INSERT INTO labeled_books (title, author, source_url) VALUES ($1, COALESCE($2, '佚名'), 'https://example.invalid/t')
       ON CONFLICT (title_key, author_key) DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [title, author ?? '佚名'],
    )).rows[0] as { id: number };
    await pg.query(
      `INSERT INTO download_tasks (id, book_id, title, author, status, requested_by, enqueue_key, policy_version)
       VALUES ($1, $2, $3, $4, 'done', 'system', $5, 'v1')`,
      [id, book.id, title, author ?? '', `key-${id}`],
    );
  }

  it('回归：裸标题+非空作者（旧式能匹配的）修复后仍匹配', async () => {
    await pg.exec('DELETE FROM download_tasks');
    await seedTask(101, '剑来', '烽火戏诸侯');
    mocks.getSql.mockReturnValue(createPGliteSql(pg as never));
    await expect(mod.findDoneReadTask(true, '剑来', '烽火戏诸侯')).resolves.toBe(101);
  });

  it('《余生》入库、按「余生」查——NFKC/剥《》分叉修复后命中（旧式恒漏）', async () => {
    await pg.exec('DELETE FROM download_tasks');
    await seedTask(102, '《余生》', '作者甲');
    mocks.getSql.mockReturnValue(createPGliteSql(pg as never));
    await expect(mod.findDoneReadTask(true, '余生', '作者甲')).resolves.toBe(102);
  });

  it('全角书名（NFKC 折叠）两侧等价命中', async () => {
    await pg.exec('DELETE FROM download_tasks');
    await seedTask(103, 'ＡＢＣ', '作者乙');
    mocks.getSql.mockReturnValue(createPGliteSql(pg as never));
    // normalizeBookTitle('abc') === 'abc'；SQL 侧 NFKC 把 ＡＢＣ 折成 ABC 再 lower。
    await expect(mod.findDoneReadTask(true, 'abc', '作者乙')).resolves.toBe(103);
  });

  it('空作者行（NULL/空串）与空作者查询互相匹配：两侧都映射佚名', async () => {
    await pg.exec('DELETE FROM download_tasks');
    await seedTask(104, '无名之书', null);
    await seedTask(105, '无名之书', '');
    mocks.getSql.mockReturnValue(createPGliteSql(pg as never));
    // 取最新（id 最大）的空作者任务。
    await expect(mod.findDoneReadTask(true, '无名之书', '')).resolves.toBe(105);
  });

  it('空作者行不误吞非空作者查询：作者不同不匹配', async () => {
    await pg.exec('DELETE FROM download_tasks');
    await seedTask(106, '无名之书', null);
    mocks.getSql.mockReturnValue(createPGliteSql(pg as never));
    await expect(mod.findDoneReadTask(true, '无名之书', '某作者')).resolves.toBe(null);
  });

  it('非空作者不误匹配他人：同名不同作者不命中', async () => {
    await pg.exec('DELETE FROM download_tasks');
    await seedTask(107, '剑来', '烽火戏诸侯');
    mocks.getSql.mockReturnValue(createPGliteSql(pg as never));
    await expect(mod.findDoneReadTask(true, '剑来', '别人')).resolves.toBe(null);
  });

  it('canRead=false 直接返回 null，不打库', async () => {
    mocks.getSql.mockClear();
    await expect(mod.findDoneReadTask(false, '剑来', '烽火戏诸侯')).resolves.toBe(null);
    expect(mocks.getSql).not.toHaveBeenCalled();
  });
});
