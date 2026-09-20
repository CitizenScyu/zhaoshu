// T8 绑定层测试夹具：PGlite 真库语义（不连生产 DB）。
// 复制 download-worker.pglite.test.ts 的建表路径（v7 迁移真语句 + T2 artifact schema），
// 让绑定层测试与 T3 层看到同一份 schema。

import { loadPGlite, type PGliteLike } from '../../src/lib/fixtures/pglite';
import { authSchemaV7Statement } from '../../src/lib/auth-store';
import { initializeArtifactSchema } from '../../src/lib/business-schema';
import type { DownloadSql } from '../storage';

export { loadPGlite, type PGliteLike };

/** PGlite 标签适配：把 `sql\`...\`` 转成参数化查询，返回行数组（与 neon 标签同形）。 */
export function makeSqlTag(pg: PGliteLike): DownloadSql {
  return (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  }) as unknown as DownloadSql;
}

export async function createSchema(pg: PGliteLike): Promise<void> {
  await pg.exec(`
    CREATE TABLE auth_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO auth_schema_migrations(version) SELECT generate_series(1, 6);
    CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO users(id) VALUES (1), (2);
    CREATE TABLE download_tasks (
      id serial PRIMARY KEY, book_id integer NOT NULL, title text NOT NULL, author text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending', source_url text NOT NULL DEFAULT '',
      chapters_total integer NOT NULL DEFAULT 0, chapters_done integer NOT NULL DEFAULT 0,
      chars_total integer NOT NULL DEFAULT 0, error text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      user_id integer NOT NULL CONSTRAINT download_tasks_user_fk REFERENCES users(id)
    );
    CREATE TABLE labeled_books (
      id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '', source_url text NOT NULL DEFAULT '',
      title_key text GENERATED ALWAYS AS (lower(btrim(normalize(title, NFKC)))) STORED,
      author_key text GENERATED ALWAYS AS (lower(btrim(normalize(author, NFKC)))) STORED,
      UNIQUE (title_key, author_key)
    );
  `);
  {
    const tx = (parts: TemplateStringsArray, ...values: unknown[]) => ({
      then: (resolve: (rows: unknown) => unknown, reject: (e: unknown) => unknown) => {
        let text = ''; const params: unknown[] = [];
        parts.forEach((part, index) => { text += part; if (index < values.length) { params.push(values[index]); text += '$' + params.length; } });
        return pg.query(text, params).then(r => resolve(r.rows), reject) as unknown as Promise<unknown>;
      },
    });
    void (await authSchemaV7Statement(tx as never));
  }
  {
    type Stmt = { text: string; params: unknown[] };
    const toStmt = (parts: TemplateStringsArray, values: unknown[]): Stmt => {
      let text = ''; const params: unknown[] = [];
      parts.forEach((part, index) => { text += part; if (index < values.length) { params.push(values[index]); text += '$' + params.length; } });
      return { text, params };
    };
    const txTag = (parts: TemplateStringsArray, ...values: unknown[]) => {
      const stmt = toStmt(parts, values);
      return { ...stmt, then: (resolve: (rows: unknown) => unknown, reject: (e: unknown) => unknown) =>
        pg.query(stmt.text, stmt.params).then(r => resolve(r.rows), reject) as unknown as Promise<unknown> };
    };
    const txAdapter = Object.assign(txTag, {
      transaction: async (build: (tx: typeof txTag) => ReturnType<typeof txTag>[]) => {
        const stmts = build(txTag) as unknown as Stmt[];
        await pg.exec('BEGIN');
        try {
          const rows = [];
          for (const statement of stmts) rows.push((await pg.query(statement.text, statement.params)).rows);
          await pg.exec('COMMIT');
          return rows;
        } catch (error) {
          await pg.exec('ROLLBACK').catch(() => {});
          throw error;
        }
      },
    });
    await initializeArtifactSchema(txAdapter as never);
  }
  await pg.exec(`
    INSERT INTO labeled_books(title, author, source_url) VALUES ('测试书', '佚名', 'https://book15.net/books/1.html');
    INSERT INTO storage_repositories(id, owner, repo, branch, enabled) VALUES (1, 'fixture', 'private', 'main', true);
  `);
}
