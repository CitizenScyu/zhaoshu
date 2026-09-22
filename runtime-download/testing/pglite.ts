// T8 绑定层测试夹具：PGlite 真库语义（不连生产 DB）。
//
// 建表路径改为复用 src/lib/fixtures/production-schema（生产 schema 的唯一来源）：
// 以前这里手抄 users/download_tasks/labeled_books 与 title_key 生成式，抄本与
// migrations/0002_identity_key.sql 漂移（少了剥《》那一层 regexp_replace），导致
// 《余生》与「余生」**在测试里匹配不上、在生产里匹配得上**——漏匹配回归系统性隐形。
// 现在测试与生产同源，生产改了 DDL 测试自动跟上。

import { loadPGlite, type PGliteLike } from '../../src/lib/fixtures/pglite';
import { createPGliteSql } from '../../src/lib/fixtures/pglite-sql';
import {
  createArtifactSchema, createProductionSchema, upgradeToAuthV7,
} from '../../src/lib/fixtures/production-schema';
import type { DownloadSql } from '../storage';

export { loadPGlite, type PGliteLike };

/** PGlite 标签适配：把 `sql\`...\`` 转成参数化查询，返回行数组（与 neon 标签同形）。 */
export function makeSqlTag(pg: PGliteLike): DownloadSql {
  return createPGliteSql(pg) as unknown as DownloadSql;
}

export async function createSchema(pg: PGliteLike): Promise<void> {
  const sql = createPGliteSql(pg);
  await createProductionSchema(sql as never, statement => pg.exec(statement));
  await upgradeToAuthV7(sql as never);
  await createArtifactSchema(sql as never);
  await pg.exec(`
    INSERT INTO labeled_books(title, author, source_url) VALUES ('测试书', '佚名', 'https://book15.net/books/1.html');
    INSERT INTO storage_repositories(id, owner, repo, branch, enabled) VALUES (1, 'fixture', 'private', 'main', true);
  `);
}
