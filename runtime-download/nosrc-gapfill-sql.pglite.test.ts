// gapdead1112：deploy/phoenix/nosrc-tool.sh 的 gapfill 选取 SQL（原文）在 PGlite 真库上跑。
// 钉住：最新任务停在 partial 缺章、从没发布过的书也要进补抓池——此前只取 status='done'，这批书
// 既不会被 gapfill 选中、gcrun 又按 held 不删（missing_chapters），永久卡死（生产 58 本）。
// 同时不得把已按全章发布的书（追更重下失败留下 partial 行）重新拉进补抓。不连生产。
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, loadPGlite, type PGliteLike } from './testing/pglite';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const script = readFileSync('deploy/phoenix/nosrc-tool.sh', 'utf8').replace(/\r\n/g, '\n');
// cmd_gapfill 里第一段 heredoc：CREATE TEMP TABLE gf … 到分桶统计之前。
const gapSql = /\ncmd_gapfill\(\) \{\n[\s\S]*?cat <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script)?.[1]
  ?.split('SELECT bucket')[0]
  ?.replace(/:\s*base\b/g, '24').replace(/:\s*max\b/g, '6');

maybe('nosrc-tool.sh gapfill：partial 缺章书也要补抓', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createSchema(pg);
  }, 60_000);
  afterEach(async () => { await pg.close(); });

  const book = async (title: string) => Number(((await pg.query(
    `INSERT INTO labeled_books(title, author, source_url) VALUES ($1, '合成作者', 'https://book15.net/b/1.html') RETURNING id`,
    [title])).rows[0] as { id: number }).id);
  const task = (bookId: number, status: string, done: number, total: number, ageHours = 48) => pg.query(
    `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                error, chapters_done, chapters_total, updated_at, created_at)
     VALUES (NULL, $1, '合成书', '合成作者', $2, 'https://book15.net/b/1.html', 'system', 'builtin', $3, $4, $5,
             now() - interval '1 hour' * $6, now() - interval '1 hour' * $6)`,
    [bookId, status, status === 'partial' ? `缺章 ${done}/${total}：missing_chapters` : '', done, total, ageHours]);
  const artifact = (bookId: number, done: number, total: number) => pg.query(
    `INSERT INTO book_artifacts(labeled_book_id, identity_key, repository_id, branch, canonical_path, snapshot_path,
                                version, blob_sha, bytes, chapters_total, chapters_done, chars, source_revision, quality_status, published_at)
     VALUES ($1, 'k' || $1, 1, 'main', 'p/' || $1, 's/' || $1, 1, 'sha', 1, $2, $3, 1, '', 'ok', now())`,
    [bookId, total, done]);

  const selected = async () => {
    await pg.exec('DROP TABLE IF EXISTS gf;');
    await pg.exec(gapSql!);
    return (await pg.query('SELECT id, missing FROM gf ORDER BY id')).rows as { id: number; missing: number }[];
  };

  it('脚本里取得到 gapfill 选取 SQL', () => {
    expect(gapSql).toContain('CREATE TEMP TABLE gf');
  });

  it('最新任务 partial 缺章、没发布过 ⇒ 入选；已按全章发布 ⇒ 不入；全章 done ⇒ 不入', async () => {
    const partialOnly = await book('合成未发布缺章书');
    await task(partialOnly, 'partial', 54, 269);

    const publishedFull = await book('合成已发布全书');
    await task(publishedFull, 'partial', 0, 120);
    await artifact(publishedFull, 120, 120); // 追更重下失败留下 partial 行，但已发布全章

    const doneFull = await book('合成完成书');
    await task(doneFull, 'done', 300, 300);

    expect(await selected()).toEqual([{ id: partialOnly, missing: 215 }]);
  });

  it('已有 pending/running 任务、或补抓次数到顶 ⇒ 不入；有更新的 done 全章行 ⇒ 按最新行判，不入', async () => {
    const busy = await book('合成在跑书');
    await task(busy, 'partial', 10, 100);
    await task(busy, 'running', 20, 100);

    const capped = await book('合成到顶书');
    await task(capped, 'partial', 10, 100);
    for (let i = 0; i < 6; i += 1) {
      await pg.query(
        `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                    source_revision, chapters_done, chapters_total, updated_at, created_at)
         VALUES (NULL, $1, '合成书', '合成作者', 'failed', 'https://book15.net/b/1.html', 'system', 'builtin',
                 'gapfill-20261111', 0, 0,
                 now() - interval '1 hour' * 40, now() - interval '1 hour' * 40)`, [capped]);
    }

    // 先缺章、后补成整本：最新 done 行已满章，不再补抓。
    const latestDone = await book('合成后补全书');
    await task(latestDone, 'partial', 5, 100, 72);
    await task(latestDone, 'done', 100, 100, 48);
    expect(await selected()).toEqual([]);
  });
});
