import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createArtifactSchema, createProductionSchema, seedProductionMembers } from './fixtures/production-schema';
import { mockSql } from './fixtures/mock-sql';
import { exactLibraryBooksForUserQuery } from './user-data';
import { validateArtifactPath } from './artifact-locator';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;
let pg: PGliteLike;

async function search(title: string, canRead = true, artifactRegistryAvailable = true) {
  // 复用支持嵌套片段的 SQL 收集器；只把参数占位符转换成 PGlite 的 $n，执行真实查询。
  const db = mockSql();
  db.resolve.mockImplementation(async (query) => {
    let index = 0;
    return (await pg.query(query.text.replace(/\?/g, () => `$${++index}`), query.values)).rows as Record<string, unknown>[];
  });
  return await exactLibraryBooksForUserQuery(db.sql, 1, title, '测试作者', { canRead, artifactRegistryAvailable }) as Record<string, unknown>[];
}

async function addBook(title: string, inBooks = false, author = '测试作者') {
  const rows = (await pg.query('INSERT INTO labeled_books(title,author,source_url) VALUES ($1,$2,$3) RETURNING id',
    [title, author, 'https://example.invalid/book'])).rows as { id: number }[];
  if (inBooks) await pg.query('INSERT INTO books(title,author) VALUES ($1,$2)', [title, author]);
  return rows[0].id;
}

async function addTask(bookId: number, title: string, status = 'done', artifactId: number | string | null = null, author = '测试作者') {
  const rows = (await pg.query(`INSERT INTO download_tasks(book_id,title,author,user_id,status,artifact_id)
    VALUES ($1,$2,$3,2,$4,$5) RETURNING id`, [bookId, title, author, status, artifactId])).rows as { id: number }[];
  return rows[0].id;
}

async function addArtifact(bookId: number, status = 'published') {
  const rows = (await pg.query(`INSERT INTO book_artifacts
    (labeled_book_id,identity_key,repository_id,branch,canonical_path,quality_status,published_at,blob_sha,bytes,version)
    VALUES ($1,$2,1,'main',$3,$4,now(),$5,100,'v1') RETURNING id`,
  [bookId, `test-${bookId}-${status}`, `books/test-${bookId}-${status}.txt`, status, 'a'.repeat(40)])).rows as { id: number | string }[];
  return rows[0].id;
}

maybe('精确找书：共享完成 TXT 定位', () => {
  beforeAll(async () => {
    pg = new PGliteCtor!();
    const sql = createPGliteSql(pg);
    await createProductionSchema(sql as never, (statement) => pg.exec(statement));
    await createArtifactSchema(sql as never);
    await seedProductionMembers(pg, 3);
    // 停写/封存仓库仍可服务历史发布产物，与 locateTaskArtifact 的读取契约一致。
    await pg.exec(`INSERT INTO storage_repositories(id,owner,repo,branch,enabled,read_only,sealed_at)
      VALUES (1,'fixture','synthetic-books','main',false,true,now())`);
  }, 60_000);
  beforeEach(async () => { await pg.exec('BEGIN'); });
  afterEach(async () => { await pg.exec('ROLLBACK'); });
  afterAll(async () => {
    if (pg) { await pg.close(); expect(pg).toHaveProperty('closed', true); }
  });

  it.each([false, true])('选择最新的可共享完成任务，忽略更晚的未完成/未发布产物（books=%s）', async (inBooks) => {
    const title = '已有正文';
    const id = await addBook(title, inBooks);
    await addTask(id, title);
    const published = await addArtifact(id);
    const expected = await addTask(id, title, 'done', published);
    const rejected = await addArtifact(id, 'rejected');
    await addTask(id, title, 'done', rejected);
    await addTask(id, title, 'running');
    const rows = await search(title);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ has_txt: true, shared_read_task_id: expected });
    // legacy 是现有可读协议，更新的完成任务仍按 ID 优先，不能因无注册指针就排除。
    const newestLegacy = await addTask(id, title);
    expect((await search(title))[0].shared_read_task_id).toBe(newestLegacy);
  });

  it('无 read 权限时不返回任何共享任务 ID', async () => {
    const id = await addBook('仅有找书权限');
    await addTask(id, '仅有找书权限', 'done', await addArtifact(id));
    expect((await search('仅有找书权限', false))[0]).toMatchObject({ has_txt: true, shared_read_task_id: null });
  });

  it.each(['pending', 'running', 'failed', 'partial', 'superseded_by_incomplete'])('不暴露他人的 %s 任务', async (status) => {
    const id = await addBook('未完成任务');
    await addTask(id, '未完成任务', status);
    expect((await search('未完成任务'))[0]).toMatchObject({ has_txt: false, shared_read_task_id: null });
  });

  it.each(['reserved', 'candidate', 'rejected'])('done 任务指向 %s 注册产物时不直达', async (status) => {
    const id = await addBook('未发布正文');
    await addTask(id, '未发布正文', 'done', await addArtifact(id, status));
    expect((await search('未发布正文'))[0].shared_read_task_id).toBeNull();
  });

  it('失效非空指针不能当 legacy，仍可选到更早的合法任务', async () => {
    const id = await addBook('失效指针');
    const valid = await addTask(id, '失效指针');
    // 仅当前内存事务移除 FK，模拟历史坏指针；ROLLBACK 恢复所有结构与数据。
    await pg.exec('ALTER TABLE download_tasks DROP CONSTRAINT download_tasks_artifact_fk');
    await addTask(id, '失效指针', 'done', 99999);
    expect((await search('失效指针'))[0].shared_read_task_id).toBe(valid);
  });

  it('注册指针指向另一本书的产物时不直达错误正文', async () => {
    const id = await addBook('本书');
    const otherId = await addBook('另一本书');
    await addTask(id, '本书', 'done', await addArtifact(otherId));
    expect((await search('本书'))[0].shared_read_task_id).toBeNull();
  });

  it.each(['../book.txt', 'books//book.txt', 'books/./book.txt', 'books\\book.txt', 'books/\u0001book.txt'])('排除阅读器会拒绝的注册路径 %j', async (path) => {
    const id = await addBook('无效注册路径');
    const fallback = await addTask(id, '无效注册路径');
    const artifactId = await addArtifact(id);
    await pg.query('UPDATE book_artifacts SET canonical_path = $1 WHERE id = $2', [path, artifactId]);
    await addTask(id, '无效注册路径', 'done', artifactId);
    expect((await search('无效注册路径'))[0].shared_read_task_id).toBe(fallback);
  });

  it('SQL 路径筛选与 reader 的 validateArtifactPath 在数据库允许的边界上保持一致', async () => {
    const id = await addBook('路径契约');
    const fallback = await addTask(id, '路径契约');
    const artifactId = await addArtifact(id);
    const direct = await addTask(id, '路径契约', 'done', artifactId);
    // 空字符串已被 schema 拒绝，NUL 无法存入 PostgreSQL text；其余控制字符逐一比较。
    const paths = [
      'books/正文.txt', 'books/有 空格%20.txt', 'books/卷一/manifest.json',
      '.', '..', '/books/file.txt', 'books/', 'books/../file.txt', 'books//file.txt', 'books\\file.txt',
      ...Array.from({ length: 31 }, (_, index) => `books/${String.fromCharCode(index + 1)}file.txt`),
      'books/\u007ffile.txt',
    ];
    for (const path of paths) {
      let accepted = true;
      try { validateArtifactPath(path); } catch { accepted = false; }
      await pg.query('UPDATE book_artifacts SET canonical_path = $1 WHERE id = $2', [path, artifactId]);
      expect((await search('路径契约'))[0].shared_read_task_id, JSON.stringify(path)).toBe(accepted ? direct : fallback);
    }
  });

  it.each([false, true])('同名不同作者的任务不串到当前书（books=%s）', async (inBooks) => {
    const id = await addBook('同名书', inBooks);
    const expected = await addTask(id, '同名书');
    const other = await addBook('同名书', inBooks, '另一作者');
    await addTask(other, '同名书', 'done', null, '另一作者');
    const rows = await search('同名书');
    expect(rows.find((row) => row.author === '测试作者')?.shared_read_task_id).toBe(expected);
  });

  it('旧部署没有 artifact 表/列时，legacy 完成任务仍按原规则可定位', async () => {
    const id = await addBook('旧协议正文');
    const expected = await addTask(id, '旧协议正文');
    await pg.exec(`ALTER TABLE download_tasks DROP COLUMN artifact_id;
      DROP TABLE book_artifacts; DROP TABLE storage_repositories`);
    expect((await search('旧协议正文', true, false))[0].shared_read_task_id).toBe(expected);
  });

  it('注册表缺失但仍有非空指针时，不把未知产物当 legacy 文件', async () => {
    const id = await addBook('缺少注册表');
    await addTask(id, '缺少注册表', 'done', await addArtifact(id));
    await pg.exec(`ALTER TABLE download_tasks DROP CONSTRAINT download_tasks_artifact_fk;
      DROP TABLE book_artifacts; DROP TABLE storage_repositories`);
    expect((await search('缺少注册表', true, false))[0].shared_read_task_id).toBeNull();
  });
});
