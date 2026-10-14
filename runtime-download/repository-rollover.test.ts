// reporollover937 首片 + 939 四项定点整改的合成草稿（**未运行**）。
//
// 使用项目既有 Vitest 风格，直接调用真实纯函数，不 mock 该函数。所有向量为合成输入，
// 不连库/网络/环境/时钟（now 显式传入）。本文件是未运行草稿：不报通过数、不声称已执行。
//
// 量纲：十进制 1000000000 字节 = 1GB（非 1GiB）；字节量一律 bigint。
// blobSha：git blob sha40（40 位小写 hex），合成值取 40 个 hex 字符。

import { describe, expect, it } from 'vitest';
import {
  planRepositoryRollover,
  RepositoryRolloverInputError,
  type RepositoryCandidate,
  type RepositoryRolloverRequest,
  type RepositoryTuple,
} from './repository-rollover';

const NOW = new Date('2026-10-08T04:00:00.000Z');
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';
const TARGET = BigInt(1_000_000_000);
const SHA = 'a'.repeat(40); // 合法 git blob sha40 合成值

function tuple(id: number, repo = `repo-${id}`): RepositoryTuple {
  return { id, owner: 'citizen', repo, branch: 'main' };
}

/** 候选构造：默认证据（账目/准入）绑定到该候选自身的仓元组。 */
function candidate(over: Partial<Omit<RepositoryCandidate, 'accounting' | 'externalAdmission'>> & {
  id: number;
  accounting?: RepositoryCandidate['accounting'];
  externalAdmission?: RepositoryCandidate['externalAdmission'];
}): RepositoryCandidate {
  const t = tuple(over.id, over.repo ?? `repo-${over.id}`);
  const self = { id: over.id, owner: over.owner ?? t.owner, repo: over.repo ?? t.repo, branch: over.branch ?? t.branch };
  return {
    ...self,
    enabled: over.enabled ?? true,
    isPrivate: over.isPrivate ?? true,
    readOnly: over.readOnly ?? false,
    sealed: over.sealed ?? false,
    targetBytes: over.targetBytes ?? TARGET,
    accounting: over.accounting ?? {
      registeredLogicalBytes: BigInt(0), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: self,
    },
    externalAdmission: over.externalAdmission ?? {
      status: 'granted', version: 'a1', validUntil: FUTURE, target: self,
    },
  };
}

function request(over: Partial<RepositoryRolloverRequest> & { currentRepositoryId: number; candidates: RepositoryCandidate[] }): RepositoryRolloverRequest {
  return {
    labeledBookId: over.labeledBookId ?? 1036,
    identityKey: over.identityKey ?? 'id-abc',
    blobSha: over.blobSha ?? SHA,
    canonicalPath: over.canonicalPath ?? 'books/a/b/book.txt',
    logicalBytes: over.logicalBytes ?? BigInt(1),
    now: over.now ?? NOW,
    existingBinding: over.existingBinding,
    currentRepositoryId: over.currentRepositoryId,
    candidates: over.candidates,
  };
}

describe('reporollover937+939 planRepositoryRollover 纯决策（未运行草稿）', () => {
  it('向量1：当前未满、此次恰好达阈值 ⇒ stay，仍需预留', () => {
    const a = candidate({
      id: 1,
      accounting: { registeredLogicalBytes: BigInt(900_000_000), reservedLogicalBytes: BigInt(50_000_000), version: 'v7', validUntil: FUTURE, target: tuple(1) },
    });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(50_000_000),
    }));
    expect(plan).toEqual({
      kind: 'stay', target: { id: 1, owner: 'citizen', repo: 'repo-1', branch: 'main' },
      snapshotVersion: 'v7', logicalBytesToReserve: BigInt(50_000_000), requiresReservation: true,
    });
  });

  it('向量2：当前已到阈值 ⇒ switch 到下一合法空仓（完整目标元组）', () => {
    const a = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(1_000_000_000), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
    });
    const b = candidate({ id: 2, owner: 'citizen', repo: 'repo-2', branch: 'main' });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a, b], logicalBytes: BigInt(1),
    }));
    expect(plan).toEqual({
      kind: 'switch', target: { id: 2, owner: 'citizen', repo: 'repo-2', branch: 'main' },
      snapshotVersion: 'v1', logicalBytesToReserve: BigInt(1), requiresReservation: true,
    });
  });

  it('向量3：新内容越界且后续仓 read_only/disabled ⇒ blocked(NO_ELIGIBLE_REPOSITORY)，不回退当前仓', () => {
    const a = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(999_999_950), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
    });
    const b = candidate({ id: 2, readOnly: true });
    const c = candidate({ id: 3, enabled: false });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a, b, c], logicalBytes: BigInt(100),
    }));
    expect(plan).toEqual({ kind: 'blocked', reason: 'NO_ELIGIBLE_REPOSITORY' });
  });

  it('向量4：当前满、无下一仓 ⇒ blocked(NO_ELIGIBLE_REPOSITORY)，不回退满仓', () => {
    const a = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(1_000_000_000), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
    });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1),
    }));
    expect(plan).toEqual({ kind: 'blocked', reason: 'NO_ELIGIBLE_REPOSITORY' });
  });

  it('向量5：同内容已发布绑定在满仓 ⇒ reuse，增量 0，不换仓', () => {
    const a = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(1_000_000_000), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
    });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(12_345),
      existingBinding: {
        labeledBookId: 1036, identityKey: 'id-abc', blobSha: SHA, canonicalPath: 'books/a/b/book.txt',
        logicalBytes: BigInt(12_345), published: true, target: tuple(1),
      },
    }));
    expect(plan).toEqual({
      kind: 'reuse', target: { id: 1, owner: 'citizen', repo: 'repo-1', branch: 'main' },
      logicalBytesToReserve: BigInt(0), requiresReservation: false,
    });
  });

  it('向量6：外部准入未知 ⇒ blocked(CAPACITY_UNKNOWN)，逻辑空仓不等于外部可写', () => {
    const a = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(0), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
      externalAdmission: { status: 'unknown', version: null, validUntil: null, target: tuple(1) },
    });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1),
    }));
    expect(plan).toEqual({ kind: 'blocked', reason: 'CAPACITY_UNKNOWN' });
  });

  // ---- 939 R1：四个 boolean 状态必须显式存在且为 boolean ----
  it('R1：缺 readOnly/sealed（undefined）⇒ 抛 INVALID_INPUT，不得当 false 仍 stay', () => {
    const base = candidate({ id: 1 });
    for (const key of ['enabled', 'isPrivate', 'readOnly', 'sealed'] as const) {
      const broken = { ...base, [key]: undefined } as unknown as RepositoryCandidate;
      expect(() => planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [broken], logicalBytes: BigInt(1) })))
        .toThrow(RepositoryRolloverInputError);
    }
    // 非 boolean（字符串 'true'）同样拒绝
    const wrongType = { ...base, readOnly: 'true' } as unknown as RepositoryCandidate;
    expect(() => planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [wrongType], logicalBytes: BigInt(1) })))
      .toThrow(RepositoryRolloverInputError);
  });

  it('R1：显式 false 组合正常放行（stay）', () => {
    const a = candidate({ id: 1, enabled: true, isPrivate: true, readOnly: false, sealed: false });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1) })).kind).toBe('stay');
  });

  // ---- 939 R2：账目/准入各带仓绑定并与候选核对 ----
  it('R2：账目绑定错仓 ⇒ 不产可写计划（CAPACITY_UNKNOWN）', () => {
    const a = candidate({
      id: 1,
      accounting: { registeredLogicalBytes: BigInt(0), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(2) },
    });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1) })))
      .toEqual({ kind: 'blocked', reason: 'CAPACITY_UNKNOWN' });
  });

  it('R2：准入绑定错仓 ⇒ 不产可写计划（CAPACITY_UNKNOWN）', () => {
    const a = candidate({
      id: 1,
      externalAdmission: { status: 'granted', version: 'a1', validUntil: FUTURE, target: tuple(2) },
    });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1) })))
      .toEqual({ kind: 'blocked', reason: 'CAPACITY_UNKNOWN' });
  });

  it('R2：两类证据分别正确绑定各自仓时正常可用', () => {
    const a = candidate({ id: 1 });
    const b = candidate({ id: 2 });
    const plan = planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a, b], logicalBytes: BigInt(1) }));
    expect(plan.kind).toBe('stay');
  });

  // ---- 939 R3：existingBinding 须带 labeledBookId 且严格比较 ----
  it('R3：仅换请求书 id（绑定书 id 不同）⇒ REQUIRES_RECONCILIATION，不改绑新仓', () => {
    const a = candidate({ id: 1 });
    const b = candidate({ id: 2 });
    const plan = planRepositoryRollover(request({
      labeledBookId: 2000, currentRepositoryId: 1, candidates: [a, b], logicalBytes: BigInt(1),
      existingBinding: {
        labeledBookId: 1036, identityKey: 'id-abc', blobSha: SHA, canonicalPath: 'books/a/b/book.txt',
        logicalBytes: BigInt(1), published: true, target: tuple(1),
      },
    }));
    expect(plan).toEqual({ kind: 'blocked', reason: 'EXISTING_BINDING_REQUIRES_RECONCILIATION' });
  });

  // ---- 939 R4：blobSha 须为完整 git blob sha40 ----
  it('R4：请求 blobSha 截断/非法 ⇒ 抛 INVALID_BLOB_SHA', () => {
    const a = candidate({ id: 1 });
    for (const bad of ['a'.repeat(39), 'a'.repeat(41), SHA.toUpperCase(), 'z'.repeat(40), '']) {
      expect(() => planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1), blobSha: bad })))
        .toThrow(RepositoryRolloverInputError);
    }
  });

  it('R4：既有绑定 blobSha 截断 ⇒ 不 reuse（REQUIRES_RECONCILIATION）', () => {
    const a = candidate({ id: 1 });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1), blobSha: SHA,
      existingBinding: {
        labeledBookId: 1036, identityKey: 'id-abc', blobSha: SHA.slice(0, 8), canonicalPath: 'books/a/b/book.txt',
        logicalBytes: BigInt(1), published: true, target: tuple(1),
      },
    }));
    expect(plan).toEqual({ kind: 'blocked', reason: 'EXISTING_BINDING_REQUIRES_RECONCILIATION' });
  });

  it('R4：两端同为截断字符串不 reuse', () => {
    const a = candidate({ id: 1 });
    const short = 'a'.repeat(8);
    expect(() => planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1), blobSha: short,
    }))).toThrow(RepositoryRolloverInputError);
  });

  // ---- 既有绑定其余不一致 ----
  it('既有绑定 hash/路径/bytes 任一不一致 ⇒ REQUIRES_RECONCILIATION', () => {
    const a = candidate({ id: 1 });
    const b = candidate({ id: 2 });
    for (const binding of [
      { identityKey: 'other', blobSha: SHA, canonicalPath: 'books/a/b/book.txt', logicalBytes: BigInt(1) },
      { identityKey: 'id-abc', blobSha: '0'.repeat(40), canonicalPath: 'books/a/b/book.txt', logicalBytes: BigInt(1) },
      { identityKey: 'id-abc', blobSha: SHA, canonicalPath: 'books/x/y/book.txt', logicalBytes: BigInt(1) },
      { identityKey: 'id-abc', blobSha: SHA, canonicalPath: 'books/a/b/book.txt', logicalBytes: BigInt(2) },
    ]) {
      const plan = planRepositoryRollover(request({
        currentRepositoryId: 1, candidates: [a, b], logicalBytes: BigInt(1),
        existingBinding: { labeledBookId: 1036, ...binding, published: true, target: tuple(1) },
      }));
      expect(plan).toEqual({ kind: 'blocked', reason: 'EXISTING_BINDING_REQUIRES_RECONCILIATION' });
    }
  });

  it('未发布绑定不能 reuse：同样判为 REQUIRES_RECONCILIATION', () => {
    const a = candidate({ id: 1 });
    const plan = planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1),
      existingBinding: {
        labeledBookId: 1036, identityKey: 'id-abc', blobSha: SHA, canonicalPath: 'books/a/b/book.txt',
        logicalBytes: BigInt(1), published: false, target: tuple(1),
      },
    }));
    expect(plan).toEqual({ kind: 'blocked', reason: 'EXISTING_BINDING_REQUIRES_RECONCILIATION' });
  });

  it('账目/准入过期或仓绑定不符不能产出可写计划；未知不按 0', () => {
    const expiredAccounting = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(0), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: PAST, target: tuple(1) },
    });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [expiredAccounting], logicalBytes: BigInt(1) })))
      .toEqual({ kind: 'blocked', reason: 'CAPACITY_UNKNOWN' });
    const denied = candidate({ id: 1, externalAdmission: { status: 'denied', version: 'a1', validUntil: FUTURE, target: tuple(1) } });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [denied], logicalBytes: BigInt(1) })))
      .toEqual({ kind: 'blocked', reason: 'CAPACITY_UNKNOWN' });
    const noVersion = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(0), reservedLogicalBytes: BigInt(0), version: null, validUntil: FUTURE, target: tuple(1) },
    });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [noVersion], logicalBytes: BigInt(1) })))
      .toEqual({ kind: 'blocked', reason: 'CAPACITY_UNKNOWN' });
  });

  it('候选优先序稳定：当前满时选数组中第一个可写且足够的仓', () => {
    const a = candidate({
      id: 1, accounting: { registeredLogicalBytes: BigInt(1_000_000_000), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
    });
    const b = candidate({ id: 2, repo: 'repo-b' });
    const c = candidate({ id: 3, repo: 'repo-c' });
    const plan = planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a, b, c], logicalBytes: BigInt(1) }));
    expect(plan.kind).toBe('switch');
    expect((plan as { target: { id: number } }).target.id).toBe(2);
  });

  it('bigint 超过 Number 安全整数仍精确；负数/target=0 拒绝', () => {
    const huge = BigInt(10_000_000_000_000_000_001); // > 2^53
    const a = candidate({
      id: 1, targetBytes: huge,
      accounting: { registeredLogicalBytes: huge - BigInt(1), reservedLogicalBytes: BigInt(0), version: 'v1', validUntil: FUTURE, target: tuple(1) },
    });
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(1) })).kind).toBe('stay');
    expect(planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: BigInt(2) })).kind).toBe('blocked');
    expect(() => planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a], logicalBytes: -BigInt(1) })))
      .toThrow(RepositoryRolloverInputError);
    expect(() => planRepositoryRollover(request({
      currentRepositoryId: 1, candidates: [candidate({ id: 1, targetBytes: BigInt(0) })], logicalBytes: BigInt(1),
    }))).toThrow(RepositoryRolloverInputError);
  });

  it('候选重复/冲突身份拒绝（歧义计划）；输入不被修改', () => {
    const a = candidate({ id: 1, owner: 'citizen', repo: 'dup', branch: 'main' });
    const dup = candidate({ id: 1, owner: 'citizen', repo: 'dup', branch: 'main' });
    expect(() => planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a, dup], logicalBytes: BigInt(1) })))
      .toThrow(RepositoryRolloverInputError);
    const conflict = candidate({ id: 2, owner: 'Citizen', repo: 'DUP', branch: 'main' });
    expect(() => planRepositoryRollover(request({ currentRepositoryId: 1, candidates: [a, conflict], logicalBytes: BigInt(1) })))
      .toThrow(RepositoryRolloverInputError);

    const good = candidate({ id: 1 });
    const req = request({ currentRepositoryId: 1, candidates: [good], logicalBytes: BigInt(1) });
    const snapshot = JSON.stringify(req, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    planRepositoryRollover(req);
    expect(JSON.stringify(req, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshot);
  });
});
