// capacity986：download-worker 切仓决策消费点测试（全合成：无 PGlite、无网络、无真实凭据）。
//
// 夹具形态沿 download-worker.feedback.test.ts：vi.fn storage + 内存 GitHubContents + scripted
// adapter；rollover 注入缝用合成端口（固定候选数组 + 固定时钟）与可识别的闭包工厂。断言任务书
// 冻结的四件事：
//   a. stay ⇒ reserveArtifactPath 收到装配期 repositoryId/branch，发布沿用装配期闭包原引用；
//   b. switch ⇒ reserveArtifactPath 与 publishBookVersion 均收到新仓 repositoryId/branch/github
//      （防「只换 DB id 继续用旧仓闭包」回归）；
//   c. blocked / 证据端口故障 ⇒ 按既有失败路径上抛收口为 failed，reserveArtifactPath 零调用
//      （防降级照旧写旧仓）；
//   d. 装配期常量不被污染：一次 switch 后，后续任务仍从装配期常量重新决策（stay 回到原闭包）。

import { describe, expect, it, vi } from 'vitest';
import {
  runDownloadTask,
  type AdapterOutcome, type PublicationRolloverSeam, type SourceAdapter,
  type TaskRow, type WorkerOptions, type WorkerStorage,
} from './download-worker';
import { artifactIdentityKey } from './artifact-registry';
import type { RepositoryCandidate, RepositoryTuple } from '../../runtime-download/repository-rollover';

const NOW = new Date('2026-10-08T04:00:00.000Z');
const FUTURE = '2026-12-31T00:00:00.000Z';
const TARGET_BYTES = 1_000_000_000n; // 十进制 1GB（rollover 量纲，非 1GiB）
const CURRENT: RepositoryTuple = { id: 1, owner: 'citizen', repo: 'repo-1', branch: 'main' };
const NEXT: RepositoryTuple = { id: 2, owner: 'citizen', repo: 'repo-2', branch: 'main' };

const lease: Parameters<typeof runDownloadTask>[1] = {
  id: 7, leaseOwner: 'synthetic-worker', leaseGeneration: 3, attemptCount: 1,
};
const task: TaskRow = {
  id: 7, book_id: 1036, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'system',
};
const TXT = '合成正文';
const complete: AdapterOutcome = { kind: 'complete', txt: TXT, chaptersTotal: 1, chaptersDone: 1, charsTotal: 4 };

/** 内存 GitHubContents：按实例记录调用，供「发布闭包归属哪个仓」的身份断言。 */
class TaggedGitHub {
  files = new Map<string, string>();
  calls: { op: 'put' | 'get'; path: string }[] = [];
  constructor(readonly label: string) {}
  async put(path: string, text: string): Promise<void> {
    this.calls.push({ op: 'put', path });
    this.files.set(path, text);
  }
  async getBytes(path: string): Promise<Buffer | null> {
    this.calls.push({ op: 'get', path });
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

/** 合成候选（沿 repository-rollover-wiring.test.ts 的 candidate 形状，证据全部绑定本仓）。 */
function candidate(over: {
  id: number; registered?: bigint; reserved?: bigint; targetBytes?: bigint;
}): RepositoryCandidate {
  const self: RepositoryTuple = {
    id: over.id, owner: 'citizen', repo: `repo-${over.id}`, branch: 'main',
  };
  return {
    ...self,
    enabled: true,
    isPrivate: true,
    readOnly: false,
    sealed: false,
    targetBytes: over.targetBytes ?? TARGET_BYTES,
    accounting: {
      registeredLogicalBytes: over.registered ?? 0n, reservedLogicalBytes: over.reserved ?? 0n,
      version: 'v1', validUntil: FUTURE, target: self,
    },
    externalAdmission: {
      status: 'granted', version: 'a1', validUntil: FUTURE, target: self,
    },
  };
}

/** 注入缝：端口按调用序取候选数组（每次决策重新取数）；工厂记录重建目标。 */
function makeSeam(candidatesPerCall: readonly (readonly RepositoryCandidate[])[]) {
  const rebuilt: TaggedGitHub[] = [];
  const rebuildTargets: RepositoryTuple[] = [];
  let portCalls = 0;
  const seam: PublicationRolloverSeam = {
    port: {
      listCandidates: async () => candidatesPerCall[Math.min(portCalls++, candidatesPerCall.length - 1)],
      now: () => NOW,
    },
    current: CURRENT,
    rebuildGitHubContents: target => {
      const github = new TaggedGitHub(`rebuilt:${target.owner}/${target.repo}`);
      rebuilt.push(github);
      rebuildTargets.push(target);
      return github;
    },
  };
  return { seam, rebuilt, rebuildTargets, portCallCount: () => portCalls };
}

function fixture(seam: PublicationRolloverSeam | undefined) {
  const storage = {
    claim: vi.fn<WorkerStorage['claim']>().mockResolvedValue(null),
    taskRow: vi.fn<WorkerStorage['taskRow']>().mockResolvedValue(task),
    heartbeat: vi.fn<WorkerStorage['heartbeat']>().mockResolvedValue(true),
    progress: vi.fn<WorkerStorage['progress']>().mockResolvedValue(true),
    finish: vi.fn<WorkerStorage['finish']>().mockResolvedValue(true),
    defer: vi.fn<WorkerStorage['defer']>().mockResolvedValue(null),
    reserveArtifactPath: vi.fn<WorkerStorage['reserveArtifactPath']>().mockResolvedValue(11),
    registerArtifact: vi.fn<WorkerStorage['registerArtifact']>().mockResolvedValue('registered'),
  };
  const assembly = new TaggedGitHub('assembly:repo-1');
  const adapter: SourceAdapter = { kind: 'engine', download: async () => complete };
  const options: WorkerOptions = {
    storage, github: assembly, adapters: [adapter],
    repositoryId: CURRENT.id, branch: CURRENT.branch,
    ...(seam ? { rollover: seam } : {}),
  };
  return { storage, assembly, options, run: () => runDownloadTask(options, lease) };
}

describe('capacity986 download-worker 切仓决策消费点（合成端口）', () => {
  it('a. stay：容量充足 ⇒ reserveArtifactPath 收到装配期 repositoryId/branch，发布沿用装配期闭包原引用', async () => {
    const { seam: rolloverSeam, rebuilt } = makeSeam([[candidate({ id: 1, registered: 10n })]]);
    const { storage, assembly, run } = fixture(rolloverSeam);
    const result = await run();
    expect(result.terminal).toBe('done');
    expect(storage.reserveArtifactPath).toHaveBeenCalledTimes(1);
    expect(storage.reserveArtifactPath).toHaveBeenCalledWith({
      labeledBookId: 1036,
      identityKey: artifactIdentityKey('合成书', '合成作者'),
      repositoryId: 1, branch: 'main',
      canonicalPath: expect.any(String),
    });
    // 发布闭包 = 装配期实例（引用不变），零重建。
    expect(assembly.calls.some(call => call.op === 'put')).toBe(true);
    expect(rebuilt).toHaveLength(0);
  });

  it('b. switch：旧仓投影超限 ⇒ reserve 与 publish 均收到新仓 repositoryId/branch/github（防只换 id 回归）', async () => {
    const full = candidate({ id: 1, registered: TARGET_BYTES }); // 投影 TARGET+bytes > TARGET
    const fresh = candidate({ id: 2 });
    const { seam: rolloverSeam, rebuilt, rebuildTargets } = makeSeam([[full, fresh]]);
    const { storage, assembly, run } = fixture(rolloverSeam);
    const result = await run();
    expect(result.terminal).toBe('done');
    // DB 前置声明落到新仓主键/分支。
    expect(storage.reserveArtifactPath).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 2, branch: 'main',
    }));
    // GitHub 侧整闭包重建：工厂收到新仓元组，发布 PUT/GET 全走新实例，旧闭包零调用。
    expect(rebuildTargets).toEqual([NEXT]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].calls.some(call => call.op === 'put')).toBe(true);
    expect(rebuilt[0].calls.some(call => call.op === 'get')).toBe(true);
    expect(assembly.calls).toHaveLength(0);
  });

  it('c1. blocked（无可用新仓）⇒ 上抛收口 failed，reserveArtifactPath 与发布零调用，不降级写旧仓', async () => {
    const full = candidate({ id: 1, registered: TARGET_BYTES });
    const { seam: rolloverSeam, rebuilt } = makeSeam([[full]]);
    const { storage, assembly, run } = fixture(rolloverSeam);
    const result = await run();
    expect(result.terminal).toBe('failed');
    expect(String(result.reason)).toContain('ROLLOVER_WIRING_BLOCKED');
    expect(storage.reserveArtifactPath).not.toHaveBeenCalled();
    expect(assembly.calls).toHaveLength(0);
    expect(rebuilt).toHaveLength(0);
    expect(storage.finish).toHaveBeenCalledWith(lease, expect.objectContaining({ status: 'failed' }));
  });

  it('c2. 证据端口故障 ⇒ ROLLOVER_WIRING_EVIDENCE_UNAVAILABLE 上抛，同样零 reserve 零发布', async () => {
    const broken: PublicationRolloverSeam = {
      port: {
        listCandidates: async () => { throw new Error('synthetic port failure'); },
        now: () => NOW,
      },
      current: CURRENT,
      rebuildGitHubContents: () => { throw new Error('unexpected rebuild'); },
    };
    const { storage, assembly, run } = fixture(broken);
    const result = await run();
    expect(result.terminal).toBe('failed');
    expect(String(result.reason)).toContain('ROLLOVER_WIRING_EVIDENCE_UNAVAILABLE');
    expect(storage.reserveArtifactPath).not.toHaveBeenCalled();
    expect(assembly.calls).toHaveLength(0);
  });

  it('d. 一次 switch 后装配期常量不被污染：下一任务重新决策 stay，回到装配期闭包与 repositoryId', async () => {
    const full = candidate({ id: 1, registered: TARGET_BYTES });
    const fresh = candidate({ id: 2 });
    const { seam: rolloverSeam, rebuilt, portCallCount } = makeSeam([
      [full, fresh],                          // 第一任务：switch 到 repo-2
      [candidate({ id: 1, registered: 5n })], // 第二任务：容量已对账，stay
    ]);
    const { storage, assembly, options, run } = fixture(rolloverSeam);
    const first = await run();
    expect(first.terminal).toBe('done');
    expect(rebuilt).toHaveLength(1);
    const newGithubCallsAfterFirst = rebuilt[0].calls.length;
    const assemblyPutsAfterFirst = assembly.calls.filter(call => call.op === 'put').length;

    const second = await run();
    expect(second.terminal).toBe('done');
    // 第二次决策确实重新发生（端口被再次调用），且从装配期常量出发。
    expect(portCallCount()).toBe(2);
    // stay：reserve 回到装配期 repositoryId/branch；发布沿用装配期闭包（新增 PUT 落在原实例）。
    expect(storage.reserveArtifactPath).toHaveBeenNthCalledWith(2, expect.objectContaining({
      repositoryId: 1, branch: 'main',
    }));
    expect(assembly.calls.filter(call => call.op === 'put').length).toBeGreaterThan(assemblyPutsAfterFirst);
    // switch 期重建的新闭包在第二任务零新调用；工厂未被再次调用（无全局状态泄漏）。
    expect(rebuilt[0].calls.length).toBe(newGithubCallsAfterFirst);
    expect(rebuilt).toHaveLength(1);
    // 装配期常量本身未被改写。
    expect(options.github).toBe(assembly);
    expect(options.repositoryId).toBe(1);
    expect(options.branch).toBe('main');
  });
});
