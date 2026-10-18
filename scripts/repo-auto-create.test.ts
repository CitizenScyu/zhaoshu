// ledgersync41：rollover 探针的「现役仓」选择。
//
// 根因：systemd 把 --current 写死成已封存的 repo1，阈值永不触发，books-3/4 永不会被建出来。
// 本文件固定判据：探针观察对象 = 台账现役仓 = decideRepositoryForPublication 在当前仓已满时会选的仓。
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
const TARGET_BYTES = BigInt(1_000_000_000);

/** storage_repositories LEFT JOIN repository_capacity_ledger 的一行（列名见 resolveActiveRepository 的 SQL）。 */
type LedgerRow = {
  id: number; owner: string; repo: string; branch: string;
  enabled: boolean; is_private: boolean; read_only: boolean; sealed_at: string | null;
  ledger_state: string; baseline_epoch: string;
  target_bytes: bigint; registered_bytes: bigint; reserved_bytes: bigint;
  admission_status: 'granted' | 'denied' | 'unknown'; admission_version: string;
  admission_valid_until: string | null;
  admission_target: { repositoryId: number; branch: string } | null;
};

/** 一个账目/准入都齐、账上 0 字节的候选仓（各用例按需覆盖字段）。 */
const repo = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1, owner: 'CitizenScyu', repo: 'zhaoshu-books', branch: 'main',
  enabled: true, is_private: true, read_only: false, sealed_at: null,
  ledger_state: 'ready', baseline_epoch: 'm0001_capacity_init',
  target_bytes: TARGET_BYTES, registered_bytes: BigInt(0), reserved_bytes: BigInt(0),
  admission_status: 'granted', admission_version: 'storage_repositories_writable_v1',
  admission_valid_until: FUTURE,
  admission_target: { repositoryId: 1, branch: 'main' },
  ...over,
});

describe('parseArgs：现役仓来源必须显式二选一', () => {
  it('两源互斥，且缺省不给（不猜仓）', () => {
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B'], {})).toThrow(/--current=/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--current-from-ledger'], {}))
      .toThrow(/互斥/);
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger'], {}))
      .toMatchObject({ owner: null, repo: null, currentFromLedger: true, mode: 'dry-run' });
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r'], {}))
      .toMatchObject({ owner: 'o', repo: 'r', currentFromLedger: false });
  });

  it('旧用法向后兼容（--current 仍可用、其余闸门不变）', () => {
    expect(parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--apply',
      '--threshold-pct=90', '--target-bytes=2000000000'], {}))
      .toMatchObject({ owner: 'o', repo: 'r', mode: 'apply', thresholdPct: 90, targetBytes: BigInt(2_000_000_000) });
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--bogus'], {})).toThrow(/未知参数/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=noslash'], {})).toThrow(/owner\/repo/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current=o/r', '--threshold-pct=100'], {})).toThrow(/0,100/);
    expect(() => parseArgs(['--database-url-env=A', '--github-token-env=B', '--current-from-ledger', '--apply', '--dry-run'], {}))
      .toThrow(/冲突/);
  });

  it('解析结果不回显任何秘密（只有变量名）', () => {
    const parsed = parseArgs(['--database-url-env=PROD_URL', '--github-token-env=GH', '--current-from-ledger'],
      { PROD_URL: 'postgres://u:p@h/db', GH: 'ghp_secret' });
    expect(JSON.stringify({ dbEnv: parsed.dbEnv, ghEnv: parsed.ghEnv })).toBe('{"dbEnv":"PROD_URL","ghEnv":"GH"}');
  });
});

describe('selectActiveRepository：盯台账现役仓，不盯写死值', () => {
  it('核心场景：repo1 已满仓 → 盯 repo2（哪怕 repo1 id 更小）', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', registered_bytes: TARGET_BYTES, admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(123), admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', registered_bytes: BigInt(0), admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({
      status: 'ok',
      repository: { id: 2, repo: 'zhaoshu-books-2' },
    });
  });

  it('repo1 未满且可写 → 仍是 repo1（不无谓跳仓）', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', registered_bytes: BigInt(800_000_000), admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(0), admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 1, repo: 'zhaoshu-books' } });
  });

  it('repo1 已封存 → 直接盯 repo2（封存优先于容量）', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', sealed_at: '2026-10-13T08:21:00Z', registered_bytes: BigInt(0), admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(0), admission_target: { repositoryId: 2, branch: 'main' } }),
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
      repo({ id: 1, registered_bytes: TARGET_BYTES, admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
    expect(selectActiveRepository([...rows].reverse(), NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  it('reserved_bytes 也计入占用（与 decide 的投影同式）', () => {
    const rows = [
      repo({ id: 1, registered_bytes: TARGET_BYTES - BigInt(10), reserved_bytes: BigInt(11) }),
      repo({ id: 2, repo: 'zhaoshu-books-2', admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });
});

describe('selectSuccessor：repofix42 幂等护栏（阈值已超但备仓就绪 → 不重复建仓）', () => {
  it('有合格备仓 → 返回该备仓（main 据此 successor-ready 退出 0，不再建仓）', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', registered_bytes: TARGET_BYTES, admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(900_000_000), admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', registered_bytes: BigInt(0), admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    expect(selectSuccessor(rows, 2, NOW)).toMatchObject({ status: 'ok', repository: { id: 3, repo: 'zhaoshu-books-3' } });
  });

  it('无备仓 → blocked（走建仓路径的信号）：剔除现役行后其余全不合格', () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', sealed_at: '2026-10-13T08:21:00Z', admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(900_000_000), admission_target: { repositoryId: 2, branch: 'main' } }),
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
    // jsonb 里的 admission_target 先按 entry.ts:180-186 核「绑本仓」，核过才把完整元组当外部准入证据。
    const bound = row.admission_target;
    if (bound == null || Number(bound.repositoryId) !== tuple.id || bound.branch !== tuple.branch) {
      throw new Error(`admission_target does not bind repository ${tuple.id}`);
    }
    return {
      ...tuple,
      enabled: row.enabled, isPrivate: row.is_private, readOnly: row.read_only,
      sealed: row.sealed_at !== null && row.sealed_at !== undefined,
      targetBytes: BigInt(row.target_bytes),
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

  it('repo1 满 + 本次还要写 1 字节：decide 切到 repo2，探针也盯 repo2', async () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', registered_bytes: TARGET_BYTES, admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(0), admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(await decideTarget(rows, 1, BigInt(1))).toBe(2);
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 2 } });
  });

  it('repo1 还有余量：两边都留在 repo1（探针不无谓跳仓）', async () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', registered_bytes: BigInt(800_000_000), admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: BigInt(0), admission_target: { repositoryId: 2, branch: 'main' } }),
    ];
    expect(await decideTarget(rows, 1, BigInt(1_000_000))).toBe(1);
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 1 } });
  });

  it('repo1 封存、repo2 满：decide 切到 repo3，探针也盯 repo3', async () => {
    const rows = [
      repo({ id: 1, repo: 'zhaoshu-books', sealed_at: '2026-10-13T08:21:00Z', admission_target: { repositoryId: 1, branch: 'main' } }),
      repo({ id: 2, repo: 'zhaoshu-books-2', registered_bytes: TARGET_BYTES, admission_target: { repositoryId: 2, branch: 'main' } }),
      repo({ id: 3, repo: 'zhaoshu-books-3', registered_bytes: BigInt(0), admission_target: { repositoryId: 3, branch: 'main' } }),
    ];
    expect(await decideTarget(rows, 1, BigInt(1))).toBe(3);
    expect(selectActiveRepository(rows, NOW)).toMatchObject({ status: 'ok', repository: { id: 3 } });
  });
});

describe('evaluateThreshold：现役模式比台账逻辑字节，legacy 比压缩 KiB（probefix41）', () => {
  const legacy = (sizeKib: number, targetBytes = TARGET_BYTES, thresholdPct = 85) =>
    evaluateThreshold({ metric: 'github-compressed', thresholdPct, cfgTargetBytes: targetBytes, accounting: null, sizeKib });
  const ledger = (registeredBytes: bigint, reservedBytes: bigint, targetBytes = TARGET_BYTES, thresholdPct = 85) =>
    evaluateThreshold({ metric: 'ledger-logical', thresholdPct, cfgTargetBytes: TARGET_BYTES,
      accounting: { registeredBytes, reservedBytes, targetBytes }, sizeKib: 0 });

  it('legacy（--current=）口径逐字不变：850MB 压缩字节边界两侧翻转，direction 是 >=', () => {
    const boundary = Number(TARGET_BYTES / BigInt(1024) * BigInt(85) / BigInt(100)); // 85% of 1e9 B 换算 KiB
    expect(legacy(boundary).thresholdKib).toBe(boundary);
    expect(legacy(boundary - 1).exceeded).toBe(false);
    expect(legacy(boundary).exceeded).toBe(true);      // 边界本身算过线（>=，非 >）
    expect(legacy(boundary + 1).exceeded).toBe(true);
    // 旧算法细节：先 /1024 再乘百分比（整数截断），不是先算字节再换 KiB
    expect(legacy(0, BigInt(2_000_000_000), 90).thresholdKib).toBe(Number(BigInt(2_000_000_000) / BigInt(1024) * BigInt(90) / BigInt(100)));
  });

  it('legacy 模式忽略 accounting（保持「只看压缩 size」）', () => {
    const over = legacy(Number(TARGET_BYTES / BigInt(1024) * BigInt(85) / BigInt(100)));
    expect(over.metric).toBe('github-compressed');
    expect(over.exceeded).toBe(true);
  });

  it('现役模式：registered+reserved 合计过 85% → 建仓（不取 cfg 默认 target）', () => {
    // target 仍是台账里的 1e9，但 cfg 传 9e9 也不该被采信：判定必须跟台账。
    const v = evaluateThreshold({ metric: 'ledger-logical', thresholdPct: 85, cfgTargetBytes: BigInt(9_000_000_000),
      accounting: { registeredBytes: BigInt(849_999_999), reservedBytes: BigInt(1), targetBytes: TARGET_BYTES }, sizeKib: 0 });
    expect(v.exceeded).toBe(true);
    expect(v).toMatchObject({ metric: 'ledger-logical', thresholdLogicalBytes: BigInt(850_000_000) });
  });

  it('现役模式：reserved 单独把合计顶过线也算过线（与 decide 同式）', () => {
    expect(ledger(BigInt(800_000_000), BigInt(60_000_000)).exceeded).toBe(true);
    expect(ledger(BigInt(840_000_000), BigInt(9_999_999)).exceeded).toBe(false);
  });

  it('现役模式：books-2 现场量级（204,689,438 B）未过 85% → 不建仓（exit 2 below-threshold 的来源）', () => {
    const v = ledger(BigInt(204_689_438), BigInt(0));
    expect(v.exceeded).toBe(false);
    expect(v.usedLogicalBytes).toBe(BigInt(204_689_438));
  });

  it('每仓用自己的 target_bytes（不用 cfg 默认值）', () => {
    expect(ledger(BigInt(850_000_000), BigInt(0), BigInt(2_000_000_000)).exceeded).toBe(false);
    expect(ledger(BigInt(1_700_000_000), BigInt(0), BigInt(2_000_000_000)).exceeded).toBe(true);
  });

  it('反例护栏：压缩口径永不触发的时点（逻辑 2.05GB ≈ 压缩 820MB）在新口径已触发', () => {
    // books-2 实测压缩≈逻辑 40%。逻辑 2.05GB 时压缩仅 820MB < 旧阈值 829,101 KiB ⇒ 旧口径永不触发;
    // 但台账早在 1e9 逻辑处就被 decide 切走、而 books-4 还没建 ⇒ ROLLOVER_WIRING_BLOCKED 死锁形态。
    const compressedKib = Math.floor(820_000_000 / 1024);
    expect(legacy(compressedKib).exceeded).toBe(false);
    expect(ledger(BigInt(2_050_000_000), BigInt(0)).exceeded).toBe(true);
  });

  it('accounting 缺失 → 抛错失败关闭（不用默认值蒙混）', () => {
    expect(() => evaluateThreshold({ metric: 'ledger-logical', thresholdPct: 85, cfgTargetBytes: TARGET_BYTES, accounting: null, sizeKib: 1 }))
      .toThrow(/accounting/);
    expect(() => evaluateThreshold({ metric: 'ledger-logical', thresholdPct: 85, cfgTargetBytes: TARGET_BYTES,
      accounting: { registeredBytes: BigInt(1), reservedBytes: BigInt(0), targetBytes: BigInt(0) }, sizeKib: 1 }))
      .toThrow(/target_bytes/);
  });
});

describe('resolveActiveRepository（PGlite 真表）', () => {
  // 纯函数测不到列名/LEFT JOIN 写错，故用真表跑一次真实 SQL（合成数据，不触生产）。
  it('按 id 升序读全表候选，选第一个仍可写且未装满的仓', async () => {
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
    // repo1 已封存且装满、repo2 在用、repo3 空着 ⇒ 现役仓必须是 repo2（探针盯它，不是 repo1 也不是 repo3）
    await pg.exec(`
      INSERT INTO storage_repositories(id,owner,repo,branch,enabled,is_private,read_only,sealed_at,target_bytes)
        VALUES(1,'fixture','repo-a','main',true,true,false,'2026-10-13T08:21:00Z',1000000000),
              (2,'fixture','repo-b','main',true,true,false,NULL,1000000000),
              (3,'fixture','repo-c','main',true,true,false,NULL,1000000000);
      INSERT INTO repository_capacity_ledger
        (repository_id,state,target_bytes,registered_bytes,reserved_bytes,baseline_epoch,
         admission_status,admission_version,admission_valid_until,admission_target)
        VALUES
          (1,'ready',1000000000,1850000000,0,'epoch-1','granted','v1',NOW()+INTERVAL '30 days','{"repositoryId":1,"branch":"main"}'),
          (2,'ready',1000000000,120000000,0,'epoch-1','granted','v1',NOW()+INTERVAL '30 days','{"repositoryId":2,"branch":"main"}'),
          (3,'ready',1000000000,0,0,'epoch-1','granted','v1',NOW()+INTERVAL '30 days','{"repositoryId":3,"branch":"main"}');
    `);
    const active = await resolveActiveRepository(sql, NOW);
    expect(active).toMatchObject({ status: 'ok', repository: { id: 2, repo: 'repo-b', branch: 'main' } });
    // accounting 是现役模式阈值判定的唯一输入来源，必须真表跑出来（不是 cfg 默认值）。
    if (active.status === 'ok') {
      expect(active.accounting).toEqual({ registeredBytes: BigInt(120_000_000), reservedBytes: BigInt(0), targetBytes: BigInt(1_000_000_000) });
      const accounting = active.accounting ?? null;
      expect(evaluateThreshold({ metric: 'ledger-logical', thresholdPct: 85, cfgTargetBytes: BigInt(9_000_000_000),
        accounting, sizeKib: 0 }).exceeded).toBe(false);
    }
    await pg.close();
  }, 60_000);
});
