// capacity945 定点修复：内核契约草稿（**不连库**）。
//
// 消费**真实** artifact-capacity.ts：只 mock 边界（请求/事务批端口 + 完成证据端口），
// 不 mock 被测函数。覆盖 JS 侧输入校验、端口失败关闭、有序批结构、结果映射、PG 错误映射、
// 以及 F4 的 await 前不可变证据快照。SQL 内部 verdict 分支由 artifact-capacity.pglite.test.ts 向量覆盖（未运行）。
//
// 本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactCapacityError, CAPACITY_REQUIRED_ISOLATION, adoptReservation, beginPublication, capacityLeaseFrom,
  confirmPublication, releaseUnused, reserveCapacityAndPath,
  type CapacitySql, type CapacityTransactionOptions, type CompletionEvidence,
} from './artifact-capacity';

type Row = Record<string, unknown>;
const LOCK_TEXT = 'pg_advisory_xact_lock';

/**
 * 事务批端口桩：callable 标签 + transaction。transaction 记录**实际收到的选项**，
 * 按序对每条语句调用 respond，返回逐语句结果数组（首句为请求锁）。
 */
function stubSql(respond: (text: string, params: unknown[], index: number) => Row[] | Promise<Row[]>) {
  const calls: { text: string; params: unknown[] }[] = [];
  const batchOptions: CapacityTransactionOptions[] = [];
  const tag = (parts: TemplateStringsArray, ...params: unknown[]) => {
    const text = parts.reduce((acc, part, i) => acc + (i ? `$${i}` : '') + part, '');
    return { text, params };
  };
  const transaction = async (build: (tx: typeof tag) => unknown[], options: CapacityTransactionOptions) => {
    batchOptions.push(options);
    const statements = build(tag) as { text: string; params: unknown[] }[];
    const out: Row[][] = [];
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      calls.push({ text: statement.text, params: statement.params });
      out.push(await respond(statement.text, statement.params, i));
    }
    return out as unknown[];
  };
  const sql = Object.assign(tag, { transaction }) as unknown as CapacitySql;
  return { sql, calls, batchOptions };
}

/** 首句（请求锁）返回空，次句（正文）返回给定行。 */
const bodyVerdict = (rows: Row[]) => stubSql(text => (text.includes(LOCK_TEXT) ? [] : rows));
/** 首句返回空，次句抛出给定错误。 */
const bodyThrow = (error: unknown) => stubSql(text => { if (text.includes(LOCK_TEXT)) return []; throw error; });

const binding = {
  requestKey: 'req-1', labeledBookId: 1, identityKey: 'id-a', blobSha: 'a'.repeat(40),
  repositoryId: 1, branch: 'release/a', canonicalPath: 'books/x.txt', logicalBytes: 60n,
};
const lease = { taskId: 7, owner: 'service-100', generation: 3 };
const input = {
  binding, lease, accountingEpoch: 'epoch-1', admissionVersion: 'adm-1',
};
const proof: CompletionEvidence = {
  repositoryId: 1, branch: 'release/a', canonicalPath: 'books/x.txt', blobSha: 'a'.repeat(40), logicalBytes: 60n,
};

describe('input validation (system boundary)', () => {
  it('rejects malformed binding fields', async () => {
    const { sql } = bodyVerdict([]);
    await expect(reserveCapacityAndPath(sql, { ...input, binding: { ...binding, blobSha: 'xyz' } }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
    await expect(reserveCapacityAndPath(sql, { ...input, binding: { ...binding, logicalBytes: 0n } }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
    await expect(reserveCapacityAndPath(sql, { ...input, binding: { ...binding, requestKey: '' } }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
    await expect(reserveCapacityAndPath(sql, { ...input, binding: { ...binding, branch: '' } }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
  });

  it('rejects traversal paths and control characters', async () => {
    const { sql } = bodyVerdict([]);
    await expect(reserveCapacityAndPath(sql, { ...input, binding: { ...binding, canonicalPath: 'books/../secret' } }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
    await expect(reserveCapacityAndPath(sql, { ...input, binding: { ...binding, canonicalPath: 'books/x' + String.fromCharCode(9) + 'y' } }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
  });

  it('maps a real task lease shape without inventing DB columns', () => {
    expect(capacityLeaseFrom({ id: 9, leaseOwner: 'service-9', leaseGeneration: 2 }))
      .toEqual({ taskId: 9, owner: 'service-9', generation: 2 });
  });
});

describe('ordered transaction batch port (945 F1)', () => {
  it('fails closed when the injected port lacks transaction (no single-statement fallback)', async () => {
    const bareTag = (() => []) as unknown as CapacitySql;
    await expect(reserveCapacityAndPath(bareTag, input))
      .rejects.toMatchObject({ code: 'TRANSACTION_PORT_UNAVAILABLE' });
    await expect(beginPublication(bareTag, { requestKey: 'req-1', lease }))
      .rejects.toMatchObject({ code: 'TRANSACTION_PORT_UNAVAILABLE' });
    await expect(releaseUnused(bareTag, { requestKey: 'req-1', lease }))
      .rejects.toMatchObject({ code: 'TRANSACTION_PORT_UNAVAILABLE' });
    await expect(adoptReservation(bareTag, { requestKey: 'req-1', newLease: lease }))
      .rejects.toMatchObject({ code: 'TRANSACTION_PORT_UNAVAILABLE' });
  });

  it('sends the request lock as the first statement and the body second (new snapshot)', async () => {
    const { sql, calls } = bodyVerdict([{ status: 'reserved', atomic_ok: 1, reservation_id: 1 }]);
    await reserveCapacityAndPath(sql, input);
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain(LOCK_TEXT);
    expect(calls[0].params).toContain('req-1');
    expect(calls[1].text).not.toContain(LOCK_TEXT);
    expect(calls[1].text).toContain('FOR UPDATE');
  });

  it('passes the required READ COMMITTED isolation option from all five interfaces (946 F1)', async () => {
    const evidence = { confirm: async () => true };
    const run: { name: string; invoke: (sql: CapacitySql) => Promise<unknown>; row: Row }[] = [
      { name: 'reserveCapacityAndPath', row: { status: 'reserved', atomic_ok: 1, reservation_id: 1 }, invoke: s => reserveCapacityAndPath(s, input) },
      { name: 'beginPublication', row: { status: 'publishing', atomic_ok: 1 }, invoke: s => beginPublication(s, { requestKey: 'req-1', lease }) },
      { name: 'confirmPublication', row: { status: 'committed', atomic_ok: 1 }, invoke: s => confirmPublication(s, { requestKey: 'req-1', lease, publicationProof: proof, evidence }) },
      { name: 'releaseUnused', row: { status: 'released', atomic_ok: 1 }, invoke: s => releaseUnused(s, { requestKey: 'req-1', lease }) },
      { name: 'adoptReservation', row: { status: 'adopted', atomic_ok: 1 }, invoke: s => adoptReservation(s, { requestKey: 'req-1', newLease: lease }) },
    ];
    const seen: string[] = [];
    for (const entry of run) {
      const stub = bodyVerdict([entry.row]);
      await entry.invoke(stub.sql);
      expect(stub.batchOptions).toHaveLength(1);          // 每个接口恰好发起一次事务批
      expect(stub.batchOptions[0]).toBe(CAPACITY_REQUIRED_ISOLATION); // 传入的是同一必需选项对象
      expect(stub.batchOptions[0].isolationLevel).toBe('ReadCommitted');
      seen.push(entry.name);
    }
    expect(seen).toEqual([
      'reserveCapacityAndPath', 'beginPublication', 'confirmPublication', 'releaseUnused', 'adoptReservation',
    ]);
  });
});

describe('reserveCapacityAndPath result mapping', () => {
  it.each([
    ['reserved', { reservation_id: 42 }, { status: 'reserved', reservationId: 42 }],
    ['already_reserved', { existing_reservation_id: 5 }, { status: 'already_reserved', reservationId: 5 }],
    ['already_committed', {}, { status: 'already_committed' }],
    ['already_released', {}, { status: 'already_released' }],
    ['reconciliation_required', {}, { status: 'reconciliation_required' }],
    ['binding_conflict', {}, { status: 'binding_conflict' }],
    ['stale_plan', {}, { status: 'stale_plan' }],
    ['no_trusted_accounting', {}, { status: 'no_trusted_accounting' }],
    ['repository_not_writable', {}, { status: 'repository_not_writable' }],
    ['lost_lease', {}, { status: 'lost_lease' }],
  ] as const)('maps %s', async (status, extra, expected) => {
    const { sql } = bodyVerdict([{ status, atomic_ok: 1, gate_ok: 0, ...extra }]);
    await expect(reserveCapacityAndPath(sql, input)).resolves.toEqual(expected);
  });

  it('maps insufficient_capacity only when the gate wrote nothing', async () => {
    await expect(reserveCapacityAndPath(bodyVerdict([{ status: 'insufficient_capacity', atomic_ok: 1, gate_ok: 0 }]).sql, input))
      .resolves.toEqual({ status: 'insufficient_capacity' });
    await expect(reserveCapacityAndPath(bodyVerdict([{ status: 'insufficient_capacity', atomic_ok: 1, gate_ok: 1 }]).sql, input))
      .rejects.toMatchObject({ code: 'CAPACITY_INVALID_RESULT' });
  });

  it('rejects unknown status, atomic_ok!=1, zero or multiple rows', async () => {
    await expect(reserveCapacityAndPath(bodyVerdict([{ status: 'bogus', atomic_ok: 1 }]).sql, input))
      .rejects.toMatchObject({ code: 'CAPACITY_INVALID_RESULT' });
    await expect(reserveCapacityAndPath(bodyVerdict([{ status: 'stale_plan', atomic_ok: 0 }]).sql, input))
      .rejects.toMatchObject({ code: 'CAPACITY_INVALID_RESULT' });
    await expect(reserveCapacityAndPath(bodyVerdict([]).sql, input))
      .rejects.toMatchObject({ code: 'CAPACITY_INVALID_RESULT' });
    await expect(reserveCapacityAndPath(bodyVerdict([{ status: 'stale_plan', atomic_ok: 1 }, { status: 'stale_plan', atomic_ok: 1 }]).sql, input))
      .rejects.toMatchObject({ code: 'CAPACITY_INVALID_RESULT' });
  });

  it('parameterizes content into the body statement and never inlines it', async () => {
    const { sql, calls } = bodyVerdict([{ status: 'reserved', atomic_ok: 1, gate_ok: 1, reservation_id: 1 }]);
    await reserveCapacityAndPath(sql, input);
    expect(calls[1].text).not.toContain('books/x.txt');
    expect(calls[1].params).toContain('books/x.txt');
    expect(calls[1].params).toContain('a'.repeat(40));
  });

  it('maps PG constraint errors to typed errors (batch already rolled back)', async () => {
    const reject = (code: string, constraint: string) => bodyThrow(Object.assign(new Error('pg'), { code, constraint }));
    await expect(reserveCapacityAndPath(reject('23505', 'artifact_capacity_identity_active_idx').sql, input))
      .rejects.toMatchObject({ code: 'ACTIVE_IDENTITY_CONFLICT' });
    await expect(reserveCapacityAndPath(reject('23505', 'artifact_capacity_path_active_idx').sql, input))
      .rejects.toMatchObject({ code: 'ACTIVE_PATH_CONFLICT' });
    await expect(reserveCapacityAndPath(reject('23505', 'book_artifacts_path_key').sql, input))
      .rejects.toMatchObject({ code: 'ARTIFACT_PATH_COLLISION' });
    await expect(reserveCapacityAndPath(reject('23503', 'x').sql, input))
      .rejects.toMatchObject({ code: 'LABELED_BOOK_MISSING' });
    await expect(reserveCapacityAndPath(reject('23514', 'x').sql, input))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_INPUT' });
  });
});

describe('publication lifecycle result mapping', () => {
  it('begin maps states', async () => {
    for (const status of ['publishing', 'reconciliation_required', 'lost_lease', 'not_found']) {
      await expect(beginPublication(bodyVerdict([{ status, atomic_ok: 1 }]).sql, { requestKey: 'req-1', lease }))
        .resolves.toEqual({ status });
    }
  });

  it('confirm freezes an immutable evidence snapshot before any await (945 F4)', async () => {
    const callerProof: CompletionEvidence = { ...proof, blobSha: 'a'.repeat(40) };
    let seen: CompletionEvidence | undefined;
    const port = {
      confirm: vi.fn(async (evidence: CompletionEvidence) => {
        seen = evidence;
        // 端口持有该对象并异步改写：不得影响内核后续 SQL。
        evidence.blobSha = 'f'.repeat(40);
        evidence.canonicalPath = 'books/mutated.txt';
        return true;
      }),
    };
    const { sql, calls } = bodyVerdict([{ status: 'committed', atomic_ok: 1 }]);
    await expect(confirmPublication(sql, { requestKey: 'req-1', lease, publicationProof: callerProof, evidence: port }))
      .resolves.toEqual({ status: 'committed' });
    expect(seen).not.toBe(callerProof);              // 端口收到内部快照，非调用者对象
    expect(calls[1].params).toContain('a'.repeat(40)); // SQL 仍用冻结值
    expect(calls[1].params).toContain('books/x.txt');
    expect(calls[1].params).not.toContain('f'.repeat(40));
    expect(calls[1].params).not.toContain('books/mutated.txt');
  });

  it('confirm refuses unconfirmed completion', async () => {
    const port = { confirm: vi.fn(async () => false) };
    const { sql, calls } = bodyVerdict([{ status: 'reconciliation_required', atomic_ok: 1 }]);
    await expect(confirmPublication(sql, { requestKey: 'req-1', lease, publicationProof: proof, evidence: port }))
      .resolves.toEqual({ status: 'reconciliation_required' });
    expect(port.confirm).toHaveBeenCalledWith(proof);
    expect(calls[1].params).toContain(false);
  });

  it('confirm rejects a missing evidence port', async () => {
    const { sql } = bodyVerdict([]);
    await expect(confirmPublication(sql, { requestKey: 'req-1', lease, publicationProof: proof, evidence: undefined as never }))
      .rejects.toBeInstanceOf(ArtifactCapacityError);
  });

  it('release and adopt map states', async () => {
    for (const status of ['released', 'already_released', 'already_committed', 'reconciliation_required', 'lost_lease', 'not_found']) {
      await expect(releaseUnused(bodyVerdict([{ status, atomic_ok: 1 }]).sql, { requestKey: 'req-1', lease }))
        .resolves.toEqual({ status });
    }
    for (const status of ['adopted', 'reconciliation_required', 'lost_lease', 'not_found']) {
      await expect(adoptReservation(bodyVerdict([{ status, atomic_ok: 1 }]).sql, { requestKey: 'req-1', newLease: lease }))
        .resolves.toEqual({ status });
    }
  });
});
