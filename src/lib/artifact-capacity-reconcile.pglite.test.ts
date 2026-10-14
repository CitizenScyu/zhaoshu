// capacity960 首次对账入口**真实 SQL** 回归草稿（**未运行**）。
//
// 目的：955 仅有 mock/结构断言（SQL 文本存在性），本文件让 `reconcileInitialization` 在隔离 PGlite 上
// 消费**真实生成 SQL**（有序事务批），并读取**实际表结果**断言，而非自写等价 SQL 或 mock status。
//
// 复用既有隔离/参数绑定：fixtures/pglite-sql 的 createPGliteSql（tag + transaction，与 neon 兼容），
// 夹具建表同 artifact-capacity.pglite.test.ts（createProductionSchema + initializeArtifactSchema +
// initializeArtifactCapacitySchema）。**合成最小数据**，不改生产 schema。
//
// 来源用**合成受控桩**：明确**不证明**真实来源或外部屏障；仅验证入口消费受控返回值后的 SQL 结果。
//
// 诚实边界（本文件不冒充覆盖）：
//   - PGlite 单连接**不能**承载多连接行锁/隔离语义；**真实并发锁等待跨期限**与**未知远端结果**两项
//     仍须真实 PostgreSQL 专项，本文件不加伪并发用例、不以假 clock 冒充。“已过期许可”用例只测过期判定，
//     **不**证明锁等待后 `clock_timestamp()` 的取值时点。
//   - **proof 异常回滚**（`1 / CASE ...` 除零 → 整批回滚）**本草稿未构造/未覆盖**该路径；不为凑覆盖改真实
//     SQL 或用 mock 冒充数据库回滚，保留真实 PG 专项。
//   - 本文件为静态草稿，**未执行**（禁跑测试）；不代表测试通过。夹具忽略隔离 options，**不**证明
//     Neon/ReadCommitted 选项透传。
//
// 覆盖：1 缺账空占用→initialized（恰一 ready 行，值逐列核对）；1b registered 非零 verbatim；
//   2 缺账但许可拒绝/过期→领域拒绝、ledger 零行（无 seed）；3 匹配 uninitialized 合法首次更新、
//   旧目标/绑定不符→冲突且实际原绑定/原值不变；4 ready 同身份（许可 null/仓不可写/实时活动）→
//   already_initialized 零写、完整许可/两计数/epoch 不重置（当前许可用与旧许可不同版本/期限以暴露错误
//   续期）、异身份→冲突零写；5a 输入活动非空、5b 首次 DB reserved、5c 首次 DB uncertain（各独立、输入
//   活动为空）→拒绝、不激活、原预留状态/字节/归属不变；6 缺仓/不可写仓→repository_not_writable 零 DML；
//   7 许可规范化 null 仍能执行 SQL（不因占位符无法推断类型报错）。每例读取实际表结果。

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeArtifactSchema } from './business-schema';
import { initializeArtifactCapacitySchema } from './artifact-capacity-schema';
import {
  reconcileInitialization,
  type CurrentActivation,
  type OriginalVerification,
  type ReconciliationSource,
  type ReconcileInput,
  type VerifiedOriginalIdentity,
} from './artifact-capacity-reconcile';
import { createPGliteSql } from './fixtures/pglite-sql';
import { createProductionSchema, seedV6MemberUser } from './fixtures/production-schema';

const TARGET = { repositoryId: 1, branch: 'release/a' };
const RAW = { reconciliationVersion: 'v1', occupancyProofRef: 'proof-1', barrierRef: 'bar-1', admissionRef: 'adm-1' };
const INPUT: ReconcileInput = { target: TARGET, raw: RAW };
const SHA_A = 'a'.repeat(40);

/** 合成受控来源桩：直接以给定原始身份判定与当前许可调用 work（真实入口消费其返回值）。 */
function controlledSource(originalVerdict: OriginalVerification, activation: CurrentActivation | null): ReconciliationSource {
  return { reconcile: async (_input, work) => work(originalVerdict, activation as CurrentActivation) };
}

function original(over: Partial<VerifiedOriginalIdentity> = {}): VerifiedOriginalIdentity {
  return {
    repositoryId: 1, branch: 'release/a', logicalTxtScope: 'txt/v1',
    targetBytes: BigInt(100), registeredBytes: BigInt(0), activeReservations: [],
    reconciliationVersion: 'v1', occupancyProofDigest: 'sha:abc',
    admissionBinding: { version: 'adm-1', target: { repositoryId: 1, branch: 'release/a' } },
    barrierRef: 'bar-1', fingerprint: 'fp-1',
    ...over,
  };
}

const granted = (validUntil = '2100-01-01T00:00:00Z'): CurrentActivation => ({
  status: 'granted',
  admission: { version: 'adm-1', validUntil, target: { repositoryId: 1, branch: 'release/a' } },
});

/** 与种子旧许可(adm-1 / 2100)不同版本与期限的合法当前许可，用于暴露 ready 路径的错误续期。 */
const distinctGranted = (): CurrentActivation => ({
  status: 'granted',
  admission: { version: 'adm-9', validUntil: '2099-06-01T00:00:00Z', target: { repositoryId: 1, branch: 'release/a' } },
});

describe('reconcileInitialization: real local Postgres SQL vectors (draft, unrun)', () => {
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
      DELETE FROM storage_repositories;
      INSERT INTO storage_repositories(id,owner,repo,branch,enabled,is_private,read_only,target_bytes)
        VALUES(1,'fixture','repo-a','release/a',true,true,false,100);
    `);
    // 不预置 ledger：首例须“缺账”。
  });

  /** 直接以裸 SQL 填账（对账入口消费既有 ledger 行，不 mock 其状态）。 */
  async function seedLedger(row: {
    state: string; targetBytes?: number; registered?: number; reserved?: number; epoch?: string;
    admissionStatus?: string; admissionVersion?: string | null; validUntil?: string | null;
    admissionTarget?: object | null;
  }): Promise<void> {
    await pg.query(
      `INSERT INTO repository_capacity_ledger
         (repository_id, state, target_bytes, registered_bytes, reserved_bytes, baseline_epoch,
          admission_status, admission_version, admission_valid_until, admission_target)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [row.state, row.targetBytes ?? 100, row.registered ?? 0, row.reserved ?? 0, row.epoch ?? 'fp-1',
        row.admissionStatus ?? 'unknown', row.admissionVersion ?? null, row.validUntil ?? null,
        row.admissionTarget == null ? null : JSON.stringify(row.admissionTarget)],
    );
  }

  const ledgerRow = async (): Promise<Record<string, unknown>> =>
    (await pg.query('SELECT * FROM repository_capacity_ledger WHERE repository_id=1')).rows[0] as Record<string, unknown>;
  const ledgerCount = async (): Promise<number> =>
    Number(((await pg.query('SELECT count(*)::int AS n FROM repository_capacity_ledger')).rows[0] as Record<string, unknown>).n);

  const run = (originalVerdict: OriginalVerification, activation: CurrentActivation | null) =>
    reconcileInitialization(sql as never, controlledSource(originalVerdict, activation), INPUT);

  it('1: absent ledger + valid admission + trusted empty occupancy → initialized; exactly one ready row', async () => {
    const res = await run({ status: 'verified', original: original({ targetBytes: BigInt(100), registeredBytes: BigInt(0), fingerprint: 'fp-1' }) }, granted());
    expect(res).toEqual({ status: 'initialized' });
    expect(await ledgerCount()).toBe(1);
    const row = await ledgerRow();
    expect(row.state).toBe('ready');
    expect(Number(row.target_bytes)).toBe(100);
    expect(Number(row.registered_bytes)).toBe(0);
    expect(Number(row.reserved_bytes)).toBe(0);
    expect(row.baseline_epoch).toBe('fp-1');
    expect(row.admission_status).toBe('granted');
    expect(row.admission_version).toBe('adm-1');
    expect(row.admission_valid_until).not.toBeNull();
    expect(row.admission_target).toEqual({ repositoryId: 1, branch: 'release/a' });
  });

  it('1b: registered total is written verbatim (nonzero)', async () => {
    const res = await run({ status: 'verified', original: original({ targetBytes: BigInt(1_000_000), registeredBytes: BigInt(12345) }) }, granted());
    expect(res).toEqual({ status: 'initialized' });
    const row = await ledgerRow();
    expect(Number(row.target_bytes)).toBe(1_000_000);
    expect(Number(row.registered_bytes)).toBe(12345);
  });

  it('2: absent ledger but admission rejected / expired / absent → domain reject, ledger stays 0 rows (no seed)', async () => {
    expect(await run({ status: 'verified', original: original() }, { status: 'admission_invalid' }))
      .toEqual({ status: 'admission_invalid' });
    expect(await ledgerCount()).toBe(0);

    expect(await run({ status: 'verified', original: original() }, granted('2000-01-01T00:00:00Z')))
      .toEqual({ status: 'admission_invalid' }); // granted 但固定过去时间：只测过期域拒绝，不证明锁等待后取时点
    expect(await ledgerCount()).toBe(0);

    expect(await run({ status: 'verified', original: original() }, null))
      .toEqual({ status: 'quiescence_unproven' }); // 许可缺失 → 首次屏障未证
    expect(await ledgerCount()).toBe(0);
  });

  it('3: matching uninitialized → legal first update; drifted old target/binding → conflict, value unchanged', async () => {
    await seedLedger({ state: 'uninitialized', targetBytes: 100, epoch: 'fp-1', admissionStatus: 'unknown', admissionTarget: null });
    expect(await run({ status: 'verified', original: original({ fingerprint: 'fp-1', targetBytes: BigInt(100) }) }, granted()))
      .toEqual({ status: 'initialized' });
    let row = await ledgerRow();
    expect(row.state).toBe('ready');
    expect(Number(row.registered_bytes)).toBe(0);

    // 旧 target 漂移：不放宽，原值不变（保存调用前实际行，冲突后相等）。
    await pg.exec(`UPDATE repository_capacity_ledger SET state='uninitialized', target_bytes=999, baseline_epoch='fp-1', admission_target=NULL WHERE repository_id=1`);
    const beforeTargetDrift = await ledgerRow();
    expect(await run({ status: 'verified', original: original({ fingerprint: 'fp-1', targetBytes: BigInt(100) }) }, granted()))
      .toEqual({ status: 'binding_conflict' });
    row = await ledgerRow();
    expect(row.state).toBe('uninitialized');
    expect(Number(row.target_bytes)).toBe(999);
    expect(Number(row.target_bytes)).toBe(Number(beforeTargetDrift.target_bytes)); // 原 target 不变
    expect(row.admission_target).toEqual(beforeTargetDrift.admission_target);

    // 旧 admission_target 绑到别的目标：同样冲突，且**实际原 admission_target 不变**。
    await pg.exec(`UPDATE repository_capacity_ledger SET state='uninitialized', target_bytes=100, baseline_epoch='fp-1', admission_target='{"repositoryId":2,"branch":"release/b"}'::jsonb WHERE repository_id=1`);
    const beforeBindDrift = await ledgerRow();
    expect(await run({ status: 'verified', original: original({ fingerprint: 'fp-1', targetBytes: BigInt(100) }) }, granted()))
      .toEqual({ status: 'binding_conflict' });
    row = await ledgerRow();
    expect(row.state).toBe('uninitialized');
    expect(row.admission_target).toEqual({ repositoryId: 2, branch: 'release/b' }); // 实际原绑定值保留（未清/未改）
    expect(row.admission_target).toEqual(beforeBindDrift.admission_target);         // 与调用前相等
    expect(Number(row.target_bytes)).toBe(Number(beforeBindDrift.target_bytes));
  });

  it('4: ready same identity → already_initialized zero-write (full row preserved); diff identity → conflict', async () => {
    await seedLedger({
      state: 'ready', targetBytes: 100, registered: 60, reserved: 5, epoch: 'fp-1',
      admissionStatus: 'granted', admissionVersion: 'adm-1', validUntil: '2100-01-01T00:00:00Z',
      admissionTarget: { repositoryId: 1, branch: 'release/a' },
    });
    // DB 实时活动存在（逻辑字节 5，与账 reserved_bytes 匹配）。
    await pg.query(
      `INSERT INTO artifact_capacity_reservations
         (request_key, labeled_book_id, identity_key, blob_sha, repository_id, branch, canonical_path,
          logical_bytes, state, owner, generation, task_id)
       VALUES ('req-db', 1, 'id-db', $1, 1, 'release/a', 'books/db.txt', 5, 'reserved', 'svc', 1, 1)`,
      [SHA_A],
    );
    // 保存调用前完整账行；各 ready 同身份路径之后逐字段相等（含完整许可字段，暴露错误续期）。
    const before = await ledgerRow();
    const snapshot = (r: Record<string, unknown>) => ({
      target_bytes: Number(r.target_bytes), registered_bytes: Number(r.registered_bytes),
      reserved_bytes: Number(r.reserved_bytes), baseline_epoch: r.baseline_epoch,
      admission_status: r.admission_status, admission_version: r.admission_version,
      admission_valid_until: r.admission_valid_until, admission_target: r.admission_target,
    });
    const assertPreserved = async () => { expect(snapshot(await ledgerRow())).toEqual(snapshot(before)); };

    // (1) 当前许可缺失 + DB 实时活动：ready 同身份仍零写幂等。
    expect(await run({ status: 'verified', original: original({ fingerprint: 'fp-1' }) }, null))
      .toEqual({ status: 'already_initialized' });
    await assertPreserved();

    // (2) 仓不可写：ready 同身份仍 already_initialized（先于仓可写门）。当前许可版本/期限与旧许可不同，
    //     若实现错误续期，admission_version/valid_until 会变，assertPreserved 即失败。
    await pg.exec(`UPDATE storage_repositories SET read_only=true WHERE id=1`);
    expect(await run({ status: 'verified', original: original({ fingerprint: 'fp-1' }) }, distinctGranted()))
      .toEqual({ status: 'already_initialized' });
    await assertPreserved();

    // (3) 异身份：冲突零写，原行不变。
    await pg.exec(`UPDATE storage_repositories SET read_only=false WHERE id=1`);
    expect(await run({ status: 'verified', original: original({ fingerprint: 'fp-2' }) }, distinctGranted()))
      .toEqual({ status: 'binding_conflict' });
    await assertPreserved();
  });

  it('5a: first activation with non-empty input activity → reject, no activate (no DB activity)', async () => {
    // 输入原始活动非空（DB 无预留）。
    expect(await run(
      { status: 'verified', original: original({ activeReservations: [{ requestKey: 'req-i', state: 'reserved', logicalBytes: BigInt(3) }] }) },
      granted(),
    )).toEqual({ status: 'active_reservations_present' });
    expect(await ledgerCount()).toBe(0);
  });

  it('5b: first absent-ledger activation, input empty + DB reserved → reject, no activate, reservation intact', async () => {
    await pg.query(
      `INSERT INTO artifact_capacity_reservations
         (request_key, labeled_book_id, identity_key, blob_sha, repository_id, branch, canonical_path,
          logical_bytes, state, owner, generation, task_id)
       VALUES ('req-res', 1, 'id-res', $1, 1, 'release/a', 'books/res.txt', 7, 'reserved', 'svc', 3, 1)`,
      [SHA_A],
    );
    const before = (await pg.query(`SELECT * FROM artifact_capacity_reservations WHERE request_key='req-res'`)).rows[0] as Record<string, unknown>;
    expect(await run({ status: 'verified', original: original() }, granted()))
      .toEqual({ status: 'active_reservations_present' });
    expect(await ledgerCount()).toBe(0); // 账未激活
    const after = (await pg.query(`SELECT * FROM artifact_capacity_reservations WHERE request_key='req-res'`)).rows[0] as Record<string, unknown>;
    expect(after.state).toBe('reserved');                                     // 原状态
    expect(Number(after.logical_bytes)).toBe(Number(before.logical_bytes));   // 原逻辑字节
    expect(after.repository_id).toBe(before.repository_id);                   // 目标归属
    expect(after.branch).toBe(before.branch);
    expect(after.canonical_path).toBe(before.canonical_path);
  });

  it('5c: first absent-ledger activation, input empty + DB uncertain → reject, no activate, reservation intact', async () => {
    await pg.query(
      `INSERT INTO artifact_capacity_reservations
         (request_key, labeled_book_id, identity_key, blob_sha, repository_id, branch, canonical_path,
          logical_bytes, state, owner, generation, task_id)
       VALUES ('req-unc', 1, 'id-unc', $1, 1, 'release/a', 'books/unc.txt', 9, 'uncertain', 'svc', 4, 1)`,
      [SHA_A],
    );
    const before = (await pg.query(`SELECT * FROM artifact_capacity_reservations WHERE request_key='req-unc'`)).rows[0] as Record<string, unknown>;
    expect(await run({ status: 'verified', original: original() }, granted()))
      .toEqual({ status: 'active_reservations_present' });
    expect(await ledgerCount()).toBe(0);
    const after = (await pg.query(`SELECT * FROM artifact_capacity_reservations WHERE request_key='req-unc'`)).rows[0] as Record<string, unknown>;
    expect(after.state).toBe('uncertain');
    expect(Number(after.logical_bytes)).toBe(Number(before.logical_bytes));
    expect(after.repository_id).toBe(before.repository_id);
    expect(after.branch).toBe(before.branch);
    expect(after.canonical_path).toBe(before.canonical_path);
  });

  it('6: missing repo / unwritable repo → repository_not_writable with zero DML', async () => {
    await pg.exec(`DELETE FROM storage_repositories WHERE id=1`);
    expect(await run({ status: 'verified', original: original() }, granted()))
      .toEqual({ status: 'repository_not_writable' });
    expect(await ledgerCount()).toBe(0);

    await pg.exec(`INSERT INTO storage_repositories(id,owner,repo,branch,enabled,is_private,read_only,target_bytes)
      VALUES(1,'fixture','repo-a','release/a',true,true,true,100)`);
    expect(await run({ status: 'verified', original: original() }, granted()))
      .toEqual({ status: 'repository_not_writable' });
    expect(await ledgerCount()).toBe(0);
  });

  it('7: normalized-null admission still binds null::timestamptz and executes SQL (failed-close, no type error)', async () => {
    // 非法/缺失许可在入口规范化为 admission_invalid → 传 null 参数；SQL 含 ${v}::timestamptz 两次插值，
    // 若无法定型会抛类型错误。此处断言能执行并返回领域拒绝、ledger 零行。
    expect(await run({ status: 'verified', original: original() }, { status: 'admission_invalid' }))
      .toEqual({ status: 'admission_invalid' });
    expect(await ledgerCount()).toBe(0);
  });
});
