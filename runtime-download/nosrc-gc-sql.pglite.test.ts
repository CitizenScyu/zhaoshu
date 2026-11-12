// tocfloor1111：deploy/phoenix/nosrc-tool.sh 的 gc 判定 SQL（gc_sql 与 GC_DELETE_WHERE 原文）和 cmd_enqueue 的 SQL 在 PGlite 真库上跑。
// 钉住：被章数下限闸门拒过（候选或任务行记 toc_below_floor）的书不进删除集；只抓到过很多章不算证据
// （预览站给全目录、正文是预览，事后判 preview_truncated）；nofloor- 逃生任务之后旧证据作废。不连生产。
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

  const task = (bookId: number, revision: string, error: string) => pg.query(
    `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind, source_revision, error)
     VALUES (NULL, $1, '合成书', '合成作者', 'failed', 'https://book.qq.com/book-detail/1', 'system', 'builtin', $2, $3)`,
    [bookId, revision, error]);
  const gated = async (ids: number[]) => {
    await pg.exec('DROP TABLE IF EXISTS gc;');
    await pg.exec(gcSql!);
    return (await pg.query(`SELECT id, gated, (${deleteWhere}) AS del FROM gc WHERE id IN (${ids.join(', ')}) ORDER BY id`))
      .rows.map(row => { const r = row as { id: number; gated: boolean; del: boolean }; return [r.id, r.gated, r.del]; });
  };

  it('nofloor- 任务之后：此前的闸门证据（候选或任务行）不再算，不论它怎么收场；之后再记的照算', async () => {
    const taskGated = await book('合成任务闸门书');
    await pg.query(`UPDATE download_tasks SET error = 'toc_below_floor' WHERE book_id = $1 AND source_revision = ''`, [taskGated]);
    const candGated = await book('合成候选闸门书');
    await candidate(candGated, 'https://m.example.org/2/', 'temporary', 'toc_below_floor');
    await pg.query(`UPDATE download_source_candidates SET updated_at = now() - interval '1 hour' WHERE book_id = $1`, [candGated]);
    const reArmed = await book('合成再记候选书'); // nofloor- 跑时该源只是超时（markCandidateFailure 保留原因、刷新时间）
    await candidate(reArmed, 'https://m.example.org/3/', 'temporary', 'toc_below_floor');
    const taskAfter = await book('合成再记任务书');
    for (const id of [taskGated, candGated, reArmed, taskAfter]) await task(id, 'nofloor-20261111', 'preview_truncated');
    await pg.query(`UPDATE download_tasks SET created_at = now() - interval '2 hours' WHERE book_id = $1 AND source_revision LIKE 'nofloor-%'`, [reArmed]);
    await task(taskAfter, 'gc-lastcall-20261112', 'toc_below_floor');
    expect(await gated([taskGated, candGated, reArmed, taskAfter])).toEqual([
      [taskGated, false, true], [candGated, false, true], [reArmed, true, false], [taskAfter, true, false],
    ]);
  });

  // gapzero1112：生产 6464「缺章 0/0：operation_timeout」——目录都没拿到，既不是 gapfill 的补抓对象
  // （没有缺口可算），也不在原 delkind 表内，会永远卡在「gc 判 held、gapfill 选不中」的空洞里。
  // 只对 chapters_total=0 生效：有章数的 partial 是缺章，交给 gapfill，不能因为原因不在表内就删半本书。
  it('0/0 且原因不在原 delkind 表内（operation_timeout 等）⇒ 可删；有章数的同原因 partial ⇒ 不删', async () => {
    const zeroTimeout = await book('合成零章超时书');
    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                  source_revision, error, chapters_done, chapters_total)
       VALUES (NULL, $1, '合成书', '合成作者', 'partial', 'https://book.qq.com/book-detail/1', 'system', 'builtin',
               'lastcall-20261109', '缺章 0/0：operation_timeout', 0, 0)`, [zeroTimeout]);
    const hasChapters = await book('合成有章超时书');
    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                  source_revision, error, chapters_done, chapters_total)
       VALUES (NULL, $1, '合成书', '合成作者', 'partial', 'https://book.qq.com/book-detail/1', 'system', 'builtin',
               'lastcall-20261109', '缺章 0/46：operation_timeout', 0, 46)`, [hasChapters]);

    await pg.exec('DROP TABLE IF EXISTS gc;');
    await pg.exec(gcSql!);
    const rows = (await pg.query(
      `SELECT id, delkind, (${deleteWhere}) AS del FROM gc WHERE id IN (${zeroTimeout}, ${hasChapters}) ORDER BY id`))
      .rows as { id: number; delkind: boolean; del: boolean }[];
    expect(rows).toEqual([
      { id: zeroTimeout, delkind: true, del: true },
      { id: hasChapters, delkind: false, del: false },
    ]);
  });

  // gapclash1112：gcrun 的 0/0 子句与 gapfill 补抓梯子跨冲突——gapfill 的 d CTE 会绕过 0/0 最新行、
  // 从更早的 chapters_total>0 行算缺口继续补抓（书正处 6 次/63 天梯子上）。若本书有更早总量行，
  // 0/0 只是补抓途中目录前超时：不删，让梯子走完；只有全书从没拿到过目录的 0/0 才按空洞删。
  it('0/0 最新行 + 更早 chapters_total>0 行（gapfill 梯子上）⇒ 不删；全书无总量行的 0/0 ⇒ 仍可删', async () => {
    const onLadder = await book('合成梯子上书');
    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                  source_revision, error, chapters_done, chapters_total)
       VALUES (NULL, $1, '合成书', '合成作者', 'partial', 'https://book.qq.com/book-detail/1', 'system', 'builtin',
               'gapfill-20261112', '缺章 300/500：missing_chapters', 300, 500)`, [onLadder]);
    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                  source_revision, error, chapters_done, chapters_total)
       VALUES (NULL, $1, '合成书', '合成作者', 'partial', 'https://book.qq.com/book-detail/1', 'system', 'builtin',
               'gapfill-20261112', '缺章 0/0：operation_timeout', 0, 0)`, [onLadder]);
    const neverToc = await book('合成无目录书');
    await pg.query(
      `INSERT INTO download_tasks(user_id, book_id, title, author, status, source_url, requested_by, source_kind,
                                  source_revision, error, chapters_done, chapters_total)
       VALUES (NULL, $1, '合成书', '合成作者', 'partial', 'https://book.qq.com/book-detail/1', 'system', 'builtin',
               'lastcall-20261109', '缺章 0/0：operation_timeout', 0, 0)`, [neverToc]);

    await pg.exec('DROP TABLE IF EXISTS gc;');
    await pg.exec(gcSql!);
    const rows = (await pg.query(
      `SELECT id, delkind, (${deleteWhere}) AS del FROM gc WHERE id IN (${onLadder}, ${neverToc}) ORDER BY id`))
      .rows as { id: number; delkind: boolean; del: boolean }[];
    expect(rows).toEqual([
      { id: onLadder, delkind: false, del: false },
      { id: neverToc, delkind: true, del: true },
    ]);
  });

  // cmd_enqueue 的 SQL 原文；psql 变量换成字面量。
  const enqueueSql = (ids: number[], rev: string) =>
    /\ncmd_enqueue\(\) \{\n[\s\S]*?cat <<'SQL' \| [^\n]*\n([\s\S]*?)\nSQL\n\}/.exec(script)![1]
      .replace(":'ids'", `'{${ids.join(',')}}'`).replace(":'rev'", `'${rev}'`);
  const candidateAge = async (bookId: number) => (await pg.query(
    `SELECT source_url, failure_reason, updated_at < now() - interval '48 hours' AS reopened
     FROM download_source_candidates WHERE book_id = $1 ORDER BY source_url`, [bookId])).rows;

  it('enqueue nofloor-：同一事务把本批入列书的闸门源挪出 48h 失败窗口；别的原因、别的书、别的前缀不动；同后缀重跑整批回滚', async () => {
    const target = await book('合成逃生书');
    await candidate(target, 'https://m.example.org/5/', 'temporary', 'toc_below_floor');
    await candidate(target, 'https://www.biquge.site/5/', 'temporary', 'preview_truncated');
    const outside = await book('合成未入列书');
    await candidate(outside, 'https://m.example.org/6/', 'temporary', 'toc_below_floor');
    const lastcall = await book('合成普通重排书');
    await candidate(lastcall, 'https://m.example.org/7/', 'temporary', 'toc_below_floor');

    await pg.exec(enqueueSql([target], 'nofloor-20261111'));
    await pg.exec(enqueueSql([lastcall], 'gc-lastcall-20261111'));
    expect(await candidateAge(target)).toEqual([
      { source_url: 'https://m.example.org/5/', failure_reason: 'toc_below_floor', reopened: true },
      { source_url: 'https://www.biquge.site/5/', failure_reason: 'preview_truncated', reopened: false },
    ]);
    expect(await candidateAge(outside)).toMatchObject([{ reopened: false }]);
    expect(await candidateAge(lastcall)).toMatchObject([{ reopened: false }]);
    expect((await pg.query(`SELECT status FROM download_tasks WHERE book_id = $1 AND source_revision = 'nofloor-20261111'`, [target])).rows)
      .toEqual([{ status: 'pending' }]);

    // 逃生任务收场后，挪窗前的闸门证据不再算。
    await pg.query(`UPDATE download_tasks SET status = 'failed', error = 'preview_truncated' WHERE book_id = $1 AND status = 'pending'`, [target]);
    expect(await gated([target])).toEqual([[target, false, true]]);

    // 同后缀重跑：target 的 enqueue_key 已存在 ⇒ inserted < eligible ⇒ 整批回滚，同批 fresh 的入列和挪窗一起撤销。
    const fresh = await book('合成同批新书');
    await candidate(fresh, 'https://m.example.org/8/', 'temporary', 'toc_below_floor');
    await expect(pg.exec(enqueueSql([target, fresh], 'nofloor-20261111'))).rejects.toThrow('use a new suffix');
    await pg.exec('ROLLBACK;');
    expect(await candidateAge(fresh)).toMatchObject([{ reopened: false }]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM download_tasks WHERE book_id = $1 AND source_revision LIKE 'nofloor-%'`, [fresh])).rows)
      .toEqual([{ n: 0 }]);
  });
});
