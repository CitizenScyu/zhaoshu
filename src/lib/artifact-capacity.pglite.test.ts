// capacity945 定点修复：真实 SQL 的隔离合成向量草稿（**未运行**）。
//
// 覆盖设计 §6.5 八组向量 + 945 定点（F3 终态绑定/adopt 代次、F4 证据不可变、F5 准入实际目标、F6 fixture 修正）。
// **本片不执行测试**；且 PGlite 为单连接，其并发/锁/隔离语义**不等于** Neon HTTP 的批取快照语义——
// 向量 1/2 的并发交错在目标库（真库）须再验证，不得据本文件通过即宣称预留已实现/已生产可用。
// 夹具经 createPGliteSql 提供 transaction，内核现**真实消费有序事务批**（首句锁、次句新快照）；单连接下不证并发。
//
// 夹具：fixtures/pglite-sql 的 createPGliteSql（tag + transaction，与 neon 兼容）；
// production-schema 建 download_tasks/labeled_books/storage_repositories 等；initializeArtifactSchema
// 建 book_artifacts；initializeArtifactCapacitySchema 建本片两表（受控对账入口未实现，测试用裸 SQL 代填 ready 账）。

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeArtifactSchema } from './business-schema';
import { initializeArtifactCapacitySchema } from './artifact-capacity-schema';
import {
  adoptReservation, beginPublication, confirmPublication, releaseUnused, reserveCapacityAndPath,
} from './artifact-capacity';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema, seedV6MemberUser } from './fixtures/production-schema';

const SHA_A = 'a'.repeat(40);
const LEASE1 = { taskId: 1, owner: 'service-1', generation: 1 };
const BINDING = {
  requestKey: 'req-1', labeledBookId: 1, identityKey: 'id-a', blobSha: SHA_A,
  repositoryId: 1, branch: 'release/a', canonicalPath: 'books/x.txt', logicalBytes: BigInt(60),
};
const INPUT = { binding: BINDING, lease: LEASE1, accountingEpoch: 'epoch-1', admissionVersion: 'adm-1' };
const PROOF = { repositoryId: 1, branch: 'release/a', canonicalPath: 'books/x.txt', blobSha: SHA_A, logicalBytes: BigInt(60) };
const expectEvidence = (ok: boolean) => ({ confirm: async () => ok });

describe('artifact capacity kernel: real local Postgres vectors (draft, unrun)', () => {
  let pg: PGlite;
  let sql: ReturnType<typeof createPGliteSql>;

  beforeAll(async () => {
    pg = new PGlite();
    sql = createPGliteSql(pg);
    await createProductionSchema(sql as never, statement => pg.exec(statement));
    await seedV6MemberUser(pg);
    await pg.exec(`INSERT INTO labeled_books(id,title,author) VALUES(1,'synthetic','author');`);
    await initializeArtifactSchema(sql as never);
    await initializeArtifactCapacitySchema(sql as never);
  }, 60_000);
  afterAll(async () => { await pg.close(); });

  beforeEach(async () => {
    await pg.exec(`
      DELETE FROM artifact_capacity_reservations;
      DELETE FROM book_artifacts;
      DELETE FROM repository_capacity_ledger;
      DELETE FROM download_tasks;
      DELETE FROM storage_repositories;
      INSERT INTO storage_repositories(id,owner,repo,branch,enabled,is_private,read_only,target_bytes)
        VALUES(1,'fixture','repo-a','release/a',true,true,false,100);
      INSERT INTO download_tasks(id,user_id,book_id,title,author,status,lease_owner,lease_generation)
        VALUES(1,1,1,'synthetic','author','running','service-1',1);
    `);
    await seedLedger();
  });

  /** 受控对账入口未实现：测试直接用裸 SQL 填 ready 权威账（生产默认 uninitialized，不能放行）。 */
  async function seedLedger(overrides: Partial<{ state: string; epoch: string; admission: string; version: string; validUntil: string; registered: number; reserved: number; target: number; githubSize: number; compressedTarget: number; admissionTarget: object | null }> = {}) {
    const row = {
      state: 'ready', epoch: 'epoch-1', admission: 'granted', version: 'adm-1',
      validUntil: '2100-01-01T00:00:00Z', registered: 0, reserved: 0, target: 100,
      githubSize: 0, compressedTarget: 1_073_741_824,
      admissionTarget: { repositoryId: 1, branch: 'release/a' } as object | null, ...overrides,
    };
    await pg.query(
      `INSERT INTO repository_capacity_ledger
         (repository_id, state, target_bytes, registered_bytes, reserved_bytes,
          github_size_bytes, target_compressed_bytes,
          baseline_epoch, admission_status, admission_version, admission_valid_until, admission_target)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (repository_id) DO UPDATE SET
         state=EXCLUDED.state, target_bytes=EXCLUDED.target_bytes,
         registered_bytes=EXCLUDED.registered_bytes, reserved_bytes=EXCLUDED.reserved_bytes,
         github_size_bytes=EXCLUDED.github_size_bytes,
         target_compressed_bytes=EXCLUDED.target_compressed_bytes,
         baseline_epoch=EXCLUDED.baseline_epoch, admission_status=EXCLUDED.admission_status,
         admission_version=EXCLUDED.admission_version, admission_valid_until=EXCLUDED.admission_valid_until,
         admission_target=EXCLUDED.admission_target`,
      [row.state, row.target, row.registered, row.reserved, row.githubSize, row.compressedTarget,
        row.epoch, row.admission, row.version, row.validUntil,
        row.admissionTarget == null ? null : JSON.stringify(row.admissionTarget)],
    );
  }

  const ledgerReserved = async () => Number(((await pg.query('SELECT reserved_bytes FROM repository_capacity_ledger WHERE repository_id=1')).rows[0] as Record<string, unknown>).reserved_bytes);

  it('vector 1: a request with insufficient remaining capacity is refused with zero writes', async () => {
    await seedLedger({ githubSize: 100, compressedTarget: 100 }); // 100 + 1 > 100 ⇒ 正好装满即不合格
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'insufficient_capacity' });
    expect(await ledgerReserved()).toBe(0);
    expect((await pg.query('SELECT count(*)::int n FROM artifact_capacity_reservations')).rows).toEqual([{ n: 0 }]);
    expect((await pg.query('SELECT count(*)::int n FROM book_artifacts')).rows).toEqual([{ n: 0 }]);
    // 余量刚好够一笔则放行（并发交错须在目标库验证）。
    await seedLedger({ githubSize: 99, compressedTarget: 100 });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toMatchObject({ status: 'reserved' });
    expect(await ledgerReserved()).toBe(60);
  });

  // repothresh44 回归：生产 id1/id2 的逻辑字节（1.92e9 / 1.00e9）早已越过旧 target_bytes=1e9，
  // 压缩 size 却只有 774 MiB / 397 MiB。本门若仍读逻辑字节，decide 判 stay 之后发布会被
  // insufficient_capacity 挡死 ⇒ 这条钉住「预留门与 decide 同口径」。
  it('vector 1b: 逻辑字节超旧 target_bytes 但压缩未满 ⇒ 仍放行（旧口径只作观测）', async () => {
    await seedLedger({
      target: 1_000_000_000, registered: 1_922_960_818, reserved: 0,
      githubSize: 774_512_640, compressedTarget: 1_073_741_824,
    });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toMatchObject({ status: 'reserved' });
    expect(await ledgerReserved()).toBe(60);
  });

  it('vector 2: re-entry strictly compares immutable binding, lease and state', async () => {
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toMatchObject({ status: 'reserved' });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toMatchObject({ status: 'already_reserved' });
    expect(await ledgerReserved()).toBe(60);
    await expect(reserveCapacityAndPath(sql as never, { ...INPUT, binding: { ...BINDING, blobSha: 'b'.repeat(40) } }))
      .resolves.toEqual({ status: 'binding_conflict' });
    await pg.exec(`UPDATE download_tasks SET lease_owner='service-2', lease_generation=2 WHERE id=1`);
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'lost_lease' });
  });

  it('vector 3: a partial write (capacity ok, path zero rows) rolls the whole batch back', async () => {
    // 预置同身份但不同路径的 book_artifacts 行：path 认领命中唯一键冲突且 WHERE 不匹配 ⇒ 0 行。
    await pg.exec(`INSERT INTO book_artifacts(labeled_book_id,identity_key,repository_id,branch,canonical_path)
      VALUES(1,'id-a',1,'release/a','books/other.txt')`);
    await expect(reserveCapacityAndPath(sql as never, INPUT)).rejects.toThrow();
    expect(await ledgerReserved()).toBe(0);
    expect((await pg.query('SELECT count(*)::int n FROM artifact_capacity_reservations')).rows).toEqual([{ n: 0 }]);
  });

  it('vector 3b: a second active reservation for the same identity is refused atomically (945 F6)', async () => {
    // F6：容量门放行两笔（seedLedger 默认 githubSize=0 对 1GiB 压缩目标），第二笔才真正进入身份排他，
    // 而非先被容量门挡下。
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toMatchObject({ status: 'reserved' });
    expect(await ledgerReserved()).toBe(60); // 第一笔占用
    // 第二笔属另一用户（user_id=2）：同 user 活动任务受 download_tasks_user_active_book_idx
    // (user_id, book_id) 部分唯一索引约束，同 user 再插先撞 23505，到不了身份排异。
    await pg.exec(`INSERT INTO download_tasks(id,user_id,book_id,title,author,status,lease_owner,lease_generation)
      VALUES(2,2,1,'synthetic','author','running','service-2',1)`);
    await expect(reserveCapacityAndPath(sql as never, {
      ...INPUT,
      binding: { ...BINDING, requestKey: 'req-2', canonicalPath: 'books/y.txt' },
      lease: { taskId: 2, owner: 'service-2', generation: 1 },
    })).rejects.toMatchObject({ code: 'ACTIVE_IDENTITY_CONFLICT' });
    expect(await ledgerReserved()).toBe(60); // 第二笔容量回滚，第一笔保留
  });

  it('vector 3c: a terminal reservation re-checks binding before returning the terminal status (945 F3)', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 });
    await confirmPublication(sql as never, { requestKey: 'req-1', lease: LEASE1, publicationProof: PROOF, evidence: expectEvidence(true) });
    // 同 requestKey 同租约但改绑定（blobSha）→ binding_conflict，不是 already_committed
    await expect(reserveCapacityAndPath(sql as never, { ...INPUT, binding: { ...BINDING, blobSha: 'b'.repeat(40) } }))
      .resolves.toEqual({ status: 'binding_conflict' });
    // 完全同绑定 → already_committed（终态精确返回，不发写许可）
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'already_committed' });
  });

  it('vector 4: begin/confirm/release are idempotent and single-transfer', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await expect(beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'publishing' });
    await expect(confirmPublication(sql as never, { requestKey: 'req-1', lease: LEASE1, publicationProof: PROOF, evidence: expectEvidence(true) }))
      .resolves.toEqual({ status: 'committed' });
    await expect(confirmPublication(sql as never, { requestKey: 'req-1', lease: LEASE1, publicationProof: PROOF, evidence: expectEvidence(true) }))
      .resolves.toEqual({ status: 'already_committed' });
    const ledger = (await pg.query('SELECT registered_bytes,reserved_bytes FROM repository_capacity_ledger WHERE repository_id=1')).rows[0] as Record<string, unknown>;
    expect(Number(ledger.registered_bytes)).toBe(60);
    expect(Number(ledger.reserved_bytes)).toBe(0);
    await expect(releaseUnused(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'already_committed' });
  });

  it('vector 4b: release only from reserved-and-never-begun, once', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await expect(releaseUnused(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'released' });
    await expect(releaseUnused(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'already_released' });
    expect(await ledgerReserved()).toBe(0);
  });

  it('vector 4c: mutating the caller proof during confirm does not change the matched target (945 F4)', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 });
    const callerProof = { ...PROOF };
    const mutatingPort = {
      confirm: async (evidence: typeof PROOF) => {
        // 端口持有往返对象并在 await 期间改写：不得影响内核 SQL 匹配。
        evidence.blobSha = 'd'.repeat(40);
        evidence.canonicalPath = 'books/other.txt';
        return true;
      },
    };
    // 若内核误用可变对象，proof_match 将失配 → reconciliation_required；冻结快照则 commit 成功。
    await expect(confirmPublication(sql as never, { requestKey: 'req-1', lease: LEASE1, publicationProof: callerProof, evidence: mutatingPort }))
      .resolves.toEqual({ status: 'committed' });
    const ledger = (await pg.query('SELECT registered_bytes,reserved_bytes FROM repository_capacity_ledger WHERE repository_id=1')).rows[0] as Record<string, unknown>;
    expect(Number(ledger.registered_bytes)).toBe(60);
    expect(Number(ledger.reserved_bytes)).toBe(0);
  });

  it('vector 5: after begin, release and unconfirmed confirm keep the reservation (no refund)', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 });
    await expect(releaseUnused(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'reconciliation_required' });
    expect(await ledgerReserved()).toBe(60);
    await expect(confirmPublication(sql as never, { requestKey: 'req-1', lease: LEASE1, publicationProof: PROOF, evidence: expectEvidence(false) }))
      .resolves.toEqual({ status: 'reconciliation_required' });
    await expect(beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'reconciliation_required' });
    expect(await ledgerReserved()).toBe(60);
  });

  it('vector 5b: a confirm proof bound to a different target does not commit', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 });
    await expect(confirmPublication(sql as never, {
      requestKey: 'req-1', lease: LEASE1, publicationProof: { ...PROOF, blobSha: 'c'.repeat(40) }, evidence: expectEvidence(true),
    })).resolves.toEqual({ status: 'reconciliation_required' });
    expect(await ledgerReserved()).toBe(60);
  });

  it('vector 6: stale epoch and invalid admission refuse with zero writes', async () => {
    await seedLedger({ epoch: 'epoch-2' });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'stale_plan' });
    await seedLedger({ validUntil: '2000-01-01T00:00:00Z' });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'no_trusted_accounting' });
    await seedLedger({ admission: 'denied' });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'no_trusted_accounting' });
    expect(await ledgerReserved()).toBe(0);
  });

  it('vector 6b: admission target must bind the actual repo/branch, not any caller JSON (945 F5)', async () => {
    await seedLedger({ admissionTarget: { repositoryId: 2, branch: 'release-b' } });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'no_trusted_accounting' });
    await seedLedger({ admissionTarget: null });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'no_trusted_accounting' });
    expect(await ledgerReserved()).toBe(0);
  });

  it('vector 7: uninitialized ledger refuses; observation columns never act as the authority', async () => {
    await seedLedger({ state: 'uninitialized' });
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toEqual({ status: 'no_trusted_accounting' });
    // 旧观测列回写 0 不得使权威账放行（此处容量本已足够，仅证明观测列不参与准入）。
    await pg.exec(`UPDATE storage_repositories SET registered_bytes=0, reserved_bytes=0 WHERE id=1`);
    await seedLedger();
    await expect(reserveCapacityAndPath(sql as never, INPUT)).resolves.toMatchObject({ status: 'reserved' });
    expect(await ledgerReserved()).toBe(60);
  });

  it('vector 8: adoption is same-task, new-generation CAS; the old owner writes nothing', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    await beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 }); // uncertain
    await pg.exec(`UPDATE download_tasks SET lease_owner='service-2', lease_generation=2 WHERE id=1`);
    const NEW = { taskId: 1, owner: 'service-2', generation: 2 };
    await expect(adoptReservation(sql as never, { requestKey: 'req-1', newLease: NEW })).resolves.toEqual({ status: 'adopted' });
    // 旧归属在接管后所有变更零写。
    await expect(beginPublication(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'lost_lease' });
    await expect(releaseUnused(sql as never, { requestKey: 'req-1', lease: LEASE1 })).resolves.toEqual({ status: 'lost_lease' });
    expect(await ledgerReserved()).toBe(60); // 接管不发许可、不退款
    // 跨任务显式拒绝，不隐式重绑（第二任务属 user 2，避开 user_active_book 唯一索引）。
    await pg.exec(`INSERT INTO download_tasks(id,user_id,book_id,title,author,status,lease_owner,lease_generation)
      VALUES(2,2,1,'synthetic','author','running','service-9',1)`);
    await expect(adoptReservation(sql as never, { requestKey: 'req-1', newLease: { taskId: 2, owner: 'service-9', generation: 1 } }))
      .resolves.toEqual({ status: 'reconciliation_required' });
  });

  it('vector 8b: adoption requires a strictly newer generation on the same task (945 F3)', async () => {
    await reserveCapacityAndPath(sql as never, INPUT);
    // 同 task 同代次仅换 owner（未增代次）→ 拒绝。
    await pg.exec(`UPDATE download_tasks SET lease_owner='service-2', lease_generation=1 WHERE id=1`);
    await expect(adoptReservation(sql as never, { requestKey: 'req-1', newLease: { taskId: 1, owner: 'service-2', generation: 1 } }))
      .resolves.toEqual({ status: 'lost_lease' });
    expect(await ledgerReserved()).toBe(60);
    // 增代次 → 显式 CAS 接管。
    await pg.exec(`UPDATE download_tasks SET lease_generation=2 WHERE id=1`);
    await expect(adoptReservation(sql as never, { requestKey: 'req-1', newLease: { taskId: 1, owner: 'service-2', generation: 2 } }))
      .resolves.toEqual({ status: 'adopted' });
  });
});
