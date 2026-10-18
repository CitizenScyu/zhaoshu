// ledgersync41：rollover 探针的「现役仓」选择。
//
// 根因：systemd 把 --current 写死成已封存的 repo1，阈值永不触发，books-3/4 永不会被建出来。
// 本文件固定判据：探针观察对象 = 台账现役仓 = decideRepositoryForPublication 在当前仓已满时会选的仓。
//
// repothresh44（2026-10-19 用户裁定「仓少一点、平衡一点」）：容量门槛由**台账逻辑字节**
// （registered+reserved+1 <= target_bytes）换成 **GitHub 压缩 pack 字节**
// （github_size_bytes+1 <= target_compressed_bytes，默认 1GiB）。故本文件的「满仓」夹具一律用
// github_size_bytes 表达；registered_bytes/reserved_bytes 降级为观测，用例改为钉住「逻辑账再满
// 也不参与门槛」。
//
// 交叉验证用例直接调 runtime-download/repository-rollover-wiring.ts 的 decideRepositoryForPublication
// （真实决策层）比对两边选出的仓，避免本脚本的判据副本与权威实现漂移。
import { describe, expect, it } from 'vitest';
import { decideRepositoryForPublication } from '../runtime-download/repository-rollover-wiring';
import type { RepositoryCandidate } from '../runtime-download/repository-rollover';
import { evaluateThreshold, parseArgs, resolveActiveRepository, selectActiveRepository, selectSuccessor } from './repo-auto-create.mjs';

const NOW = new Date('2026-10-15T00:00:00Z');
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
/** 旧逻辑口径目标：repothresh44 起只作观测。 */
const TARGET_BYTES = BigInt(1_000_000_000);
/** 新容量门槛目标：GitHub 压缩 pack 1GiB。 */
const COMPRESSED_TARGET = BigInt(1_073_741_824);
/** 85% 触发线（探针 exceeded 的边界值本身算过线）。 */
const COMPRESSED_THRESHOLD_85 = COMPRESSED_TARGET * BigInt(85) / BigInt(100);

/** storage_repositories LEFT JOIN repository_capacity_ledger 的一行（列名见 readCandidateRows 的 SQL）。 */
type LedgerRow = {
  id: number; owner: string; repo: string; branch: string;
  enabled: boolean; is_private: boolean; read_only: boolean; sealed_at: string | null;
  ledger_state: string; baseline_epoch: string;
  target_bytes: bigint; registered_bytes: bigint; reserved_bytes: bigint;
  github_size_bytes: bigint; target_compressed_bytes: bigint;
  admission_status: 'granted' | 'denied' | 'unknown'; admission_version: string;
  admission_valid_until: string | null;
  admission_target: { repositoryId: number; branch: string } | null;
};

/** 一个账目/准入都齐、压缩 size 为 0（空仓）的候选仓（各用例按需覆盖字段）。 */
const repo = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1, owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main',
  enabled: true, is_private: true, read_only: false, sealed_at: null,
  ledger_state: 'ready', baseline_epoch: 'm0001_capacity_init',
  target_bytes: TARGET_BYTES, registered_bytes: BigInt(0), reserved_bytes: BigInt(0),
  github_size_bytes: BigInt(0), target_compressed_bytes: COMPRESSED_TARGET,
  admission_status: 'granted', admission_version: 'storage_repositories_writable_v1',
  admission_valid_until: FUTURE,
  admission_target: { repositoryId: 1, branch: 'main' },
  ...over,
});

/** 「压缩口径已满」的仓：github_size_bytes 正好等于目标 ⇒ +1 就超，不合格。 */
const fullRepo = (over: Partial<LedgerRow> = {}): LedgerRow =>
  repo({ github_size_bytes: COMPRESSED_TARGET, ...over });

describe('parseArgs：现役仓来源必须显式二选一 + 压缩目标可配', () => {
  it('两源互斥，且缺省不给（不猜仓）', () => {
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B'], {})).toThrow(/--current=/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--current-from-ledger'], {}))
      .toThrow(/互斥/);
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger'], {}))
      .toMatchObject({ owner: null, repo: null, currentFromLedger: true, mode: 'dry-run' });
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r'], {}))
      .toMatchObject({ owner: 'o', repo: 'r', currentFromLedger: false });
  });

  it('旧用法向后兼容（--current/--target-bytes 仍可用、其余闸门不变）', () => {
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--apply',
      '--threshold-pct=90', '--target-bytes=2000000000'], {}))
      .toMatchObject({ owner: 'o', repo: 'r', mode: 'apply', thresholdPct: 90, targetBytes: BigInt(2_000_000_000) });
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--bogus'], {})).toThrow(/未知参数/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=noslash'], {})).toThrow(/owner\/repo/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--threshold-pct=100'], {})).toThrow(/0,100/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger', '--apply', '--dry-run'], {}))
      .toThrow(/冲突/);
  });

  // repothresh44：新参数缺省 1GiB；非正即抛（0 目标会把每轮都判成「已超」而疯狂建仓）。
  it('--compressed-target-bytes 缺省 1GiB，可覆盖，非正即抛', () => {
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger'], {}))
      .toMatchObject({ compressedTargetBytes: COMPRESSED_TARGET });
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger',
      '--compressed-target-bytes=2147483648'], {}))
      .toMatchObject({ compressedTargetBytes: BigInt(2_147_483_648) });
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger',
      '--compressed-target-bytes=0'], {})).toThrow(/compressed-target-bytes/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger',
      '--compressed-target-bytes=-1'], {})).toThrow(/compressed-target-bytes/);
  });

  it('解析结果不回显任何秘密（只有变量名）', () => {
    const parsed = parseArgs(['--database-url-env=PROD_URL', '--github-token-env=GH', '--current-from-ledger'],
      { PROD_URL: 'postgres://u:p@h/db', GH: 'ghp_secret' });
    expect(JSON.stringify({ dbEnv: parsed.dbEnv, ghEnv: parsed.ghEnv })).toBe('{"dbEnv":"PROD_URL","ghEnv":"GH"}');
  });
});

describe('selectActiveRepository：盯台账现役仓，不盯写死值', () => {
  it('核心场景：repo1 压缩已满仓 → 盯 repo2（哪怕 repo1 id 更小）', () => {
    const rows = [
      fullRepo({ id: 1, repo: 'zhaoshu-books', admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', github_size_bytes: BigInt(123), admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({
      status: 'ok',
      repository: { id: 2, repo: 'zhaoshu-books-2' },
    });
  });

  it('repo1 压缩未满且可写 → 仍是 repo1（不无谓跳仓）', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', github_size_bytes: BigInt(800_000_000), admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 1, repo: 'zhaoshu-books' } });
  });

  // repothresh44 语义钉子：逻辑账（registered+reserved）远超旧 target 也不再让仓不合格。
  it('逻辑账已超旧 target 但压缩未满 → 仍合格（旧口径此处会跳仓）', () => {
    const rows = [
      repo({ id: 1, registered_bytes: BigInt(1_850_000_000), reserved_bytes: BigInt(100_000_000),
        github_size_bytes: COMPRESSED_TARGET - BigInt(1) }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 1, repo: 'zhaoshu-books' } });
  });

  it('压缩 size 差 1 字节到目标 → 合格；正好等于目标 → 不合格（+1 语义）', () => {
    const atEdge = [repo({ id: 1, github_size_bytes: COMPRESSED_TARGET - BigInt(1) })];
    expect(selectActiveRepository(atEdge, NOW)).toMatchObject({ status: 'ok', repository: { id: 1 } });
    const exact = [repo({ id: 1, github_size_bytes: COMPRESSED_TARGET })];
    expect(selectActiveRepository(exact, NOW)).toMatchObject({ status: 'blocked', reason: 'no eligible writable repository' });
  });

  it('repo1 已封存 → 直接盯 repo2（封存优先于容量）', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', sealed_at: '2026-10-13T08:21:00Z', admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  it.each([
    ['disabled', { enabled: false }],
    ['read_only', { read_only: true }],
    ['not private', { is_private: false }],
    ['ledger 未 ready', { ledger_state: 'uninitialized' }],
    ['账目无版本', { baseline_epoch: '' }],
    ['准入 denied', { admission_status: 'denied' }],
    ['准入 unknown', { admission_status: 'unknown' }],
    ['准入无版本', { admission_version: '' }],
    ['准入已过期', { admission_valid_until: PAST }],
    ['准入期限缺失', { admission_valid_until: null }],
    ['准入未绑本仓', { admission_target: { repositoryId: 99, branch: 'main' } }],
    ['准入分支不符', { admission_target: { repositoryId: 1, branch: 'other' } }],
    ['准入目标缺失', { admission_target: null }],
  ])('%s 的仓不算现役（下一个合格仓顶上）', (_label, bad) => {
    const rows = [
      repo({ id: 1, ...(bad as Partial<LedgerRow>) }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  // 部署顺序护栏：未跑 migrations/0008 时两列不存在（驱动给 undefined）。按 0 猜 = 满仓看着无限空，
  // 探针于是永不建仓；报「无活跃可写仓」（退出码 3）又会把人引向不存在的容量问题 ⇒ 必须抛（退出码 1）。
  it.each([
    ['github_size_bytes 缺列', { github_size_bytes: undefined }],
    ['target_compressed_bytes 缺列', { target_compressed_bytes: undefined }],
    ['github_size_bytes 为 NULL', { github_size_bytes: null }],
    ['target_compressed_bytes 非法字符串', { target_compressed_bytes: 'abc' }],
  ])('%s ⇒ 抛（不按 0 猜、不判 blocked）', (_label, bad) => {
    const rows = [repo({ id: 1, ...(bad as unknown as Partial<LedgerRow>) })];
    expect(() => selectActiveRepository(rows, NOW)).toThrow(/github_size_bytes|target_compressed_bytes/);
  });

  it('压缩目标为 0（台账被写坏）⇒ 该仓不合格，不除零也不放行', () => {
    const rows = [
      repo({ id: 1, target_compressed_bytes: BigInt(0) }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  it('全仓不合格 → 失败关闭，不回退到任何一个写死仓', () => {
    const rows = [
      repo({ id: 1, sealed_at: '2026-10-13T08:21:00Z' }),
      repo({ id: 2, repo: 'zhaoshu-books-2', ledger_state: 'uninitialized' }),
    ];
    const blocked = selectActiveRepository(rows, NOW);
    expect(blocked.status).toBe('blocked');
    expect(blocked).not.toHaveProperty('repository');
  });

  it('空候选与非法时钟：空候选 blocked、非法时钟抛（不读真实时间）', () => {
    expect(selectActiveRepository([], NOW)).toMatchObject({ status: 'blocked', reason: 'no registered repositories' });
    expect(() => selectActiveRepository([repo()], new Date('nope'))).toThrow(/有效 Date/);
    expect(() => selectActiveRepository([repo()], '2026-10-15' as unknown as Date)).toThrow(/有效 Date/);
  });

  it('入参顺序不影响结果（按 id 升序，不靠数组顺序）', () => {
    const rows = [
      repo({ id: 3, repo: 'zhaoshu-books-3', admission_target: { repositoryId: 3, branch: 'main' } }),
      fullRepo({ id: 1, admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
    expect(selectActiveRepository([...rows].reverse(), NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  // 旧用例「reserved_bytes 也计入占用」在新口径下**反向**成立：逻辑占用不再决定合格性。
  it('reserved_bytes 不再计入容量门槛（仍随 accounting 返回作观测）', () => {
    const rows = [
      repo({ id: 1, registered_bytes: TARGET_BYTES - BigInt(10), reserved_bytes: BigInt(11) }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    const active = selectActiveRepository(rows, NOW);
    expect(active).toMatchObject({ status: 'ok', repository: { id: 1 } });
    if (active.status === 'ok') {
      expect(active.accounting).toMatchObject({
        registeredBytes: TARGET_BYTES - BigInt(10), reservedBytes: BigInt(11),
        githubSizeBytes: BigInt(0), targetCompressedBytes: COMPRESSED_TARGET,
      });
    }
  });
});

describe('selectSuccessor：repofix42 幂等护栏（阈值已超但备仓就绪 → 不重复建仓）', () => {
  it('有合格备仓 → 返回该备仓（main 据此 successor-ready 退出 0，不再建仓）', () => {
    const rows = [
      fullRepo({ id: 1, repo: 'zhaoshu-books', admission_target: { repositoryId: 1, branch: 'main' } }),
      fullRepo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    expect(selectSuccessor(rows, 2, NOW)).toMatchObject({ status: 'ok', repository: { id: 3, repo: 'zhaoshu-books-3' } });
  });

  // repothresh44 §4 新增：备仓合格性也按压缩口径判——逻辑空但压缩已满的仓不是备仓。
  it('压缩超 → 现役与备仓都满 ⇒ blocked（走建仓路径）；逻辑空不豁免', () => {
    const rows = [
      fullRepo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(0), reserved_bytes: BigInt(0),
        admission_target: { repositoryId: 2, branch: 'main' } }),
      fullRepo({ id: 3, repo: 'zhaoshu-books-3', registered_bytes: BigInt(0),
        admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    const outcome = selectSuccessor(rows, 2, NOW);
    expect(outcome.status).toBe('blocked');
    expect(outcome).not.toHaveProperty('repository');
  });

  // repothresh44 §4 新增：压缩未超 → 现役仓自己就还空着（探针 below-threshold，压根不进护栏）。
  it('压缩未超 → 现役仓仍合格（探针不切仓的信号来源）', () => {
    const rows = [
      repo({ id: 2, repo: 'zhaoshu-books-2', github_size_bytes: COMPRESSED_THRESHOLD_85 - BigInt(1),
        registered_bytes: TARGET_BYTES, admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
    // 唯一合格仓就是现役仓自己 ⇒ 剔除后无备仓（护栏不误判「已有备仓」）。
    expect(selectSuccessor(rows, 2, NOW).status).toBe('blocked');
  });

  it('无备仓 → blocked（走建仓路径的信号）：剔除现役行后其余全不合格', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', sealed_at: '2026-10-13T08:21:00Z', admission_target: { repositoryId: 1, branch: 'main' } }),
      fullRepo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', ledger_state: 'uninitialized', admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    const outcome = selectSuccessor(rows, 2, NOW);
    expect(outcome.status).toBe('blocked');
    expect(outcome).not.toHaveProperty('repository');
  });

  it('现役行是唯一合格仓时也绝不回选它自己（剔除语义是护栏存在的意义）', () => {
    const rows = [repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } })];
    expect(selectSuccessor(rows, 2, NOW).status).toBe('blocked');
  });

  it('activeRepositoryId 非法 → 抛错失败关闭；剔除后空候选 → blocked', () => {
    expect(() => selectSuccessor([repo()], 0, NOW)).toThrow(/activeRepositoryId/);
    expect(() => selectSuccessor([repo()], -1, NOW)).toThrow(/activeRepositoryId/);
    expect(() => selectSuccessor([repo()], Number.NaN, NOW)).toThrow(/activeRepositoryId/);
    expect(selectSuccessor([], 1, NOW)).toMatchObject({ status: 'blocked', reason: 'no registered repositories' });
  });
});

describe('与权威决策层交叉验证：探针盯的仓 = decide 在当前仓满时会选的仓', () => {
  /** 把 ledger 行装配成 decideRepositoryForPublication 的候选（同 runtime-download/entry.ts 的口径）。 */
  const toCandidate = (row: LedgerRow): RepositoryCandidate => {
    const tuple = { id: Number(row.id), owner: row.owner, repo: row.repo, branch: row.branch };
    // jsonb 里的 admission_target 先按 entry.ts 核「绑本仓」，核过才把完整元组当外部准入证据。
    const bound = row.admission_target;
    if (bound == null || Number(bound.repositoryId) !== tuple.id || bound.branch !== tuple.branch) {
      throw new Error(`admission_target does not bind repository ${tuple.id}`);
    }
    return {
      ...tuple,
      enabled: row.enabled, isPrivate: row.is_private, readOnly: row.read_only,
      sealed: row.sealed_at !== null && row.sealed_at !== undefined,
      targetBytes: BigInt(row.target_bytes),
      targetCompressedBytes: BigInt(row.target_compressed_bytes),
      githubSizeBytes: BigInt(row.github_size_bytes),
      accounting: {
        registeredLogicalBytes: BigInt(row.registered_bytes),
        reservedLogicalBytes: BigInt(row.reserved_bytes),
        version: row.baseline_epoch, validUntil: row.admission_valid_until, target: tuple,
      },
      externalAdmission: {
        status: row.admission_status, version: row.admission_version,
        validUntil: row.admission_valid_until, target: tuple,
      },
    };
  };

  const decideTarget = async (rows: LedgerRow[], currentId: number, logicalBytes: bigint) => {
    const outcome = await decideRepositoryForPublication(
      { listCandidates: async () => rows.map(toCandidate), now: () => NOW },
      {
        current: toCandidate(rows.find((r: LedgerRow) => Number(r.id) === currentId) ?? rows[0]),
        labeledBookId: 1, identityKey: 'k', blobSha: 'a'.repeat(40),
        canonicalPath: 'books/x/1.txt', logicalBytes,
      },
    );
    return outcome.target.id;
  };

  it('repo1 压缩已满 + 本次还要写 1 字节：decide 切到 repo2，探针也盯 repo2', async () => {
    const rows = [
      fullRepo({ id: 1, repo: 'zhaoshu-books', admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(await decideTarget(rows, 1, BigInt(1))).toBe(2);
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  it('repo1 压缩还有余量：两边都留在 repo1（逻辑账已满也不跳仓）', async () => {
    const rows = [
      // 逻辑账（registered=target）在旧口径下已满，压缩只 800MB ⇒ 新口径两边都留 repo1。
      repo({ id: 1, repo: 'zhaoshu-books', registered_bytes: TARGET_BYTES, github_size_bytes: BigInt(800_000_000),
        admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(await decideTarget(rows, 1, BigInt(1_000_000))).toBe(1);
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 1 } });
  });

  it('repo1 封存、repo2 压缩已满：decide 切到 repo3，探针也盯 repo3', async () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', sealed_at: '2026-10-13T08:21:00Z', admission_target: { repositoryId: 1, branch: 'main' } }),
      fullRepo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    expect(await decideTarget(rows, 1, BigInt(1))).toBe(3);
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 3 } });
  });
});

describe('evaluateThreshold：单一口径 = GitHub 压缩 pack 字节（repothresh44）', () => {
  /** 只判定（legacy --current= 形态：无台账账目）。 */
  const judge = (sizeKib: number, compressedTargetBytes = COMPRESSED_TARGET, thresholdPct = 85) =>
    evaluateThreshold({ thresholdPct, sizeKib, compressedTargetBytes, accounting: null });
  /** 现役形态：带台账账目，判定仍是压缩口径，账目只进 observation。 */
  const withLedger = (over: {
    sizeKib?: number; registeredBytes?: bigint; reservedBytes?: bigint; targetBytes?: bigint;
    githubSizeBytes?: bigint; compressedTargetBytes?: bigint; thresholdPct?: number;
  } = {}) => {
    const compressedTargetBytes = over.compressedTargetBytes ?? COMPRESSED_TARGET;
    return evaluateThreshold({
      thresholdPct: over.thresholdPct ?? 85,
      sizeKib: over.sizeKib ?? 0,
      compressedTargetBytes,
      accounting: {
        registeredBytes: over.registeredBytes ?? BigInt(0),
        reservedBytes: over.reservedBytes ?? BigInt(0),
        targetBytes: over.targetBytes ?? TARGET_BYTES,
        githubSizeBytes: over.githubSizeBytes ?? BigInt(0),
        targetCompressedBytes: compressedTargetBytes,
      },
    });
  };

  it('边界方向是 >=（阈值本身算过线）：小目标下逐字节可核', () => {
    // 1GiB×85% 不是 1024 的整数倍，KiB 粒度上取不到恰好相等；用 100KiB 目标把边界钉死。
    const target = BigInt(102_400); // 100 KiB
    const threshold = target * BigInt(85) / BigInt(100); // 87040 B = 85 KiB
    expect(judge(85, target).thresholdCompressedBytes).toBe(threshold);
    expect(judge(84, target).exceeded).toBe(false);
    expect(judge(85, target).exceeded).toBe(true);
    expect(judge(86, target).exceeded).toBe(true);
  });

  it('1GiB×85% = 912,680,550 B：触发线两侧翻转（sizeKib 891,289 / 891,290）', () => {
    expect(judge(891_289).thresholdCompressedBytes).toBe(BigInt(912_680_550));
    expect(judge(891_289).exceeded).toBe(false);
    expect(judge(891_290).exceeded).toBe(true); // 891290×1024 = 912,680,960 >= 912,680,550
  });

  it('books-2 现场量级（压缩 388,204 KiB / 逻辑 1,000,307,484 B）：新口径不建仓、旧口径已超线', () => {
    const v = withLedger({ sizeKib: 388_204, registeredBytes: BigInt(1_000_307_484), githubSizeBytes: BigInt(397_520_896) });
    expect(v.metric).toBe('github-size');
    expect(v.exceeded).toBe(false); // 这正是本改动要阻止的过早切仓
    expect(v.compressedBytes).toBe(BigInt(397_520_896));
    // 对照：旧逻辑口径在同一时刻已经过线（850,000,000）——只进日志，不改判定。
    expect(v.observation).toMatchObject({
      usedLogicalBytes: BigInt(1_000_307_484), thresholdLogicalBytes: BigInt(850_000_000),
      logicalExceeded: true, ledgerGithubSizeBytes: BigInt(397_520_896),
      ledgerTargetCompressedBytes: COMPRESSED_TARGET,
    });
  });

  it('反向对照：压缩已超线但逻辑账很小 ⇒ 仍建仓（判定只看压缩）', () => {
    const v = withLedger({ sizeKib: 891_290, registeredBytes: BigInt(100_000_000) });
    expect(v.exceeded).toBe(true);
    expect(v.observation?.logicalExceeded).toBe(false);
  });

  it('目标取自入参（不取默认）：同 sizeKib 在 2GiB 目标下不过线', () => {
    expect(judge(891_290, BigInt(2_147_483_648)).exceeded).toBe(false);
    expect(judge(891_290, COMPRESSED_TARGET).exceeded).toBe(true);
  });

  it('thresholdPct 继续作用于压缩目标（90% 触发线更高）', () => {
    expect(judge(943_718, COMPRESSED_TARGET, 90).thresholdCompressedBytes)
      .toBe(COMPRESSED_TARGET * BigInt(90) / BigInt(100)); // 966,367,641
    expect(judge(943_718, COMPRESSED_TARGET, 90).exceeded).toBe(false); // 966,367,232 < 966,367,641
    expect(judge(943_719, COMPRESSED_TARGET, 90).exceeded).toBe(true);
  });

  it('legacy 形态（accounting=null）：observation 为 null，判定照常', () => {
    const v = judge(891_290);
    expect(v.observation).toBeNull();
    expect(v).toMatchObject({ metric: 'github-size', exceeded: true, sizeKib: 891_290 });
  });

  it('sizeKib 非法（负/小数/NaN/非数）→ 抛，不按 0 猜（0 会让满仓看起来空）', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '900' as unknown as number, null as unknown as number]) {
      expect(() => judge(bad)).toThrow(/sizeKib/);
    }
  });

  it('压缩目标非正 / thresholdPct 越界 → 抛（失败关闭）', () => {
    expect(() => judge(1, BigInt(0))).toThrow(/compressedTargetBytes/);
    expect(() => judge(1, -BigInt(1))).toThrow(/compressedTargetBytes/);
    expect(() => judge(1, COMPRESSED_TARGET, 0)).toThrow(/thresholdPct/);
    expect(() => judge(1, COMPRESSED_TARGET, 100)).toThrow(/thresholdPct/);
    expect(() => judge(1, COMPRESSED_TARGET, Number.NaN)).toThrow(/thresholdPct/);
  });

  it('observation 是纯观测：逻辑目标非正也不抛（观测值不该让探针失败关闭）', () => {
    const v = withLedger({ sizeKib: 10, targetBytes: BigInt(0) });
    expect(v.exceeded).toBe(false);
    expect(v.observation).toMatchObject({ thresholdLogicalBytes: null, logicalExceeded: null });
  });
});

describe('resolveActiveRepository（PGlite 真表）', () => {
  // 纯函数测不到列名/LEFT JOIN 写错，故用真表跑一次真实 SQL（合成数据，不触生产）。
  it('按 id 升序读全表候选，选第一个仍可写且压缩未满的仓；门槛目标取每仓自己的台账列', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { initializeArtifactSchema } = await import('../src/lib/business-schema');
    const { initializeArtifactCapacitySchema } = await import('../src/lib/artifact-capacity-schema');
    const { createPGliteSql } = await import('../src/lib/fixtures/pglite-sql');
    const { createProductionSchema, seedV6MemberUser } = await import('../src/lib/fixtures/production-schema');
    const pg = new PGlite();
    const sql = createPGliteSql(pg);
    await createProductionSchema(sql as never, statement => pg.exec(statement));
    await seedV6MemberUser(pg);
    await pg.exec(`INSERT INTO labeled_books(id,title,author) VALUES(1,'synthetic','author');`);
    await initializeArtifactSchema(sql as never);
    await initializeArtifactCapacitySchema(sql as never);
    // repo1 已封存；repo2 在用（逻辑账 1.85G 已超旧 target；压缩 1,024,000,000 B **已超
    // 缺省 1GiB 目标的 85%**，但它自己的台账目标是 5GiB ⇒ 仍未满）；repo3 空着。
    // ⇒ 现役仓必须是 repo2，且判定用的是 repo2 那一行的 target_compressed_bytes，不是 --compressed-target-bytes。
    await pg.exec(`
      INSERT INTO storage_repositories(id,owner,repo,branch,enabled,is_private,read_only,sealed_at,target_bytes)
        VALUES(1,'fixture','repo-a','main',true,true,false,'2026-10-13T08:21:00Z',1000000000),
              (2,'fixture','repo-b','main',true,true,false,NULL,1000000000),
              (3,'fixture','repo-c','main',true,true,false,NULL,1000000000);
      INSERT INTO repository_capacity_ledger
        (repository_id,state,target_bytes,registered_bytes,reserved_bytes,
         github_size_bytes,target_compressed_bytes,baseline_epoch,
         admission_status,admission_version,admission_valid_until,admission_target)
        VALUES
          (1,'ready',1000000000,1850000000,0,1073741824,1073741824,'epoch-1','granted','v1',NOW()+INTERVAL '30 days','{"repositoryId":1,"branch":"main"}'),
          (2,'ready',1000000000,1850000000,0,1024000000,5368709120,'epoch-1','granted','v1',NOW()+INTERVAL '30 days','{"repositoryId":2,"branch":"main"}'),
          (3,'ready',1000000000,0,0,0,1073741824,'epoch-1','granted','v1',NOW()+INTERVAL '30 days','{"repositoryId":3,"branch":"main"}');
    `);
    const active = await resolveActiveRepository(sql, NOW);
    expect(active).toMatchObject({ status: 'ok', repository: { id: 2, repo: 'repo-b', branch: 'main' } });
    // accounting 是压缩口径判定的输入来源，必须真表跑出来（不是 cfg 默认值）；逻辑三列同在（观测）。
    if (active.status === 'ok') {
      expect(active.accounting).toEqual({
        registeredBytes: BigInt(1_850_000_000), reservedBytes: BigInt(0), targetBytes: BigInt(1_000_000_000),
        githubSizeBytes: BigInt(1_024_000_000), targetCompressedBytes: BigInt(5_368_709_120),
      });
      const accounting = active.accounting;
      // 每仓用自己的 target_compressed_bytes：1,000,000 KiB = 1,024,000,000 B < 85%×5GiB ⇒ 不建仓。
      const own = evaluateThreshold({ thresholdPct: 85, sizeKib: 1_000_000, compressedTargetBytes: accounting.targetCompressedBytes, accounting });
      expect(own.exceeded).toBe(false);
      expect(own.thresholdCompressedBytes).toBe(BigInt(4_563_402_752));
      expect(own.observation?.ledgerTargetCompressedBytes).toBe(BigInt(5_368_709_120));
      // 反例护栏：同一 sizeKib 若误用 --compressed-target-bytes 的缺省 1GiB 就会判过线（会无谓建仓），
      // 证明「取台账列」不是等价写法而是必需。
      expect(evaluateThreshold({ thresholdPct: 85, sizeKib: 1_000_000, compressedTargetBytes: COMPRESSED_TARGET, accounting }).exceeded).toBe(true);
      // 逻辑 1.85G 已超旧线，但只进 observation，不参与判定。
      expect(own.observation?.logicalExceeded).toBe(true);
    }
    await pg.close();
  }, 60_000);
});
