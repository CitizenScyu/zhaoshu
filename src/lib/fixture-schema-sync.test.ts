// 夹具必须与生产 schema **同构**：一致性门禁。
//
// 2026-09-23 复核：三处 fixture 手抄生产 DDL 且已漂移——
//   ① title_key 生成式少了 0002 迁移里剥《》那一层 regexp_replace，
//      《余生》与「余生」**在测试里匹配不上、在生产里匹配得上**（漏匹配回归系统性隐形）；
//   ② users 被建成单列、labeled_books 无身份键，权限位与身份冲突两类回归不可见。
//
// 本文件是这两条的守卫。判别力：把 fixtures/production-schema.ts 改回手抄 DDL、或从
// 夹具里去掉 0002 / users 的生产结构，下面的用例会红——它断言的是**真库里的结构**，
// 不是源码里有没有那段字。

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import {
  authVersions, createArtifactSchema, createProductionSchema, createProductionSchemaAtAuthV6,
  identityKeyMigrationSql, tableFingerprint, upgradeToAuthV7,
} from './fixtures/production-schema';
import { canonicalBookKey, normalizeBookAuthor, normalizeBookTitle } from './book-identity';
import { exactLibraryBooksForUserQuery } from './user-data';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('测试夹具与生产 schema 同构（title_key / users 权限位 / 身份键）', () => {
  let pg: PGliteLike;


  // 查一列的集合 / 查询索引名集合。PGlite 的 rows 是 Record<string, unknown>，取字段用断言收窄。
  async function columnsOf(table: string): Promise<Set<string>> {
    const rows = (await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table],
    )).rows as { column_name: string }[];
    return new Set(rows.map(row => row.column_name));
  }
  async function indexesOf(table: string): Promise<Set<string>> {
    const rows = (await pg.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1`, [table],
    )).rows as { indexname: string }[];
    return new Set(rows.map(row => row.indexname));
  }
  async function queryRows<T>(text: string, params?: unknown[]): Promise<T[]> {
    return (await pg.query(text, params)).rows as T[];
  }

  function sqlTag() {
    return createPGliteSql(pg);
  }

  describe('件1：title_key 生成式含剥《》那一层', () => {
    beforeEach(async () => {
      pg = new PGliteCtor!();
      await createProductionSchema(sqlTag() as never, statement => pg.exec(statement));
    }, 120_000);

    it('《余生》与「余生」在 fixture 库里折叠成同一个 title_key', async () => {
      await pg.query(`INSERT INTO labeled_books(title, author) VALUES ('《余生》', '佚名')`);
      const [styled] = (await pg.query(`SELECT title_key FROM labeled_books WHERE title = '《余生》'`)).rows as { title_key: string }[];
      expect(styled.title_key).toBe('余生');
    }, 60_000);

    it('带书名号的写入被 labeled_books_identity_idx 归一后与裸书名撞同一身份键（生产语义）', async () => {
      // 这正是漂移让回归隐形的形状：生产里两行不可能并存（同一身份键），
      // 而缺了剥《》的旧 fixture 里它们能并存、且相互查不到。
      await pg.query(`INSERT INTO labeled_books(title, author) VALUES ('《余生》', '佚名')`);
      await expect(pg.query(`INSERT INTO labeled_books(title, author) VALUES ('余生', '佚名')`))
        .rejects.toMatchObject({ code: '23505' });
      const found = (await pg.query(
        `SELECT id FROM labeled_books WHERE title_key = '余生' AND author_key = '佚名'`)).rows;
      expect(found).toHaveLength(1);
    }, 60_000);

    it('生成式与生产定义一致：库算出的键等于 book-identity 对同一输入的键', async () => {
      // 不再读 pg_attribute.generation_expression（PGlite 不暴露该列）：直接用**真库算出的
      // 键**与应用侧权威实现（book-identity）逐字比对。
      const cases: [string, string][] = [
        ['《余生》', '余生'],
        ['《 余生 》', '余生'],            // 剥书名号后暴露的内侧空格由第二次 btrim 收掉
        ['《《红楼梦》研究》', '《红楼梦》研究'],
        ['　修真聊天群　', '修真聊天群'],   // U+3000 先被 NFKC 折成 U+0020
        ['ＡＢＣ', 'abc'],
        ['《》', '《》'],                 // PG 的 (.+) 要求至少 1 个字符，空书名号不动
      ];
      for (const [input, expected] of cases) {
        await pg.query(`DELETE FROM labeled_books`);
        await pg.query(`INSERT INTO labeled_books(title, author) VALUES ($1, '佚名')`, [input]);
        const row = (await pg.query(`SELECT title_key FROM labeled_books`)).rows[0] as { title_key: string };
        expect(row.title_key, `库键与预期不符：${input}`).toBe(expected);
        expect(row.title_key, `库键与应用侧键分叉：${input}`).toBe(normalizeBookTitle(input));
      }
    }, 60_000);

    it('同构的库键与应用侧键（book-identity）对同一输入给同一个值', async () => {
      await pg.query(`INSERT INTO labeled_books(title, author) VALUES ('《余 生》', 'ＡＢＣ')`);
      const row = (await pg.query(`SELECT title_key, author_key FROM labeled_books`)).rows[0] as { title_key: string; author_key: string };
      expect(row.title_key).toBe(normalizeBookTitle('《余 生》'));
      expect(row.author_key).toBe(normalizeBookAuthor('ＡＢＣ'));
      expect(row.title_key).not.toBe('《余 生》'.toLowerCase());
      expect(`${row.title_key}\u0000${row.author_key}`).toBe(canonicalBookKey('《余 生》', 'ＡＢＣ'));
    }, 60_000);

    it('精确匹配查询按同一只键命中：库里存《余生》也能被裸书名查到', async () => {
      await pg.query(
        `INSERT INTO labeled_books(id, title, author, source_url, chars_labeled)
         VALUES (1, '《余生》', '佚名', 'https://book15.net/books/1.html', 400000)`);
      const hits = exactLibraryBooksForUserQuery(sqlTag() as never, 1, '余生', '佚名') as unknown as Promise<{
        metadata_source: string; id: number; title: string; author_match: boolean;
      }[]>;
      const rows = await hits;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ metadata_source: 'labeled_books', id: 1, title: '《余生》', author_match: true });
    }, 60_000);
  });

  describe('件2：users 有权限位与身份 CHECK，labeled_books 有身份键', () => {
    beforeEach(async () => {
      pg = new PGliteCtor!();
      await createProductionSchema(sqlTag() as never, statement => pg.exec(statement));
    }, 120_000);

    it('users 是生产全列（不是 users(id)），owner 行是固定身份', async () => {
      const columns = await columnsOf('users');
      for (const column of ['id', 'username', 'password_hash', 'role', 'can_find', 'can_read', 'can_download', 'disabled_at']) {
        expect(columns, `users 缺少列 ${column}`).toContain(column);
      }
      const [owner] = await queryRows<{ id: number; username: string; role: string; can_find: boolean; can_read: boolean; can_download: boolean }>(
        'SELECT id, username, role, can_find, can_read, can_download FROM users');
      expect(owner).toMatchObject({ id: 1, username: 'owner', role: 'owner', can_find: true, can_read: true, can_download: true });
    }, 60_000);

    it('权限位 CHECK 真的生效：只看书不给下载的成员可建，跳过权限位不可建', async () => {
      await expect(pg.query(
        `INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
         VALUES (2, 'reader2', 'hash', 'member', true, true, false)`,
      )).resolves.toBeTruthy();
      // 生产 CHECK（NOT can_read OR can_find）：给了阅读不给查找应该被拒。
      await expect(pg.query(
        `INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
         VALUES (3, 'reader3', 'hash', 'member', false, true, false)`,
      )).rejects.toMatchObject({ code: '23514' });
      // 生产 CHECK（NOT can_download OR (can_find AND can_read)）。
      await expect(pg.query(
        `INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
         VALUES (4, 'reader4', 'hash', 'member', false, false, true)`,
      )).rejects.toMatchObject({ code: '23514' });
      // 第二个 owner：写 owner 的 id=1 会先撞身份 CHECK（owner 只能 username='owner'）。
      await expect(pg.query(
        `INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
         VALUES (1, 'someoneelse', 'hash', 'member', true, false, false)`,
      )).rejects.toMatchObject({ code: '23514' });
    }, 60_000);

    it('身份 CHECK 真的生效：第二个 owner 或 member 无密码都不可建', async () => {
      await expect(pg.query(
        `INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
         VALUES (5, 'owner2', 'hash', 'owner', true, true, true)`,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(pg.query(
        `INSERT INTO users (id, username, password_hash, role) VALUES (6, 'nohash', NULL, 'member')`,
      )).rejects.toMatchObject({ code: '23514' });
    }, 60_000);

    it('labeled_books 有生成列身份键与唯一索引，books 同样', async () => {
      const labeled = await columnsOf('labeled_books');
      expect(labeled).toContain('title_key');
      expect(labeled).toContain('author_key');
      const indexNames = new Set([...await indexesOf('labeled_books'), ...await indexesOf('books')]);
      expect(indexNames).toContain('labeled_books_identity_idx');
      expect(indexNames).toContain('books_identity_idx');
      // 旧表达式唯一索引已被 0002 退役
      expect(indexNames).not.toContain('labeled_books_title_author_idx');
      expect(indexNames).not.toContain('books_title_author_idx');
    }, 60_000);
  });

  describe('件2 的另一面：v6 世界确实与 v7 不同构（否则 v6→v7 迁移测试恒真）', () => {
    beforeEach(async () => {
      pg = new PGliteCtor!();
      await createProductionSchemaAtAuthV6(sqlTag() as never, pg);
    }, 120_000);

    it('v6 夹具的 download_tasks 还没有 requested_by / lease_generation，auth 记账只到 v6', async () => {
      expect(await authVersions(pg)).toEqual([1, 2, 3, 4, 5, 6]);
      const columns = await columnsOf('download_tasks');
      expect(columns).not.toContain('requested_by');
      expect(columns).not.toContain('lease_generation');
      // 但 users 仍是生产全列（v6 世界不该为了图省事退化成 users(id)）
      const userColumns = await columnsOf('users');
      expect(userColumns).toContain('can_read');
      expect(userColumns).toContain('can_download');
    }, 60_000);

    it('v6 世界升级到 v7 后拿到 lease 列与身份 CHECK，且 users 外键仍生效', async () => {
      await upgradeToAuthV7(sqlTag() as never);
      expect(await authVersions(pg)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const columns = await columnsOf('download_tasks');
      for (const column of ['requested_by', 'lease_generation', 'lease_owner', 'enqueue_key']) {
        expect(columns, `v7 后 download_tasks 缺少 ${column}`).toContain(column);
      }
      // 生产 users CHECK：孤儿的 user_id 会被 users 外键拦下
      await expect(pg.query(
        `INSERT INTO download_tasks (user_id, book_id, title, requested_by) VALUES (999, 1, '孤儿任务', 'user')`,
      )).rejects.toMatchObject({ code: '23503' });
    }, 60_000);
  });

  describe('件3：反转闸门——夹具里不能再出现手抄的生产 DDL', () => {
    // 判别力：把 fixtures/production-schema.ts 换成一份手写 CREATE TABLE，本用例即红。
    // 判据看**语句**而不是裸字符串：先剥掉注释，避免被文件自己的说明文字误伤。
    it('production-schema.ts 不含手写的业务建表语句或生成列', () => {
      const raw = readFileSync(new URL('./fixtures/production-schema.ts', import.meta.url), 'utf8');
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
      for (const banned of [
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?users\b/i,
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?labeled_books\b/i,
        /GENERATED\s+ALWAYS\s+AS/i,
      ]) {
        expect(source, `fixture 又手抄了生产 DDL：${banned}`).not.toMatch(banned);
      }
      // 反向确认闸门自身有效：这份代码必须真的在读 fixture 源码。
      expect(raw).toContain('identityKeyMigrationSql');
    }, 60_000);

    // 判别力：把 title_key 的剥《》那层从 migrations/0002_identity_key.sql 删掉 → 本用例红。
    it('0002 迁移的 title_key 表达式仍然剥《（生产权威定义未被削弱）', () => {
      const migration = identityKeyMigrationSql();
      const occurrences = migration.match(/regexp_replace/g) ?? [];
      expect(occurrences.length).toBe(2); // books 与 labeled_books 各一层
      expect(migration).toContain("'^《(.+)》$'");
    }, 60_000);

    // 判别力：从 createProductionSchemaAtAuthV6 的降级清单里删掉任一项 → 本用例红。
    it('T8 绑定层与 T3 层的建表路径来自同一份生产入口（不再是两份手抄本）', async () => {
      const shared = readFileSync(new URL('./fixtures/production-schema.ts', import.meta.url), 'utf8');
      const worker = readFileSync(new URL('./download-worker.pglite.test.ts', import.meta.url), 'utf8');
      const queue = readFileSync(new URL('./download-task-queue.pglite.test.ts', import.meta.url), 'utf8');
      const runtime = readFileSync(new URL('../../runtime-download/testing/pglite.ts', import.meta.url), 'utf8');
      for (const text of [worker, queue, runtime]) {
        expect(text).not.toMatch(/CREATE TABLE users/i);
        expect(text).not.toMatch(/CREATE TABLE download_tasks/i);
        expect(text).not.toMatch(/CREATE TABLE labeled_books/i);
        expect(text).toMatch(/production-schema/);
      }
      expect(shared).toMatch(/createProductionSchema/);
    }, 60_000);
  });

  describe('稳定性：同一入口两次建 schema 得到同一份结构', () => {
    it('增量（artifact）不改变 books / labeled_books 的指纹', async () => {
      pg = new PGliteCtor!();
      const sql = sqlTag();
      await createProductionSchema(sql as never, statement => pg.exec(statement));
      const before = await tableFingerprint(pg, 'labeled_books');
      await createArtifactSchema(sql as never);
      const after = await tableFingerprint(pg, 'labeled_books');
      expect(after).toBe(before);
    }, 120_000);
  });
});
