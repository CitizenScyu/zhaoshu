// tocfloor1111：deploy/phoenix/nosrc-tool.sh 的 gc 判定 SQL（gc_sql 与 GC_DELETE_WHERE 原文）在 PGlite 真库上跑。
// 钉住：被章数下限闸门拒过（候选或任务行记 toc_below_floor）的书不进删除集；只抓到过很多章不算证据
// （预览站给全目录、正文是预览，事后判 preview_truncated）。不连生产。
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, loadPGlite, type PGliteLike } from './testing/pglite';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const script = readFileSync('deploy/phoenix/nosrc-tool.sh', 'utf8').replace(/\r\n/g, '\n');
const gcSql = /\ngc_sql\(\) \{\ncat <<'SQL'\n([\s\S]*?)\nSQL\n\}/.exec(script)?.[1];
const deleteWhere = /^GC_DELETE_WHERE="([^"]+)"$/m.exec(script)?.[1];
const NO_CANDIDATES = '源不可用（search 阶段，已连续 16 次，停止自动重试）：no_candidates';

maybe('nosrc-tool.sh gc：章数下限闸门证据（held_gated）', () => {
  let pg: PGliteLike;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    await createSchema(pg);
  }, 60_000);
  afterEach(async () => { await pg.close(); });

  // 一本 QQ 付费墙来源的书：两次失败、末次搜索也没候选（delkind + final），历史上抓到过 300 章。
  const book = async (title: string) => {
    const id = Number(((await pg.query(
      `INSERT INTO labeled_books(title, author, source_url) VALUES ($1, '合成作者', 'https://book.qq.com/book-detail/1') RETURNING id`,
      [title])).rows[0] as { id: number }).id);
    for (const [revision, error, done] of [['', 'preview_truncated', 300], ['lastcall-20261109', NO_CANDIDATES, 0]] as const) {
      await pg.query(
        `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                    source_revision, error, chapters_done, chapters_total)
         VALUES (NULL, $1, $2, '合成作者', 'partial', 'https://book.qq.com/book-detail/1', 'system', 'builtin', $3, $4, $5, 300)`,
        [id, title, revision, error, done]);
    }
    return id;
  };
  const candidate = (bookId: number, url: string, failure: string, reason: string) => pg.query(
    `INSERT INTO download_source_candidates(book_id, source_url, host, failure, failure_reason) VALUES ($1, $2, $3, $4, $5)`,
    [bookId, url, new URL(url).hostname, failure, reason]);

  it('脚本里取得到 gc_sql 与删除条件，删除条件排除 gated', () => {
    expect(gcSql).toContain('CREATE TEMP TABLE gc AS');
    expect(deleteWhere).toContain('NOT gated');
  });

  it('候选或任务行记过 toc_below_floor ⇒ gated、不删；只抓到过很多章、源都判预览 ⇒ 照删', async () => {
    const preview = await book('合成预览书');
    await candidate(preview, 'https://www.biquge.site/1/', 'temporary', 'preview_truncated');
    const candGated = await book('合成候选闸门书');
    await candidate(candGated, 'https://www.biquge.site/2/', 'temporary', 'preview_truncated');
    await candidate(candGated, 'https://m.example.org/2/', 'temporary', 'toc_below_floor');
    const taskGated = await book('合成任务闸门书');
    await pg.query(`UPDATE download_tasks SET error = 'toc_below_floor' WHERE book_id = $1 AND source_revision = ''`, [taskGated]);
    const free = await book('合成免费候选书');
    await candidate(free, 'https://m.example.org/4/', '', '');

    await pg.exec(gcSql!);
    const ids = [preview, candGated, taskGated, free];
    const rows = (await pg.query(`SELECT id, gated, delkind, final, freeok FROM gc WHERE id IN (${ids.join(', ')}) ORDER BY id`))
      .rows as { id: number; gated: boolean; delkind: boolean; final: boolean; freeok: boolean }[];
    expect(rows.map(row => [row.id, row.gated, row.delkind && row.final, row.freeok])).toEqual([
      [preview, false, true, false], [candGated, true, true, false], [taskGated, true, true, false], [free, false, true, true],
    ]);
    const deleted = (await pg.query(`SELECT id FROM gc WHERE ${deleteWhere} AND id IN (${ids.join(', ')}) ORDER BY id`)).rows.map(row => (row as { id: number }).id);
    expect(deleted).toEqual([preview]);
  });
});
