import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeArtifactSchema } from './business-schema';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema, seedV6MemberUser } from './fixtures/production-schema';
import { artifactIdentityKey, reserveArtifactPath } from './artifact-registry';
import { bookFilename } from './book-file-name';
import { artifactContentsUrl, locateTaskArtifact } from './artifact-locator';

const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('@/lib/db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));

// Lazy statements reproduce Neon's transaction batching while standalone awaits execute queries.
function adapt(pg: PGlite) {
  const tag = (parts: TemplateStringsArray, ...params: unknown[]) => {
    const text = parts.reduce((sql, part, i) => sql + (i ? `$${i}` : '') + part, '');
    return { text, params, then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      pg.query(text, params).then(result => result.rows).then(resolve, reject) };
  };
  return Object.assign(tag, { transaction: async (build: (tx: typeof tag) => ReturnType<typeof tag>[]) => {
    const statements = build(tag);
    return pg.transaction(async tx => {
      const rows = [];
      for (const statement of statements) rows.push((await tx.query(statement.text, statement.params)).rows);
      return rows;
    });
  } }) as unknown as Parameters<typeof initializeArtifactSchema>[0];
}

describe('artifact registry: real local Postgres and mock private GitHub', () => {
  let pg: PGlite;
  let sql: ReturnType<typeof adapt>;
  let reader: typeof import('./reader-server');
  let route: typeof import('../app/api/download/[id]/file/route');

  beforeAll(async () => {
    pg = new PGlite();
    sql = adapt(pg);
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
    await seedV6MemberUser(pg);
    await pg.exec("INSERT INTO labeled_books(id,title,author) VALUES(1,'synthetic','author'),(2,'other','author')");
    // A task predating the migration is preserved, including ownership and default counters.
    await pg.exec("INSERT INTO download_tasks(id,user_id,book_id,title,author,status) VALUES(1,1,1,'legacy','author','done')");
    await initializeArtifactSchema(sql);
    await initializeArtifactSchema(sql);
  }, 60_000);
  afterAll(async () => { await pg.close(); });

  beforeEach(async () => {
    vi.resetModules();
    mocks.getSql.mockReturnValue(sql);
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.fetch.mockReset().mockImplementation(() => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', mocks.fetch);
    vi.stubEnv('GITHUB_TOKEN', 'synthetic-github-token');
    vi.stubEnv('APP_OWNER_TOKEN', 'synthetic-owner-token');
    vi.stubEnv('ZHAOSHU_BOOKS_REPO', 'fixture/legacy');
    await pg.exec(`DELETE FROM download_tasks WHERE id <> 1; UPDATE download_tasks SET artifact_id=NULL,user_id=1,status='done' WHERE id=1;
      DELETE FROM book_artifacts; DELETE FROM storage_repositories;
      INSERT INTO storage_repositories(id,owner,repo,branch,enabled) VALUES
        (1,'fixture','private-a','release/a',true),(2,'fixture','private-b','release/b',true)`);
    reader = await import('./reader-server');
    route = await import('../app/api/download/[id]/file/route');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const claim = (identityKey = 'identity-a', repositoryId = 1, canonicalPath = 'books/collision.txt') =>
    reserveArtifactPath(sql, { labeledBookId: 1, identityKey, repositoryId,
      branch: repositoryId === 1 ? 'release/a' : 'release/b', canonicalPath });

  const download = (id = 1, token = 'synthetic-owner-token') => route.GET(new NextRequest(`http://localhost/api/download/${id}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  }), { params: Promise.resolve({ id: String(id) }) });

  async function publish(repositoryId: number, bytes: Buffer) {
    const id = await claim('identity-a', repositoryId, 'books/目录/正文 #%.txt');
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    await pg.query(`UPDATE book_artifacts SET quality_status='published', blob_sha=$1, bytes=$2,
      version='v1',published_at=now() WHERE id=$3`, [sha, bytes.length, id]);
    await pg.query('UPDATE download_tasks SET artifact_id=$1 WHERE id=1', [id]);
    return { id, sha };
  }

  it('registers independent migration once, preserves old tasks, and keeps FK protection', async () => {
    expect((await pg.query('SELECT version FROM artifact_schema_migrations')).rows).toEqual([{ version: 1 }]);
    expect((await pg.query('SELECT user_id,artifact_id,chapters_done FROM download_tasks WHERE id=1')).rows)
      .toEqual([{ user_id: 1, artifact_id: null, chapters_done: 0 }]);
    await expect(pg.exec('UPDATE download_tasks SET artifact_id=999 WHERE id=1')).rejects.toMatchObject({ code: '23503' });
    // T1 v7 makes user_id nullable for system tasks; user-task ownership is now enforced
    // by download_tasks_request_identity_check (23514) instead of a NOT NULL column (23502).
    await expect(pg.exec('UPDATE download_tasks SET user_id=NULL WHERE id=1')).rejects.toMatchObject({ code: '23514' });
  });

  it('reads a pre-migration database without artifact tables or column', async () => {
    // DDL below affects only this in-memory fixture and is rolled back in all outcomes.
    await pg.exec('BEGIN; ALTER TABLE download_tasks DROP COLUMN artifact_id; DROP TABLE book_artifacts; DROP TABLE storage_repositories');
    try {
      const bytes = Buffer.from('第一章 旧书\n未迁移合成正文');
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      mocks.fetch.mockImplementation(async (_url, init) => {
        const accept = (init?.headers as Record<string,string>).Accept;
        return accept.includes('raw') ? new Response(bytes) : Response.json([
          { name: 'legacy-author.txt', type: 'file', sha, size: bytes.length },
        ]);
      });
      const response = await download();
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
      const task = await reader.getReadableTask(1, 2);
      expect(task.artifact_id).toBeUndefined();
      expect((await reader.readBookIndex(task)).version).toBe(sha);
    } finally {
      await pg.exec('ROLLBACK');
    }
  });

  it('accepts the independently added T1 bigint seam and rejects newer migration versions atomically', async () => {
    await pg.exec(`CREATE SCHEMA t2_migration_order; SET search_path TO t2_migration_order;
      CREATE TABLE labeled_books(id integer PRIMARY KEY);
      CREATE TABLE download_tasks(id integer PRIMARY KEY,artifact_id bigint)`);
    try {
      await initializeArtifactSchema(sql);
      expect((await pg.query("SELECT data_type FROM information_schema.columns WHERE table_schema='t2_migration_order' AND table_name='download_tasks' AND column_name='artifact_id'")).rows)
        .toEqual([{ data_type: 'bigint' }]);
      await expect(pg.exec('INSERT INTO download_tasks VALUES(1,999)')).rejects.toMatchObject({ code: '23503' });
      await pg.exec('INSERT INTO artifact_schema_migrations(version) VALUES(2)');
      await expect(initializeArtifactSchema(sql)).rejects.toThrow('unsupported artifact schema version');
      expect((await pg.query('SELECT version FROM artifact_schema_migrations ORDER BY version')).rows)
        .toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      await pg.exec('SET search_path TO public; DROP SCHEMA t2_migration_order CASCADE');
    }
  });

  it.each(['missing FK', 'missing version'] as const)('repairs migration divergence: %s', async divergence => {
    const id = await claim();
    await pg.query('UPDATE download_tasks SET artifact_id=$1 WHERE id=1', [id]);
    if (divergence === 'missing FK') {
      await pg.exec('ALTER TABLE download_tasks DROP CONSTRAINT download_tasks_artifact_fk');
    } else {
      await pg.exec('DELETE FROM artifact_schema_migrations WHERE version=1');
    }
    await initializeArtifactSchema(sql);
    await initializeArtifactSchema(sql);
    expect((await pg.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid='download_tasks'::regclass AND conname='download_tasks_artifact_fk' AND contype='f'`)).rows)
      .toEqual([{ n: 1 }]);
    expect((await pg.query('SELECT version FROM artifact_schema_migrations')).rows).toEqual([{ version: 1 }]);
    expect((await pg.query('SELECT artifact_id FROM download_tasks WHERE id=1')).rows).toEqual([{ artifact_id: id }]);
    expect(await claim()).toBe(id);
    await expect(pg.exec('UPDATE download_tasks SET artifact_id=999 WHERE id=1')).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects different identities claiming the same path, including competing requests', async () => {
    const results = await Promise.allSettled([claim('a'), claim('b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'ARTIFACT_PATH_COLLISION' },
    });
    expect((await pg.query('SELECT id FROM book_artifacts')).rows).toHaveLength(1);
  });

  it('protects actual 80-code-unit filename collisions and case-insensitive repository aliases', async () => {
    const title = '长'.repeat(80);
    const path = `books/${bookFilename(title, 'author-a')}`;
    expect(path).toBe(`books/${bookFilename(title, 'author-b')}`);
    await claim(artifactIdentityKey(title, 'author-a'), 1, path);
    await expect(claim(artifactIdentityKey(title, 'author-b'), 1, path))
      .rejects.toMatchObject({ code: 'ARTIFACT_PATH_COLLISION' });
    await expect(pg.exec("INSERT INTO storage_repositories(owner,repo,branch) VALUES('FIXTURE','PRIVATE-A','other')"))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('reuses identical claims, refuses identity relocation, and scopes collisions by repository/branch', async () => {
    expect(await claim()).toBe(await claim());
    await expect(claim('identity-a', 2)).rejects.toMatchObject({ code: 'ARTIFACT_IDENTITY_CONFLICT' });
    await expect(claim('identity-b', 2)).resolves.toBeTypeOf('number');
  });

  it.each(['enabled=false', 'is_private=false', 'read_only=true', 'sealed_at=now()'])('refuses writes when %s', async setting => {
    await pg.exec(`UPDATE storage_repositories SET ${setting} WHERE id=1`);
    await expect(claim()).rejects.toMatchObject({ code: 'REPOSITORY_NOT_WRITABLE' });
  });

  it('never falls back from a reserved or broken artifact pointer', async () => {
    const id = await claim();
    await expect(locateTaskArtifact(sql, id)).rejects.toThrow('ARTIFACT_NOT_READABLE');
    await expect(locateTaskArtifact(sql, 999)).rejects.toThrow('ARTIFACT_NOT_READABLE');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([1, 2])('reads registered private repository %s with pinned branch even when sealed', async repositoryId => {
    const bytes = Buffer.from('第一章 测试\n合成正文，不来自生产。\n');
    const { sha } = await publish(repositoryId, bytes);
    await pg.exec('UPDATE storage_repositories SET enabled=false,read_only=true,sealed_at=now()');
    mocks.fetch.mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`https://api.github.com/repos/fixture/private-${repositoryId === 1 ? 'a' : 'b'}/contents/books/`
        + `${encodeURIComponent('目录')}/${encodeURIComponent('正文 #%.txt')}?ref=release%2F${repositoryId === 1 ? 'a' : 'b'}`);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-github-token' });
      return new Response(bytes);
    });
    const response = await download();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    const sharedTask = await reader.getReadableTask(1, 2);
    const index = await reader.readBookIndex(sharedTask);
    expect(index.version).toBe(sha);
    expect(index.totalBytes).toBe(bytes.length);
    expect((await reader.readBookPart(sharedTask, 0, 0, sha)).text).toContain('合成正文');
  });

  it.each([2, 15])('streams %s MiB raw bytes intact through download and reader', async mib => {
    const bytes = Buffer.alloc(mib * 1024 * 1024, 0x61);
    bytes.write('第一章 合成\n');
    const { sha } = await publish(2, bytes);
    mocks.fetch.mockImplementation(async (_url, init) => {
      expect((init?.headers as Record<string,string>).Accept).toMatch(/^application\/vnd.github.raw/);
      return new Response(bytes);
    });
    const response = await download();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    const task = await reader.getReadableTask(1, 2);
    const index = await reader.readBookIndex(task);
    expect(index.totalBytes).toBe(bytes.length);
    expect(index.version).toBe(sha);
    const chunks: string[] = [];
    for (const [chapterIndex, chapter] of index.chapters.entries()) {
      for (let partIndex = 0; partIndex < chapter.partCount; partIndex++) {
        chunks.push((await reader.readBookPart(task, chapterIndex, partIndex, sha)).text);
      }
    }
    expect(Buffer.from(chunks.join('')).equals(bytes)).toBe(true);
  }, 30_000);

  it('retains legacy URLs and handles empty object content in truncated-directory fallback', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    mocks.fetch.mockImplementation(async (url, init) => {
      const accept = (init?.headers as Record<string,string>).Accept;
      if (String(url).endsWith('/contents/books')) {
        return Response.json(Array.from({ length: 1000 }, (_, i) => ({ name: `other-${i}.txt` })));
      }
      expect(String(url)).toBe('https://api.github.com/repos/fixture/legacy/contents/books/legacy-author.txt');
      if (accept.includes('object')) return Response.json({
        name: 'legacy-author.txt', type: 'file', sha, size: bytes.length, encoding: 'none', content: '',
      });
      expect(accept).toContain('raw');
      return new Response(bytes);
    });
    expect(Buffer.from(await (await download()).arrayBuffer()).equals(bytes)).toBe(true);
    expect((await reader.readBookIndex(await reader.getReadableTask(1, 2))).totalBytes).toBe(bytes.length);
  });

  it('retains owner-only downloads and hides unfinished tasks from other readers', async () => {
    await publish(1, Buffer.from('第一章\n测试正文'));
    await pg.exec('UPDATE download_tasks SET user_id=2 WHERE id=1');
    expect((await download()).status).toBe(404);
    expect((await download(1, 'incorrect')).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await pg.exec("UPDATE download_tasks SET status='pending' WHERE id=1");
    await expect(reader.getReadableTask(1, 1)).rejects.toMatchObject({ status: 404 });
    await pg.exec("UPDATE download_tasks SET status='done',user_id=1 WHERE id=1");
  });

  it('encodes literal percent and query characters and rejects traversal paths', () => {
    expect(() => artifactContentsUrl({ owner: 'fixture', repo: 'a', branch: 'main',
      canonical_path: 'books/../secret', blob_sha: 'a'.repeat(40), bytes: 1 })).toThrow('INVALID_ARTIFACT_PATH');
  });
});
