// capacity958 清单差额预检器边界草稿（合成桩，**只写不跑**）。
//
// 诚实边界：本文件证明的是**纯函数契约**——形状校验、受控核验绑定、私有副本冻结、
// 确定性集合/差额运算、四态拒绝白名单与 activationEligible 恒 false。
// 不枚举真实 GitHub、不读真实 DB、不证明来源真实或完整。核验端口为合成桩。
//
// capacity959 定点修复草稿补充：F1 孤立 UTF-16 代理项拒绝（含合法补充平面对照）；F2 规范路径与
// 内容标识格式拒绝。
//
// 本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it } from 'vitest';
import {
  LOGICAL_TXT_SCOPE,
  previewReconciliationInventory,
  type CoverageMaterial,
  type CoverageVerification,
  type CoverageVerifier,
  type InventoryBookEntry,
  type InventoryTarget,
  type ReconciliationInventoryInput,
} from './reconcile-inventory';

const target: InventoryTarget = { repositoryId: 11, branch: 'release/a' };

const book = (canonicalPath: string, blobSha: string, logicalTxtBytes: bigint): InventoryBookEntry => ({
  canonicalPath,
  blobSha,
  logicalTxtBytes,
});

const input = (over: Partial<ReconciliationInventoryInput> = {}): ReconciliationInventoryInput => ({
  target,
  snapshotId: 'snap-1',
  coverageRef: 'cov-1',
  remoteBooks: [],
  registeredBooks: [],
  ...over,
});

/** 核验桩：给出与私有材料一致的正面完整证明。 */
const okVerifier = (): CoverageVerifier => ({
  verify: (m: CoverageMaterial): CoverageVerification => ({
    status: 'verified',
    target: m.target,
    snapshotId: m.snapshotId,
    coverageDigest: m.coverageDigest,
    logicalTxtScope: LOGICAL_TXT_SCOPE,
  }),
});

const rejecting = (reason: 'no_authoritative_source' | 'incomplete_occupancy'): CoverageVerifier => ({
  verify: () => ({ status: reason }),
});

describe('previewReconciliationInventory (no-I/O inventory delta preview)', () => {
  it('V1: proven empty inventory previews zero bytes, no paths, activationEligible=false', () => {
    const res = previewReconciliationInventory(input(), okVerifier());
    expect(res).toEqual({
      status: 'inventory_preview',
      target,
      snapshotId: 'snap-1',
      logicalTxtBytes: 0n,
      unregisteredPaths: [],
      overlapPaths: [],
      activationEligible: false,
    });
  });

  it('V1b: an unproven "empty" inventory is incomplete_occupancy, not an empty preview', () => {
    expect(previewReconciliationInventory(input(), rejecting('incomplete_occupancy'))).toEqual({
      status: 'rejected',
      reason: 'incomplete_occupancy',
    });
  });

  it('V2: a remote book absent from the registry counts once as unregistered', () => {
    const res = previewReconciliationInventory(
      input({ remoteBooks: [book('txt/a.txt', 'sha-a', 100n)] }),
      okVerifier(),
    );
    expect(res).toEqual({
      status: 'inventory_preview',
      target,
      snapshotId: 'snap-1',
      logicalTxtBytes: 100n,
      unregisteredPaths: ['txt/a.txt'],
      overlapPaths: [],
      activationEligible: false,
    });
  });

  it('V3: a registered book matching remote overlaps and is NOT double-counted', () => {
    const b = book('txt/a.txt', 'sha-a', 100n);
    const res = previewReconciliationInventory(
      input({ remoteBooks: [b], registeredBooks: [book('txt/a.txt', 'sha-a', 100n)] }),
      okVerifier(),
    );
    expect(res).toEqual({
      status: 'inventory_preview',
      target,
      snapshotId: 'snap-1',
      logicalTxtBytes: 100n, // 只计一次
      unregisteredPaths: [],
      overlapPaths: ['txt/a.txt'],
      activationEligible: false,
    });
  });

  it('V4: consistent duplicate remote rows are de-duplicated (single path, summed once)', () => {
    const b = book('txt/a.txt', 'sha-a', 100n);
    const res = previewReconciliationInventory(
      input({ remoteBooks: [b, book('txt/a.txt', 'sha-a', 100n)] }),
      okVerifier(),
    );
    expect(res).toMatchObject({
      status: 'inventory_preview',
      logicalTxtBytes: 100n,
      unregisteredPaths: ['txt/a.txt'],
      overlapPaths: [],
    });
  });

  it('V5: same path with conflicting blob or bytes is inventory_conflict', () => {
    expect(
      previewReconciliationInventory(
        input({ remoteBooks: [book('txt/a.txt', 'sha-a', 100n), book('txt/a.txt', 'sha-b', 100n)] }),
        okVerifier(),
      ),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    expect(
      previewReconciliationInventory(
        input({ remoteBooks: [book('txt/a.txt', 'sha-a', 100n), book('txt/a.txt', 'sha-a', 101n)] }),
        okVerifier(),
      ),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
  });

  it('V6: a registry row absent from the proven remote list is inventory_conflict (no dangling)', () => {
    expect(
      previewReconciliationInventory(
        input({ registeredBooks: [book('txt/x.txt', 'sha-x', 5n)] }),
        okVerifier(),
      ),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
  });

  it('V7: a registry row whose content differs from remote is inventory_conflict', () => {
    expect(
      previewReconciliationInventory(
        input({
          remoteBooks: [book('txt/a.txt', 'sha-a', 100n)],
          registeredBooks: [book('txt/a.txt', 'sha-a', 99n)],
        }),
        okVerifier(),
      ),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
  });

  it('V8: verification bound to a different target is binding_conflict', () => {
    expect(
      previewReconciliationInventory(input(), {
        verify: (m) => ({
          status: 'verified',
          target: { repositoryId: 99, branch: 'other' },
          snapshotId: m.snapshotId,
          coverageDigest: m.coverageDigest,
          logicalTxtScope: LOGICAL_TXT_SCOPE,
        }),
      }),
    ).toEqual({ status: 'rejected', reason: 'binding_conflict' });
  });

  it('V9: verification bound to a different snapshot is binding_conflict', () => {
    expect(
      previewReconciliationInventory(input(), {
        verify: (m) => ({
          status: 'verified',
          target: m.target,
          snapshotId: 'snap-other',
          coverageDigest: m.coverageDigest,
          logicalTxtScope: LOGICAL_TXT_SCOPE,
        }),
      }),
    ).toEqual({ status: 'rejected', reason: 'binding_conflict' });
  });

  it('V10: verification bound to a different coverage digest is binding_conflict', () => {
    expect(
      previewReconciliationInventory(input(), {
        verify: (m) => ({
          status: 'verified',
          target: m.target,
          snapshotId: m.snapshotId,
          coverageDigest: 'sha256:deadbeef',
          logicalTxtScope: LOGICAL_TXT_SCOPE,
        }),
      }),
    ).toEqual({ status: 'rejected', reason: 'binding_conflict' });
  });

  it('V10b: verification bound to a different logical TXT scope is binding_conflict', () => {
    expect(
      previewReconciliationInventory(input(), {
        verify: (m) => ({
          status: 'verified',
          target: m.target,
          snapshotId: m.snapshotId,
          coverageDigest: m.coverageDigest,
          logicalTxtScope: 'other-scope',
        }),
      }),
    ).toEqual({ status: 'rejected', reason: 'binding_conflict' });
  });

  it('V11: missing verifier rejects no_authoritative_source; caller-supplied completeness is not proof', () => {
    expect(previewReconciliationInventory(input(), null)).toEqual({
      status: 'rejected',
      reason: 'no_authoritative_source',
    });
    expect(previewReconciliationInventory(input(), undefined)).toEqual({
      status: 'rejected',
      reason: 'no_authoritative_source',
    });
    expect(previewReconciliationInventory(input(), {} as CoverageVerifier)).toEqual({
      status: 'rejected',
      reason: 'no_authoritative_source',
    });
  });

  it('V12: input ordering does not change the digest binding or the preview result', () => {
    const a = book('txt/a.txt', 'sha-a', 100n);
    const b = book('txt/b.txt', 'sha-b', 200n);
    const c = book('txt/c.txt', 'sha-c', 300n);
    const seen: string[] = [];
    const verifier: CoverageVerifier = {
      verify: (m) => {
        seen.push(m.coverageDigest);
        return {
          status: 'verified',
          target: m.target,
          snapshotId: m.snapshotId,
          coverageDigest: m.coverageDigest,
          logicalTxtScope: LOGICAL_TXT_SCOPE,
        };
      },
    };
    const r1 = previewReconciliationInventory(input({ remoteBooks: [a, b, c] }), verifier);
    const r2 = previewReconciliationInventory(input({ remoteBooks: [c, a, b] }), verifier);
    expect(seen[0]).toBe(seen[1]);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ unregisteredPaths: ['txt/a.txt', 'txt/b.txt', 'txt/c.txt'] });
  });

  it('V13: bigint sums beyond Number.MAX_SAFE_INTEGER stay exact', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const res = previewReconciliationInventory(
      input({ remoteBooks: [book('txt/a.txt', 'sha-a', big), book('txt/b.txt', 'sha-b', big)] }),
      okVerifier(),
    );
    expect(res).toMatchObject({ status: 'inventory_preview', logicalTxtBytes: 18_014_398_509_481_986n });
  });

  it('V14: negative/invalid byte counts and illegal shapes reject deterministically', () => {
    expect(
      previewReconciliationInventory(
        input({ remoteBooks: [book('txt/a.txt', 'sha-a', -1n)] }),
        okVerifier(),
      ),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    expect(
      previewReconciliationInventory(
        input({ remoteBooks: [{ canonicalPath: 'txt/a.txt', blobSha: 'sha-a', logicalTxtBytes: 1 } as unknown as InventoryBookEntry] }),
        okVerifier(),
      ),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    expect(
      previewReconciliationInventory(input({ remoteBooks: [book('', 'sha-a', 1n)] }), okVerifier()),
    ).toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    expect(
      previewReconciliationInventory(input({ target: { repositoryId: 0, branch: 'b' } as InventoryTarget }), okVerifier()),
    ).toEqual({ status: 'rejected', reason: 'binding_conflict' });
  });

  it('V15: mutating the port replica cannot drift the computed material or digest', () => {
    const verifier: CoverageVerifier = {
      verify: (m) => {
        try {
          (m.remoteBooks as unknown as InventoryBookEntry[]).push(book('txt/evil.txt', 'sha-evil', 999n));
        } catch {
          /* frozen copy */
        }
        try {
          (m.target as { repositoryId: number }).repositoryId = 22;
        } catch {
          /* frozen copy */
        }
        return {
          status: 'verified',
          target: { repositoryId: 11, branch: 'release/a' },
          snapshotId: m.snapshotId,
          coverageDigest: m.coverageDigest,
          logicalTxtScope: LOGICAL_TXT_SCOPE,
        };
      },
    };
    const res = previewReconciliationInventory(
      input({ remoteBooks: [book('txt/a.txt', 'sha-a', 100n)] }),
      verifier,
    );
    expect(res).toEqual({
      status: 'inventory_preview',
      target,
      snapshotId: 'snap-1',
      logicalTxtBytes: 100n,
      unregisteredPaths: ['txt/a.txt'],
      overlapPaths: [],
      activationEligible: false,
    });
  });

  it('V16: unrecognized verifier shape is incomplete_occupancy (no fifth domain state)', () => {
    expect(
      previewReconciliationInventory(input(), { verify: () => ({ status: 'whatever' } as unknown as CoverageVerification) }),
    ).toEqual({ status: 'rejected', reason: 'incomplete_occupancy' });
    expect(
      previewReconciliationInventory(input(), { verify: () => null as unknown as CoverageVerification }),
    ).toEqual({ status: 'rejected', reason: 'incomplete_occupancy' });
  });

  it('V17: verifier no_authoritative_source passes through; preview never grants activation', () => {
    expect(previewReconciliationInventory(input(), rejecting('no_authoritative_source'))).toEqual({
      status: 'rejected',
      reason: 'no_authoritative_source',
    });
    const ok = previewReconciliationInventory(input({ remoteBooks: [book('txt/a.txt', 'sha-a', 1n)] }), okVerifier());
    expect(ok.status).toBe('inventory_preview');
    expect((ok as { activationEligible: unknown }).activationEligible).toBe(false);
    expect(['initialized', 'ready', 'verified', 'granted']).not.toContain(ok.status);
  });

  // F1：孤立 UTF-16 代理项在 UTF-8 编码下折叠为 U+FFFD 致同码——必须拒绝，不产生摘要碰撞。
  it('F1a: two different isolated high surrogates in a path are both rejected (no U+FFFD collision)', () => {
    const v = okVerifier();
    expect(previewReconciliationInventory(input({ remoteBooks: [book('txt/\uD800a.txt', 'sha-a', 1n)] }), v))
      .toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    expect(previewReconciliationInventory(input({ remoteBooks: [book('txt/\uD801a.txt', 'sha-a', 1n)] }), v))
      .toEqual({ status: 'rejected', reason: 'inventory_conflict' });
  });

  it('F1b: an isolated low surrogate in a path is rejected', () => {
    expect(previewReconciliationInventory(input({ remoteBooks: [book('txt/\uDC00a.txt', 'sha-a', 1n)] }), okVerifier()))
      .toEqual({ status: 'rejected', reason: 'inventory_conflict' });
  });

  it('F1c: isolated surrogate in target branch / snapshotId / coverageRef is binding_conflict', () => {
    expect(previewReconciliationInventory(
      input({ target: { repositoryId: 11, branch: 'rel\uD800' } }), okVerifier(),
    )).toEqual({ status: 'rejected', reason: 'binding_conflict' });
    expect(previewReconciliationInventory(input({ snapshotId: 'snap\uDC00' }), okVerifier()))
      .toEqual({ status: 'rejected', reason: 'binding_conflict' });
    expect(previewReconciliationInventory(input({ coverageRef: 'cov\uD83D' }), okVerifier()))
      .toEqual({ status: 'rejected', reason: 'binding_conflict' }); // 孤立高代理
  });

  it('F1d: a valid surrogate pair (supplementary plane) is accepted and deterministic', () => {
    const p = 'txt/𝄞.txt'; // U+1D11E 保持原文
    const seen: string[] = [];
    const verifier: CoverageVerifier = {
      verify: (m) => {
        seen.push(m.coverageDigest);
        return {
          status: 'verified', target: m.target, snapshotId: m.snapshotId,
          coverageDigest: m.coverageDigest, logicalTxtScope: LOGICAL_TXT_SCOPE,
        };
      },
    };
    const r1 = previewReconciliationInventory(input({ remoteBooks: [book(p, 'sha-a', 5n)] }), verifier);
    const r2 = previewReconciliationInventory(input({ remoteBooks: [book(p, 'sha-a', 5n)] }), verifier);
    expect(seen[0]).toBe(seen[1]);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ status: 'inventory_preview', unregisteredPaths: [p] });
  });

  // F2：规范路径＝精确相对 POSIX 键。
  it('F2a: canonical path format rejects dot/parent/absolute/backslash/empty/trailing/edge-whitespace/control', () => {
    const bad = [
      '.', '..', 'txt/../a.txt', '/txt/a.txt', 'txt\\a.txt', 'txt//a.txt', 'txt/a.txt/',
      ' txt/a.txt', 'txt/a.txt ', 'txt/a.txt',
    ];
    for (const p of bad) {
      expect(previewReconciliationInventory(input({ remoteBooks: [book(p, 'sha-a', 1n)] }), okVerifier()))
        .toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    }
    expect(previewReconciliationInventory(input({ remoteBooks: [book('txt/a.txt', 'sha-a', 1n)] }), okVerifier()))
      .toMatchObject({ status: 'inventory_preview', unregisteredPaths: ['txt/a.txt'] });
  });

  // F2：内容标识＝不透明 ASCII token（字母数字及 . _ : -，至少一个字母数字）。
  it('F2b: content identifier must be a non-empty letter/digit-bearing ASCII token', () => {
    const bad = ['', '   ', 'sha a', 'sha\ta', '---', '._:-', 'shaé', 'sha'];
    for (const id of bad) {
      expect(previewReconciliationInventory(input({ remoteBooks: [book('txt/a.txt', id, 1n)] }), okVerifier()))
        .toEqual({ status: 'rejected', reason: 'inventory_conflict' });
    }
    expect(previewReconciliationInventory(input({ remoteBooks: [book('txt/a.txt', 'abc.DEF_1-2:3', 1n)] }), okVerifier()))
      .toMatchObject({ status: 'inventory_preview', unregisteredPaths: ['txt/a.txt'] });
  });
});
