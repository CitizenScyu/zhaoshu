// T5 PGlite 真库用例:labels 入库 + 系统入队同语句(=同事务)、幂等、边界与补账。
//
// 环境:复用 src/lib/fixtures/pglite.ts(缺依赖硬失败,不静默跳过)。
// 迁移:直接用 T1 的 auth v7 迁移体(authSchemaV7Statement)建真实队列结构。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertLabeledBookId,
  classifyImportMarker,
  ensureSystemTask,
  importLabelWithSystemTask,
  type ImportedLabelRecord,
  type ImporterSql,
} from './importer-enqueue';
import { loadPGlite, type PGliteLike } from './fixtures/pglite';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema, seedV6MemberUser } from './fixtures/production-schema';

type Row = Record<string, unknown>;

function adapter(pg: PGliteLike): ImporterSql {
  return (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  }) as ImporterSql;
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const BASE: ImportedLabelRecord = {
  title: '测试书', author: '作者甲', category: '玄幻奇幻', finishStatus: '完结',
  sourceSite: 'book15.net', sourceUrl: 'https://book15.net/books/details1.html',
  charsLabeled: 400000,
  labels: { title_guess: '测试书', text_quality: '正常', quality: { overall: 8.5 } },
  primaryGenre: '玄幻', subTags: ['成长'], quality: 8.5,
};

const POLICY = { policyVersion: 't5-test-v1', sourceRevision: 'r1' };

maybe('T5:labels 入库与系统入队同语句', () => {
  let pg: PGliteLike;
  let sql: ImporterSql;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = adapter(pg);
    await createProductionSchema(createPGliteSql(pg) as never, statement => pg.exec(statement));
    await seedV6MemberUser(pg);
  }, 60_000);

  async function taskRows(): Promise<Row[]> {
    return (await pg.query(
      `SELECT id, user_id, book_id, title, status, requested_by, enqueue_key, policy_version, source_revision
       FROM download_tasks ORDER BY id`)).rows;
  }

  async function labelRows(): Promise<Row[]> {
    return (await pg.query('SELECT id, title, author, source_url FROM labeled_books ORDER BY id')).rows;
  }

  it('explicit sourceKind still normalizes policy fields and rejects blank policy', async () => {
    await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    const result = await ensureSystemTask(sql, BASE, {
      policyVersion: ` ${POLICY.policyVersion} `, sourceRevision: ' r1 ', sourceKind: ' builtin ', sourceId: ' ',
    });
    expect(result.taskOutcome).toBe('existing');
    await expect(ensureSystemTask(sql, BASE, { policyVersion: ' ', sourceKind: 'builtin' })).rejects.toThrow('policyVersion is invalid');
  });
  it('同一语句:labels 落库与系统任务入队一起成功,book_id 取自 labeled_books.id', async () => {
    const outcome = await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    expect(outcome.taskOutcome).toBe('created');
    expect(outcome.taskId).toBeGreaterThan(0);
    expect(outcome.labelsWritten).toBe(true);
    const labels = await labelRows();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ title: '测试书', author: '作者甲' });
    const tasks = await taskRows();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      user_id: null, book_id: labels[0].id, requested_by: 'system', status: 'pending',
      enqueue_key: `${labels[0].id}:t5-test-v1:r1`, policy_version: 't5-test-v1', source_revision: 'r1',
    });
  });

  it('内容更新时同一条语句同时改 labels 与补系统任务,不产生第二行 labeled_books', async () => {
    await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    await pg.query("UPDATE download_tasks SET status = 'done' WHERE requested_by = 'system'");
    const second = await importLabelWithSystemTask(sql, {
      record: { ...BASE, charsLabeled: 500000, labels: { ...BASE.labels as object, genre: '仙侠' } },
      marker: 'ready', task: POLICY,
    });
    expect(second.taskOutcome).toBe('existing');
    const labels = await labelRows();
    expect(labels).toHaveLength(1);
    expect((await pg.query('SELECT chars_labeled FROM labeled_books')).rows[0].chars_labeled).toBe(500000);
    expect(await taskRows()).toHaveLength(1);
  });

  it('DB 入队失败则整条语句回滚:labels 不落库,可原样重放', async () => {
    // 制造入队侧必然失败:预置一条同事件的 system 行占住事件键**且**同时占住活动索引,
    // 再把 identity CHECK 破坏成 requested_by='system' + user_id 非空是不可能的(约束在库上),
    // 因此改用「事件键唯一索引存在但 download_tasks.title 被收紧为 NOT NULL 且 CHECK 非空」
    // 之外更直接的方式:把 source_kind 传成超出 CHECK/类型边界的值。
    await pg.exec(`ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_source_kind_len CHECK (length(source_kind) <= 8)`);
    await expect(importLabelWithSystemTask(sql, {
      record: BASE, marker: 'ready', task: { policyVersion: 't5-test-v1', sourceRevision: 'r1', sourceKind: 'kind-too-long' },
    })).rejects.toThrow();
    // 同一条语句:labels 也必须一起回滚。
    expect(await labelRows()).toHaveLength(0);
    expect(await taskRows()).toHaveLength(0);
    // 重放(去掉人为约束后)只产生一行,且事件键与首次一致。
    await pg.exec('ALTER TABLE download_tasks DROP CONSTRAINT download_tasks_source_kind_len');
    const replay = await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    expect(replay.taskOutcome).toBe('created');
    expect(await labelRows()).toHaveLength(1);
    expect(await taskRows()).toHaveLength(1);
  });

  it('重复导入(同内容重放)只产生一次系统事件', async () => {
    const first = await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    const second = await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    const third = await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    expect(first.taskOutcome).toBe('created');
    expect([second.taskOutcome, third.taskOutcome]).toEqual(['existing', 'existing']);
    expect(second.taskId).toBe(first.taskId);
    expect(await taskRows()).toHaveLength(1);
  });

  it('sourceRevision 变化是新事件:不重复建第二条任务,也不回滚 labels(同书活动任务守卫)', async () => {
    const first = await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    const second = await importLabelWithSystemTask(sql, {
      record: BASE, marker: 'ready', task: { policyVersion: 't5-test-v1', sourceRevision: 'r2' },
    });
    // 同书已经有活动 system 任务 → 解析为 existing(T1 对这类竞争的处理同形),
    // 而不是撞 download_tasks_system_active_book_idx 把整个导入回滚掉。
    expect(second).toMatchObject({ taskOutcome: 'existing', taskId: first.taskId, labelsWritten: true });
    expect(await taskRows()).toHaveLength(1);
    expect(await labelRows()).toHaveLength(1);
    // 该任务结束后,新事件才允许再入一条(不同键,同一本书)。
    await pg.query("UPDATE download_tasks SET status = 'done' WHERE requested_by = 'system'");
    const third = await importLabelWithSystemTask(sql, {
      record: BASE, marker: 'ready', task: { policyVersion: 't5-test-v1', sourceRevision: 'r2' },
    });
    expect(third.taskOutcome).toBe('created');
    const rows = await taskRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.enqueue_key)).toEqual([
      `${rows[0].book_id}:t5-test-v1:r1`, `${rows[0].book_id}:t5-test-v1:r2`,
    ]);
  });

  it('twin / review / skipped / failed 标记既不入库也不入队', async () => {
    for (const marker of ['review', 'skipped', 'twin-skipped', 'failed'] as const) {
      expect(classifyImportMarker(marker)).toBe('no-enqueue');
      const outcome = await importLabelWithSystemTask(sql, { record: BASE, marker, task: POLICY });
      expect(outcome).toEqual({ labeledBookId: null, taskOutcome: 'not_enqueued', taskId: null, labelsWritten: false });
    }
    expect(await labelRows()).toHaveLength(0);
    expect(await taskRows()).toHaveLength(0);
  });

  it('marker 已有(duplicate)时只补账不重写 labels,缺任务则补上', async () => {
    // 历史书:labels 已在库,系统任务不存在(去重上线前导入的存量).
    await pg.query(
      `INSERT INTO labeled_books (title, author, source_url, chars_labeled)
       VALUES ('存量书', '存量作者', 'https://book15.net/books/details9.html', 111)`);
    const outcome = await importLabelWithSystemTask(sql, {
      record: { ...BASE, title: '存量书', author: '存量作者', charsLabeled: 999999 },
      marker: 'duplicate', task: POLICY,
    });
    expect(outcome.taskOutcome).toBe('created');
    expect(outcome.labelsWritten).toBe(false);
    expect((await pg.query('SELECT chars_labeled FROM labeled_books')).rows[0].chars_labeled).toBe(111);
    expect(await taskRows()).toHaveLength(1);
    // 第二次补账:事件键已存在 → 不再新建。
    const again = await importLabelWithSystemTask(sql, {
      record: { ...BASE, title: '存量书', author: '存量作者' }, marker: 'duplicate', task: POLICY,
    });
    expect(again.taskOutcome).toBe('existing');
    expect(await taskRows()).toHaveLength(1);
  });

  it('接缝 hasReadableArtifact 命中时不建任务,但 labels 照常入库', async () => {
    // 已存在同身份的行(补账语义),接缝说它有可读产物 → 只更新 labels,不建任务。
    await pg.query(
      `INSERT INTO labeled_books (title, author) VALUES ('已有产物', '作者甲')`);
    const outcome = await importLabelWithSystemTask(sql, {
      record: { ...BASE, title: '已有产物' }, marker: 'ready', task: POLICY,
      artifacts: { hasReadableArtifact: async () => true },
    });
    expect(outcome.taskOutcome).toBe('artifact_exists');
    expect(outcome.taskId).toBeNull();
    expect(await taskRows()).toHaveLength(0);
    expect((await pg.query('SELECT chars_labeled FROM labeled_books')).rows[0].chars_labeled).toBe(400000);
  });

  it('事件键已有的书补账是 no-op,同书有 activity 时也不重复建任务', async () => {
    await importLabelWithSystemTask(sql, { record: BASE, marker: 'ready', task: POLICY });
    const again = await ensureSystemTask(sql, BASE, POLICY);
    expect(again.taskOutcome).toBe('existing');
    expect(await taskRows()).toHaveLength(1);
    await pg.query("UPDATE download_tasks SET status = 'done' WHERE requested_by = 'system'");
    // 事件键仍在(终态行占键)→ 只补账不重下。
    const afterDone = await importLabelWithSystemTask(sql, { record: BASE, marker: 'duplicate', task: POLICY });
    expect(afterDone.taskOutcome).toBe('existing');
    expect(await taskRows()).toHaveLength(1);
  });

  it('ensureSystemTask 只按身份键查行,找不到就不建任务', async () => {
    await expect(ensureSystemTask(sql, { title: '不存在的书', author: '作者' }, POLICY))
      .rejects.toThrow('labeled book not found');
    expect(await taskRows()).toHaveLength(0);
  });

  it('ID 空间红线:books.id 填进下载任务会被 assertLabeledBookId 拦下', async () => {
    await pg.query("INSERT INTO books (title, author) VALUES ('另一 ID 空间的书', '作者')");
    await expect(assertLabeledBookId(sql, 1)).rejects.toThrow('labeled_book_id_not_in_space');
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(assertLabeledBookId(sql, bad as number)).rejects.toThrow();
    }
    // 真实 labeled_books.id 通过。
    const [label] = (await pg.query(
      "INSERT INTO labeled_books (title, author) VALUES ('合法书', '作者') RETURNING id")).rows;
    await expect(assertLabeledBookId(sql, Number(label.id))).resolves.toBeUndefined();
  });

  it('user 任务与系统任务互不影响:system 行 user_id NULL,user 活动索引不拦 system', async () => {
    const [label] = (await pg.query(
      "INSERT INTO labeled_books (title, author) VALUES ('双任务书', '作者') RETURNING id")).rows;
    await pg.query(
      `INSERT INTO download_tasks (user_id, book_id, title, status, requested_by)
       VALUES (2, $1, '双任务书', 'pending', 'user')`, [label.id]);
    const outcome = await ensureSystemTask(sql, { title: '双任务书', author: '作者' }, POLICY);
    expect(outcome.taskOutcome).toBe('created');
    const rows = await taskRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.requested_by).sort()).toEqual(['system', 'user']);
  });

  it('23505 竞争回退为 existing 且 labels 仍写入', async () => {
    const [label] = (await pg.query(
      "INSERT INTO labeled_books (title, author) VALUES ('竞争书', '作者') RETURNING id")).rows;
    const [active] = (await pg.query(
      `INSERT INTO download_tasks (book_id, title, status, requested_by, policy_version, source_revision, enqueue_key)
       VALUES ($1, '竞争书', 'pending', 'system', 'other-v1', 'r0', 'other') RETURNING id`, [label.id])).rows;
    let calls = 0;
    const racingSql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls += 1;
      if (calls === 2) { const error = new Error('duplicate'); (error as Error & { code: string }).code = '23505'; throw error; }
      return sql(parts, ...values);
    }) as typeof sql;
    const outcome = await importLabelWithSystemTask(racingSql, { record: { ...BASE, title: '竞争书', author: '作者' }, marker: 'ready', task: POLICY });
    expect(outcome.labelsWritten).toBe(true);
    expect(outcome.taskOutcome).toBe('existing');
    expect(outcome.taskId).toBe(Number(active.id));
    expect((await pg.query("SELECT chars_labeled FROM labeled_books WHERE id = $1", [label.id])).rows[0].chars_labeled).toBe(BASE.charsLabeled);
  });

  it('imported 入队, disabled 显式不入队, 未知 marker 抛错', async () => {
    expect(classifyImportMarker('imported')).toBe('import-and-enqueue');
    expect(classifyImportMarker('disabled')).toBe('no-enqueue');
    expect(() => classifyImportMarker('future-marker' as never)).toThrow('unknown import marker');
  });
});
