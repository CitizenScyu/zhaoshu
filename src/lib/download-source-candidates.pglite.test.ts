// bsrcfix-41：候选源持久化 + host 占位 + 预取认领（migrations/0005 三表）的真库语义测试。
// PGlite 真库（production-schema 单一来源建表，不连生产）；只测 SQL 函数层，fallback 接线见
// builtin-fallback.pglite.test.ts。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPGlite, type PGliteLike } from '../lib/fixtures/pglite';
import { createPGliteSql } from '../lib/fixtures/pglite-sql';
import { initializeBusinessSchema } from '../lib/business-schema';
import {
  claimSourcePrefetch, classifyFailure, failedCandidateSources, markCandidateFailure, occupiedHosts,
  releaseHostOccupancy, releaseSourcePrefetch, replaceSourceCandidates,
  tryOccupyHost, usableSourceCandidates,
} from './download-source-candidates';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('bsrcfix-41：候选源持久化与跨实例占位（0005 三表）', () => {
  let pg: PGliteLike;
  const sql = () => createPGliteSql(pg) as never;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    // 只需业务 schema（users 表是各 FK 的祖先）：auth v1 底座 + 业务表。
    await pg.exec(`
      CREATE TABLE users (id int PRIMARY KEY);
      INSERT INTO users (id) VALUES (1);
      CREATE TABLE labeled_books (
        id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT ''
      );
      INSERT INTO labeled_books (title, author) VALUES ('测试书', '佚名');
    `);
    await initializeBusinessSchema(sql());
  });
  afterEach(async () => { await pg.close(); });

  it('replace/usable/failedSources 语义：usable 只回 failure=\'\'；replace 删未失败行、不重置已失败行', async () => {
    await replaceSourceCandidates(sql(), 1, ['https://a.example/', 'https://b.example/']);
    expect(await usableSourceCandidates(sql(), 1)).toEqual([
      { source_url: 'https://a.example/', host: 'a.example', position: 0, failure: '' },
      { source_url: 'https://b.example/', host: 'b.example', position: 1, failure: '' },
    ]);
    // 未失败旧行整体替换：可用旧行消失，失败行保留。
    await replaceSourceCandidates(sql(), 1, ['https://c.example/']);
    expect((await usableSourceCandidates(sql(), 1)).map(row => row.host)).toEqual(['c.example']);
    // permanent：usable 不再回，failedSources 记住该 URL（补扫单源排除）。
    await markCandidateFailure(sql(), 1, 'https://c.example/', 'permanent', 'identity_mismatch_or_no_candidate');
    expect(await usableSourceCandidates(sql(), 1)).toEqual([]);
    expect(await failedCandidateSources(sql(), 1)).toEqual(new Set(['https://c.example/']));
    await replaceSourceCandidates(sql(), 1, ['https://d.example/', 'https://e.example/']);
    await markCandidateFailure(sql(), 1, 'https://d.example/', 'temporary', 'timeout');
    // temporary 同样不进 usable：recall 不重试坏源。
    expect((await usableSourceCandidates(sql(), 1)).map(row => row.host)).toEqual(['e.example']);
    expect(await failedCandidateSources(sql(), 1)).toEqual(new Set(['https://c.example/', 'https://d.example/']));
    // 再 replace 引入已失败 URL：ON CONFLICT DO NOTHING 不重置失败态；未失败的 e 被替换删除。
    await replaceSourceCandidates(sql(), 1, ['https://d.example/', 'https://f.example/']);
    expect((await usableSourceCandidates(sql(), 1)).map(row => row.host)).toEqual(['f.example']);
    expect(await failedCandidateSources(sql(), 1)).toEqual(new Set(['https://c.example/', 'https://d.example/']));
    const dRow = (await pg.query(
      `SELECT failure FROM download_source_candidates WHERE book_id = 1 AND source_url = 'https://d.example/'`,
    )).rows[0] as { failure: string };
    expect(dRow.failure).toBe('temporary');
  });

  it('下载期间候选被另一轮替换后，单源失败仍持久化且不影响同 host 其它 URL', async () => {
    await replaceSourceCandidates(sql(), 1, ['https://a.example/old']);
    await replaceSourceCandidates(sql(), 1, ['https://a.example/new', 'https://b.example/']);
    await markCandidateFailure(sql(), 1, 'https://a.example/old', 'temporary', 'missing_chapters');
    expect(await failedCandidateSources(sql(), 1)).toEqual(new Set(['https://a.example/old']));
    expect((await usableSourceCandidates(sql(), 1)).map(row => row.source_url))
      .toEqual(['https://a.example/new', 'https://b.example/']);
    await replaceSourceCandidates(sql(), 1, ['https://a.example/old', 'https://c.example/']);
    expect((await usableSourceCandidates(sql(), 1)).map(row => row.source_url)).toEqual(['https://c.example/']);
    expect(await failedCandidateSources(sql(), 1)).toEqual(new Set(['https://a.example/old']));
  });

  it('replaceSourceCandidates 事务原子性：同书事务中途失败回滚，旧候选完整保留', async () => {
    await replaceSourceCandidates(sql(), 1, ['https://old1.example/', 'https://old2.example/']);
    // 唯一冲突已被 ON CONFLICT DO NOTHING 吞掉，改用合成 DB 触发器在同书事务里制造真实失败。
    await pg.exec(`CREATE FUNCTION bsrcfix_reject_boom() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.source_url LIKE '%/boom.example%' THEN RAISE EXCEPTION 'synthetic_reject'; END IF;
        RETURN NEW;
      END; $fn$;
      CREATE TRIGGER bsrcfix_reject_boom BEFORE INSERT ON download_source_candidates
      FOR EACH ROW EXECUTE FUNCTION bsrcfix_reject_boom();`);
    await expect(replaceSourceCandidates(sql(), 1, ['https://new.example/', 'https://boom.example/']))
      .rejects.toThrow();
    // 事务回滚：已被 DELETE 的旧候选（含 position/failure）完整保留。
    expect(await usableSourceCandidates(sql(), 1)).toEqual([
      { source_url: 'https://old1.example/', host: 'old1.example', position: 0, failure: '' },
      { source_url: 'https://old2.example/', host: 'old2.example', position: 1, failure: '' },
    ]);
  });

  it('classifyFailure：identity_mismatch* ⇒ permanent，其余（含 incomplete 源级 reason）⇒ temporary', () => {
    expect(classifyFailure('identity_mismatch_or_no_candidate')).toBe('permanent');
    expect(classifyFailure('timeout')).toBe('temporary');
    expect(classifyFailure('source_unavailable')).toBe('temporary');
    expect(classifyFailure('missing_chapters')).toBe('temporary');
    expect(classifyFailure('operation_timeout')).toBe('temporary');
  });

  // covgap41 §4.4：temporary 失败记忆带 TTL（默认 48h）——过窗解禁获重试，permanent 永久。
  it('failedCandidateSources 的 temporary TTL：过窗解禁、permanent 不受影响、窗口参数可控', async () => {
    await replaceSourceCandidates(sql(), 1, ['https://a.example/', 'https://b.example/']);
    await markCandidateFailure(sql(), 1, 'https://a.example/', 'temporary', 'missing_chapters');
    await markCandidateFailure(sql(), 1, 'https://b.example/', 'permanent', 'identity_mismatch_or_no_candidate');
    // 刚失败：默认 TTL 48h 内两者都排除（既有行为不变）。
    expect(await failedCandidateSources(sql(), 1))
      .toEqual(new Set(['https://a.example/', 'https://b.example/']));
    // temporary 过窗（拨回 49h 前）⇒ 解禁；permanent 不受时间影响。
    await pg.query(`UPDATE download_source_candidates SET updated_at = now() - interval '49 hours'
      WHERE book_id = 1 AND source_url = 'https://a.example/'`);
    expect(await failedCandidateSources(sql(), 1)).toEqual(new Set(['https://b.example/']));
    // ttlMs=0 ⇒ temporary 全部即时解禁（只剩 permanent）。
    await markCandidateFailure(sql(), 1, 'https://a.example/', 'temporary', 'empty_toc_page');
    expect(await failedCandidateSources(sql(), 1, 0)).toEqual(new Set(['https://b.example/']));
    // 坏参数拒绝。
    await expect(failedCandidateSources(sql(), 1, -1)).rejects.toThrow('ttlMs is invalid');
  });

  it('tryOccupyHost 原子互斥：他实例占用 ⇒ false；过期 ⇒ 接管；释放后可再占', async () => {
    expect(await tryOccupyHost(sql(), 'a.example', 'w1', 'download', 1, 60_000)).toBe(true);
    expect(await tryOccupyHost(sql(), 'a.example', 'w2', 'download', 2, 60_000)).toBe(false);
    expect(await occupiedHosts(sql())).toEqual(new Set(['a.example']));
    await releaseHostOccupancy(sql(), 'a.example', 'w1');
    // 只释放自己的占位：w2 之前没占到，这行 DELETE 不该把别人的占位删掉。
    await releaseHostOccupancy(sql(), 'a.example', 'wrong-holder');
    expect(await tryOccupyHost(sql(), 'a.example', 'w2', 'prefetch', null, 60_000)).toBe(true);
    // 过期接管：把 w2 的占位拨过期，w1 能接管。
    await pg.query(`UPDATE download_host_occupancy SET expires_at = now() - interval '1 second' WHERE host = 'a.example'`);
    expect(await tryOccupyHost(sql(), 'a.example', 'w1', 'download', 5, 60_000)).toBe(true);
  });

  it('claimSourcePrefetch 同书互斥、过期接管、按 owner 释放', async () => {
    expect(await claimSourcePrefetch(sql(), 1, 'p1', 60_000)).toBe(true);
    expect(await claimSourcePrefetch(sql(), 1, 'p2', 60_000)).toBe(false);
    // 另一本书不受影响（先补第二本书行喂 book 外键）。
    await pg.query(`INSERT INTO labeled_books (title, author) VALUES ('另一本', '佚名')`);
    expect(await claimSourcePrefetch(sql(), 2, 'p2', 60_000)).toBe(true);
    await releaseSourcePrefetch(sql(), 1, 'p2'); // 不是自己的认领：no-op
    expect(await claimSourcePrefetch(sql(), 1, 'p2', 60_000)).toBe(false);
    await releaseSourcePrefetch(sql(), 1, 'p1');
    expect(await claimSourcePrefetch(sql(), 1, 'p2', 60_000)).toBe(true);
    // 过期接管。
    await pg.query(`UPDATE download_source_prefetch SET expires_at = now() - interval '1 second' WHERE book_id = 1`);
    expect(await claimSourcePrefetch(sql(), 1, 'p1', 60_000)).toBe(true);
  });

  it('expiresMs 非正数即拒绝（防占位永不过期的坏参数）', async () => {
    await expect(tryOccupyHost(sql(), 'a.example', 'w1', 'download', null, 0)).rejects.toThrow('expiresMs is invalid');
    await expect(claimSourcePrefetch(sql(), 1, 'p1', -1)).rejects.toThrow('expiresMs is invalid');
  });
});
