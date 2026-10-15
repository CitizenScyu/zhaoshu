// capacity985：repository-rollover-wiring 合成测试（不发网络、不连 DB、不读环境）。
//
// 端口全部合成注入（candidate 数组 + 固定时钟）；发布侧闭包用可识别的 fake
// GitHubContents 记录 identity，断言 stay 沿用原闭包引用、switch 后 reserve/publish
// 用的闭包与 repositoryId/branch 均属新仓（防「只换 DB id」回归）。

import { describe, expect, it } from 'vitest';
import type { GitHubContents } from '../src/lib/download-publisher';
import { snapshotPaths } from '../src/lib/download-publisher';
import type { RepositoryCandidate, RepositoryTuple } from './repository-rollover';
import {
  decideRepositoryForPublication,
  RolloverWiringBlockedError,
  RolloverWiringEvidenceError,
  type RolloverEvidencePort,
} from './repository-rollover-wiring';

const NOW = new Date('2026-10-08T04:00:00.000Z');
const FUTURE = '2026-12-31T00:00:00.000Z';
const TARGET = BigInt(1_000_000_000); // 十进制 1GB
const SHA = 'a'.repeat(40);
const CURRENT: RepositoryTuple = { id: 1, owner: 'citizen', repo: 'repo-1', branch: 'main' };
const NEXT: RepositoryTuple = { id: 2, owner: 'citizen', repo: 'repo-2', branch: 'main' };

function candidate(over: {
  id: number; owner?: string; repo?: string; branch?: string;
  enabled?: boolean; readOnly?: boolean; sealed?: boolean;
  registered?: bigint; reserved?: bigint; targetBytes?: bigint;
  admissionStatus?: 'granted' | 'denied' | 'unknown';
}): RepositoryCandidate {
  const self: RepositoryTuple = {
    id: over.id, owner: over.owner ?? 'citizen', repo: over.repo ?? `repo-${over.id}`, branch: over.branch ?? 'main',
  };
  return {
    ...self,
    enabled: over.enabled ?? true,
    isPrivate: true,
    readOnly: over.readOnly ?? false,
    sealed: over.sealed ?? false,
    targetBytes: over.targetBytes ?? TARGET,
    accounting: {
      registeredLogicalBytes: over.registered ?? BigInt(0), reservedLogicalBytes: over.reserved ?? BigInt(0),
      version: 'v1', validUntil: FUTURE, target: self,
    },
    externalAdmission: {
      status: over.admissionStatus ?? 'granted', version: 'a1', validUntil: FUTURE, target: self,
    },
  };
}

function port(candidates: RepositoryCandidate[]): RolloverEvidencePort {
  return { listCandidates: async () => candidates, now: () => NOW };
}

/** 模拟发布路径在消费点之后的装配：按决策元组取闭包与 repositoryId/branch。 */
interface Closure {
  github: GitHubContents;
  repositoryId: number;
  branch: string;
}

function closureOf(tuple: RepositoryTuple): Closure {
  const github: GitHubContents = {
    // 只记录调用与归属，不真实发请求。
    put: async () => {},
    getBytes: async () => null,
    __tuple: tuple,
  } as unknown as GitHubContents & { __tuple: RepositoryTuple };
  return { github, repositoryId: tuple.id, branch: tuple.branch };
}

const wiringInput = (over: { logicalBytes?: bigint } = {}) => ({
  current: CURRENT,
  labeledBookId: 1036,
  identityKey: 'id-abc',
  blobSha: SHA,
  canonicalPath: snapshotPaths('测试书', '作者').canonicalPath,
  logicalBytes: over.logicalBytes ?? BigInt(1),
});

describe('capacity985 rollover wiring（合成端口）', () => {
  it('stay 路径：当前仓容量充足 ⇒ 沿用原仓元组，闭包引用不变', async () => {
    const candidates = [candidate({ id: 1, registered: BigInt(100) })];
    const outcome = await decideRepositoryForPublication(port(candidates), wiringInput({ logicalBytes: BigInt(1) }));
    expect(outcome).toEqual({
      kind: 'stay', target: CURRENT, snapshotVersion: 'v1',
      logicalBytesToReserve: BigInt(1), needsClosureRebuild: false,
    });
    // 消费点之后装配：stay 不重建闭包，reserve/publish 用的还是原引用。
    const before = closureOf(CURRENT);
    const after = outcome.needsClosureRebuild ? closureOf(outcome.target) : before;
    expect(after).toBe(before);
    expect(after.repositoryId).toBe(1);
  });

  it('rollover 路径：旧仓投影超限 ⇒ switch，新仓元组生效且闭包与 repositoryId 均属新仓', async () => {
    const full = candidate({ id: 1, registered: TARGET }); // 投影 TARGET+1 > TARGET
    const fresh = candidate({ id: 2 });
    const outcome = await decideRepositoryForPublication(
      port([full, fresh]), wiringInput({ logicalBytes: BigInt(1) }),
    );
    expect(outcome.kind).toBe('switch');
    if (outcome.kind !== 'switch') return;
    expect(outcome.target).toEqual(NEXT);
    expect(outcome.needsClosureRebuild).toBe(true);
    expect(outcome.snapshotVersion).toBe('v1');
    expect(outcome.logicalBytesToReserve).toBe(BigInt(1));
    // 防「只换 id」回归：重建后的闭包标记元组、repositoryId/branch 全属新仓，与旧闭包无共享。
    const oldClosure = closureOf(CURRENT);
    const newClosure = closureOf(outcome.target);
    expect(newClosure.repositoryId).toBe(2);
    expect(newClosure.branch).toBe('main');
    expect((newClosure.github as unknown as { __tuple: RepositoryTuple }).__tuple).toEqual(NEXT);
    expect((newClosure.github as unknown as { __tuple: RepositoryTuple }).__tuple)
      .not.toEqual((oldClosure.github as unknown as { __tuple: RepositoryTuple }).__tuple);
    expect(newClosure.github).not.toBe(oldClosure.github);
  });

  it('无可用新仓（唯一候选满）⇒ blocked(NO_ELIGIBLE_REPOSITORY) 上抛，不静默降级回旧仓', async () => {
    const full = candidate({ id: 1, registered: TARGET });
    await expect(
      decideRepositoryForPublication(port([full]), wiringInput({ logicalBytes: BigInt(1) })),
    ).rejects.toMatchObject({
      name: 'RolloverWiringBlockedError', code: 'ROLLOVER_WIRING_BLOCKED', reason: 'NO_ELIGIBLE_REPOSITORY',
    });
  });

  it('下一仓准入拒绝/未知 ⇒ blocked(CAPACITY_UNKNOWN)，满仓不获豁免', async () => {
    const full = candidate({ id: 1, registered: TARGET });
    const deniedNext = candidate({ id: 2, admissionStatus: 'denied' });
    await expect(
      decideRepositoryForPublication(port([full, deniedNext]), wiringInput({ logicalBytes: BigInt(1) })),
    ).rejects.toMatchObject({ reason: 'CAPACITY_UNKNOWN' });
    const unknownNext = candidate({ id: 2, admissionStatus: 'unknown' });
    await expect(
      decideRepositoryForPublication(port([full, unknownNext]), wiringInput({ logicalBytes: BigInt(1) })),
    ).rejects.toMatchObject({ reason: 'CAPACITY_UNKNOWN' });
  });

  it('证据端口故障 ⇒ RolloverWiringEvidenceError 上抛（容量未知不等于照旧写旧仓）', async () => {
    const broken: RolloverEvidencePort = {
      listCandidates: async () => { throw new Error('synthetic port failure'); },
      now: () => NOW,
    };
    await expect(decideRepositoryForPublication(broken, wiringInput())).rejects.toBeInstanceOf(RolloverWiringEvidenceError);
  });

  it('既有绑定不一致 ⇒ blocked(EXISTING_BINDING_REQUIRES_RECONCILIATION)，不改绑他仓', async () => {
    const full = candidate({ id: 1, registered: TARGET });
    const fresh = candidate({ id: 2 });
    await expect(
      decideRepositoryForPublication(port([full, fresh]), {
        ...wiringInput({ logicalBytes: BigInt(1) }),
        existingBinding: {
          labeledBookId: 1036, identityKey: 'id-abc', blobSha: SHA,
          canonicalPath: 'books/other/path/index.json', logicalBytes: BigInt(1), published: true, target: CURRENT,
        },
      }),
    ).rejects.toMatchObject({ reason: 'EXISTING_BINDING_REQUIRES_RECONCILIATION' });
  });

  it('端口返回坏证据（缺 readOnly 显式 boolean）⇒ 决策输入错误转 blocked，不产可写计划', async () => {
    const brokenCandidate = { ...candidate({ id: 1 }), readOnly: undefined } as unknown as RepositoryCandidate;
    await expect(
      decideRepositoryForPublication(port([brokenCandidate]), wiringInput()),
    ).rejects.toBeInstanceOf(RolloverWiringBlockedError);
  });

  it('stay 决策不得改写元组：owner/repo 大小写不一致的候选按证据绑定核对', async () => {
    // 注册表同仓不同大小写：纯决策的 tupleMatches 按 owner/repo 忽略大小写核对证据，
    // stay 目标必须原样回传输入 current（不把候选的大小写带出去重建闭包）。
    const sameRepoDifferingCase = candidate({ id: 1, owner: 'Citizen', repo: 'Repo-1', registered: BigInt(10) });
    const outcome = await decideRepositoryForPublication(port([sameRepoDifferingCase]), wiringInput());
    expect(outcome.kind).toBe('stay');
    if (outcome.kind !== 'stay') return;
    // 闭包工厂入参等于 current：调用方零重建，旧闭包继续用。
    expect(outcome.target).toBe(CURRENT);
    expect(outcome.needsClosureRebuild).toBe(false);
  });

  it('switch 后仍需预留：logicalBytesToReserve 与 snapshotVersion 原样透传给预留层', async () => {
    const full = candidate({ id: 1, registered: BigInt(900_000_000), reserved: BigInt(100_000_000) });
    const next = candidate({ id: 2, registered: BigInt(5), reserved: BigInt(7) });
    const outcome = await decideRepositoryForPublication(
      port([full, next]), wiringInput({ logicalBytes: BigInt(12345) }),
    );
    expect(outcome.kind).toBe('switch');
    if (outcome.kind !== 'switch') return;
    expect(outcome.logicalBytesToReserve).toBe(BigInt(12345));
    expect(outcome.snapshotVersion).toBe('v1');
    expect(outcome.target.id).toBe(2);
  });

  // covgap41 §4.8（ARTIFACT_IDENTITY_CONFLICT 阻断修复）：identity_key 唯一约束把同书落位
  // 钉在旧行的仓；切仓后的装配期 current 不再撞墙，而是被既有落位重定向回旧仓。
  it('既有 artifact 落位命中 ⇒ 决策 current 重定向到旧行的仓（stay + needsClosureRebuild）', async () => {
    const old = candidate({ id: 3, repo: 'repo-3', registered: BigInt(100) });
    const currentFull = candidate({ id: 1, registered: BigInt(900_000_000), reserved: BigInt(100_000_000) });
    const outcome = await decideRepositoryForPublication(port([currentFull, old]), {
      ...wiringInput({ logicalBytes: BigInt(1) }),
      existingArtifactBinding: {
        repositoryId: 3, branch: 'main', canonicalPath: snapshotPaths('测试书', '作者').canonicalPath,
      },
    });
    // 装配仓（id 1）明明已满，但既有落位在仓 3：重定向优先，stay 到仓 3 且须重建闭包。
    expect(outcome).toEqual({
      kind: 'stay', target: { id: 3, owner: 'citizen', repo: 'repo-3', branch: 'main' },
      snapshotVersion: 'v1', logicalBytesToReserve: BigInt(1), needsClosureRebuild: true,
    });
  });

  it('既有落位的仓不可写（sealed）⇒ 不重定向，维持缺省 current 走既有决策', async () => {
    const sealedOld = candidate({ id: 3, repo: 'repo-3', sealed: true });
    const current = candidate({ id: 1, registered: BigInt(100) });
    const outcome = await decideRepositoryForPublication(port([current, sealedOld]), {
      ...wiringInput({ logicalBytes: BigInt(1) }),
      existingArtifactBinding: {
        repositoryId: 3, branch: 'main', canonicalPath: snapshotPaths('测试书', '作者').canonicalPath,
      },
    });
    expect(outcome.kind).toBe('stay');
    if (outcome.kind !== 'stay') return;
    expect(outcome.target).toBe(CURRENT);
    expect(outcome.needsClosureRebuild).toBe(false);
  });

  it('既有落位 canonicalPath 与本次不一致 ⇒ 不重定向（对账异常留给 reserve 冲突诊断）', async () => {
    const current = candidate({ id: 1, registered: BigInt(100) });
    const outcome = await decideRepositoryForPublication(port([current]), {
      ...wiringInput({ logicalBytes: BigInt(1) }),
      existingArtifactBinding: { repositoryId: 1, branch: 'main', canonicalPath: 'books/其他路径/index.json' },
    });
    expect(outcome.kind).toBe('stay');
    if (outcome.kind !== 'stay') return;
    expect(outcome.target).toBe(CURRENT);
    expect(outcome.needsClosureRebuild).toBe(false);
  });
});
