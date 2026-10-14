// repo-auto-create: 当前仓 >=85% 阈值时自动创建下一个仓 + 注册到 storage_repositories。
//
// 设计依据:
// - 仓满自动切换链路草案(本轮静态盘点, novel-finder/runtime-download/repository-rollover.ts
//   是已写好的纯决策层;缺的就是候选池里没下一仓)。
// - 用户口径: 1G = 10^9 字节, 告警阈值 85%, 满仓 100%。
// - GitHub API size 字段报的是 KB(压缩后 Git 仓大小), 与 1GB=10^9B 阈值**不是同一度量**;
//   legacy 模式仍按它换算比较,现役模式改用台账逻辑字节（见文件头与 evaluateThreshold）。
//
// 行为合同:
// - 幂等: 按"当前仓名-N"的命名约定探测下一编号;若 storage_repositories 已有目标行
//   且状态可写,不再 INSERT(ON CONFLICT DO NOTHING)。
// - dry-run 默认开,--apply 才真建仓+真写库。
// - 建仓成功 = POST /user/repos 201 + GET /repos/{owner}/{newRepo} 200;
//   立刻 INSERT storage_repositories(enabled=true, is_private=true, read_only=false)。
// - GitHub API 失败 / token 缺权限 → 抛错退出码 1,不静默;调用方决定告警/重试。
// - 不写 DATABASE_URL 等任何敏感字段进日志;repo 名仅 owner/repo 形态(非机密)。
//
// 用法:
//   node repo-auto-create.mjs --database-url-env=NAME --github-token-env=NAME \
//     (--current=owner/repo | --current-from-ledger) \
//     [--threshold-pct=85] [--target-bytes=1000000000] [--dry-run | --apply]
//
// 出口码: 0=noop/done; 1=error; 2=threshold 未到(不需要建仓);3=无活跃可写仓(证据端口/账目错或全仓不可写)
//
// 已知边界(必须显式):
// - 只建仓+登记,不修改任何 env 变量、不更新 worker bundle;切仓生效仍依赖 capacity_ledger
//   上 ready 行 + ZHAOSHU_ROLLOVER_ENABLED=1 + bundle 重发布。
// - GitHub 私有仓 1G 上限是 GitHub 建议软上限不是硬切断;本脚本按用户口径 10^9 B 为切换点。
// - 不主动迁移旧书数据;旧仓保留为只读(由后续 GC/迁移任务独立处理)。
// - 「现役仓」定义:见 selectActiveRepository 注释——与 decideRepositoryForPublication
//   同一组判据,失败关闭,无任何「最后一个被封存仓」或「ZHAOSHU_BOOKS_REPO 配置值」回退,
//   否则 books-3/4 永不会被探针观察到（ledgersync41）。
// - 阈值比较有两套口径,按模式分家（见 evaluateThreshold）:
//   · --current-from-ledger（现役模式,生产在用）: 台账逻辑字节 registered_bytes+reserved_bytes
//     对每仓 target_bytes×thresholdPct。与 decideRepositoryForPublication 同一度量、同一账本,
//     故必然在 decide 切仓之前触发,不会出现「decide 已切、探针仍 below-threshold」的死锁。
//   · --current=owner/repo（legacy）: 沿用 GitHub 报回的压缩 size(KiB) 对 --target-bytes,
//     行为逐字不变。
//   GitHub 压缩 size 两种模式都照旧拉取,但只进日志不参与判定——TXT 压缩比下压缩≈逻辑 40%,
//   拿它比 10^9 逻辑字节阈值会要 2.1GB 逻辑才触发,那时仓早就被 decide 切走了。

import { neon } from '@neondatabase/serverless';

const USAGE = '用法: repo-auto-create.mjs --database-url-env=NAME --github-token-env=NAME (--current=owner/repo | --current-from-ledger) [--threshold-pct=85] [--target-bytes=1000000000] [--dry-run | --apply]';

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseArgs(argv, env = process.env) {
  let dbEnv, ghEnv, current, currentFromLedger = false, thresholdPct = 85, targetBytes = BigInt(1_000_000_000);
  let apply = false, dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--database-url-env=')) dbEnv = arg.slice(19);
    else if (arg.startsWith('--github-token-env=')) ghEnv = arg.slice(19);
    else if (arg.startsWith('--current=')) current = arg.slice(10);
    else if (arg === '--current-from-ledger') currentFromLedger = true;
    else if (arg.startsWith('--threshold-pct=')) thresholdPct = Number(arg.slice(16));
    else if (arg.startsWith('--target-bytes=')) targetBytes = BigInt(arg.slice(15));
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`未知参数 ${arg}. ${USAGE}`);
  }
  if (!dbEnv) throw new Error(`--database-url-env 必填. ${USAGE}`);
  if (!ghEnv) throw new Error(`--github-token-env 必填. ${USAGE}`);
  // 现役仓来源必须**显式二选一**:写死的 --current 会随封存/切换而长期过时(ledgersync41 根因),
  // 缺省不猜——既不给「配置里的第一个仓」也不给「最新仓」兜底,避免探针盯错仓却静默通过。
  if (current && currentFromLedger) throw new Error(`--current 与 --current-from-ledger 互斥. ${USAGE}`);
  if (!current && !currentFromLedger) throw new Error(`必须给 --current=owner/repo 或 --current-from-ledger 之一. ${USAGE}`);
  if (apply && dryRun) throw new Error('--apply 与 --dry-run 冲突');
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct >= 100) {
    throw new Error(`--threshold-pct 必须在 (0,100), 得 ${thresholdPct}`);
  }
  let owner = null, repo = null;
  if (current) {
    const [parsedOwner, parsedRepo] = current.split('/');
    if (!parsedOwner || !parsedRepo) throw new Error(`--current 形态必须 owner/repo, 得 ${current}`);
    owner = parsedOwner; repo = parsedRepo;
  }
  return {
    dbEnv, ghEnv, owner, repo, currentFromLedger,
    thresholdPct, targetBytes,
    mode: apply ? 'apply' : 'dry-run',
    dbUrl: env[dbEnv], token: env[ghEnv],
  };
}

/**
 * 「现役仓」= decideRepositoryForPublication 在当前仓已满时会选的那个仓，即候选里**第一个仍可写**
 * 的仓（id 升序）。判据逐条对齐 runtime-download/repository-rollover.ts:213-224 的 evaluateCandidate：
 *   enabled ∧ is_private ∧ ¬read_only ∧ ¬sealed        ← 注册表四门
 *   ∧ ledger state='ready'                              ← 有已对账的容量证据
 *   ∧ baseline_epoch 非空                                ← 账目快照版本存在
 *   ∧ admission_status='granted' ∧ admission_version 非空 ∧ admission_valid_until 未过期
 *   ∧ admission_target 绑定本仓（repositoryId + branch）
 *   ∧ registered_bytes + reserved_bytes + 1 <= target_bytes
 * 最后一项的 +1 = 「本次发布的逻辑字节按 1 计」：任何真实发布至少 1 字节，故等价于
 * registered+reserved < target。这样「正好装满」的仓不会被当成现役仓——否则探针会盯一个
 * 下一个字节就写不进去的仓，而 decide 对同一次发布也会立刻切走（投影式 registered+reserved+logicalBytes
 * <= target，logicalBytes>=1）。与 decide 的判定在真实发布下逐例一致（见 repo-auto-create.test.ts 的交叉验证）。
 * 任一条不满足即该仓不是现役仓；**没有**任何回退分支去猜别的仓——全都不合格就失败关闭（退出码 3），
 * 因为「猜一个仓去探针」正是本任务要消灭的行为。
 *
 * @param {Array<Record<string, unknown>>} rows 候选行（storage_repositories LEFT JOIN repository_capacity_ledger
 *        的列，见 resolveActiveRepository 的 SQL）；按 id 升序处理，不依赖入参数组顺序
 * @param {Date} now 显式时钟（与纯决策同一红线：不读真实时间）
 */
export function selectActiveRepository(rows, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now 必须是有效 Date');
  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: 'blocked', reason: 'no registered repositories' };
  }
  const nowMs = now.getTime();
  const ordered = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
  for (const row of ordered) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) return { status: 'blocked', reason: `repository id 非法: ${row.id}` };
    const isPrivate = row.is_private === true;
    const enabled = row.enabled === true;
    const readOnly = row.read_only === true;
    const sealed = row.sealed_at !== null && row.sealed_at !== undefined;
    if (!enabled || !isPrivate || readOnly || sealed) continue;
    if (row.ledger_state !== 'ready') continue;
    if (typeof row.baseline_epoch !== 'string' || row.baseline_epoch.trim() === '') continue;
    if (row.admission_status !== 'granted') continue;
    if (typeof row.admission_version !== 'string' || row.admission_version.trim() === '') continue;
    const validUntil = row.admission_valid_until;
    const untilMs = typeof validUntil === 'string' ? Date.parse(validUntil)
      : validUntil instanceof Date && !Number.isNaN(validUntil.getTime()) ? validUntil.getTime()
      : Number.NaN;
    if (!Number.isFinite(untilMs) || untilMs < nowMs) continue;
    const target = row.admission_target;
    if (target == null || typeof target !== 'object') continue;
    if (Number(target.repositoryId) !== id || target.branch !== row.branch) continue;
    const registered = BigInt(row.registered_bytes ?? 0);
    const reserved = BigInt(row.reserved_bytes ?? 0);
    const capacity = BigInt(row.target_bytes);
    if (!(capacity > BigInt(0))) continue;
    // +1 = 本次发布的最小逻辑字节（见函数头注释）。
    if (registered + reserved + BigInt(1) > capacity) continue;
    return {
      status: 'ok',
      repository: { id, owner: String(row.owner), repo: String(row.repo), branch: String(row.branch) },
      accounting: { registeredBytes: registered, reservedBytes: reserved, targetBytes: capacity },
    };
  }
  return { status: 'blocked', reason: 'no eligible writable repository' };
}

/** 读候选（与 runtime-download/entry.ts:210 的 createRolloverEvidencePort 同一组列），再按判据选现役仓。 */
export async function resolveActiveRepository(sql, now) {
  const rows = await sql`
    SELECT r.id, r.owner, r.repo, r.branch, r.enabled, r.is_private, r.read_only, r.sealed_at,
           l.state AS ledger_state, l.baseline_epoch, l.target_bytes,
           l.registered_bytes, l.reserved_bytes,
           l.admission_status, l.admission_version, l.admission_valid_until, l.admission_target
    FROM storage_repositories r
    LEFT JOIN repository_capacity_ledger l ON l.repository_id = r.id
    ORDER BY r.id ASC`;
  // 只记候选数量，不含仓名/凭据。
  console.log(JSON.stringify({ phase: 'candidates', count: rows.length }));
  return selectActiveRepository(rows, now);
}

/**
 * 阈值判定（纯函数，两套口径按模式分家）。判定只读入参、不读时钟、不发网络，便于反例验证。
 *
 * - metric='ledger-logical'（--current-from-ledger,生产在用）: 用台账账目
 *   registered+reserved 对**每仓自己的** targetBytes×thresholdPct。这与 decideRepositoryForPublication
 *   的投影式判定同账本同单位,故 registered+reserved 越过 85% 时探针先于 decide 的 100% 切仓触发,
 *   下一仓必定已经建好——不留「decide 已切、探针还 below-threshold」的死锁窗口。
 * - metric='github-compressed'（legacy --current=）: GitHub 报回的压缩 size(KiB) 对
 *   --target-bytes 的 85%,逐字沿用旧算法与旧比较方向。
 * sizeKib 两种模式都只是日志字段,不参与 ledger 口径的判定。
 *
 * @param {{ metric: 'ledger-logical'|'github-compressed', thresholdPct: number,
 *           cfgTargetBytes: bigint, accounting: {registeredBytes: bigint, reservedBytes: bigint, targetBytes: bigint}|null,
 *           sizeKib: number }} input
 */
export function evaluateThreshold({ metric, thresholdPct, cfgTargetBytes, accounting, sizeKib }) {
  if (metric === 'ledger-logical') {
    if (!accounting) throw new Error('ledger 口径缺少 accounting（调用方须先失败关闭，不得猜默认值）');
    const registered = BigInt(accounting.registeredBytes);
    const reserved = BigInt(accounting.reservedBytes);
    const target = BigInt(accounting.targetBytes);
    if (!(target > BigInt(0))) throw new Error(`ledger target_bytes 非正: ${accounting.targetBytes}`);
    const thresholdLogicalBytes = target * BigInt(thresholdPct) / 100n;
    const usedLogicalBytes = registered + reserved;
    return {
      metric, exceeded: usedLogicalBytes >= thresholdLogicalBytes,
      usedLogicalBytes, thresholdLogicalBytes, accountingTargetBytes: target,
      thresholdKib: null,
    };
  }
  const thresholdKib = Number(cfgTargetBytes / 1024n * BigInt(thresholdPct) / 100n);
  return { metric, exceeded: sizeKib >= thresholdKib, thresholdKib, sizeKib };
}

async function ghFetch(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'zhaoshu-repo-auto-create/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

async function readRepoSizeKib(token, owner, repo) {
  const res = await ghFetch(token, 'GET', `/repos/${owner}/${repo}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET /repos/${owner}/${repo} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { sizeKib: Number(data.size), defaultBranch: data.default_branch ?? 'main' };
}

async function createRepo(token, name) {
  const res = await ghFetch(token, 'POST', '/user/repos', {
    name, private: true, auto_init: true,
    description: 'zhaoshu-books auto-rollover',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /user/repos HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function repoExists(token, owner, repo) {
  const res = await ghFetch(token, 'GET', `/repos/${owner}/${repo}`);
  return res.ok;
}

async function findNextName(token, owner, baseRepo) {
  // 探测顺序: base, base-2, base-3, ... 返回第一个不存在的号
  for (let n = 2; n <= 99; n += 1) {
    const cand = `${baseRepo}-${n}`;
    if (!(await repoExists(token, owner, cand))) return cand;
  }
  throw new Error('未能找到可用下一仓名 base-N (N=2..99)');
}

async function registerStorageRepo(sql, owner, repo, branch) {
  return await sql`
    INSERT INTO storage_repositories (owner, repo, branch, enabled, is_private, read_only)
    VALUES (${owner}, ${repo}, ${branch}, true, true, false)
    ON CONFLICT DO NOTHING
    RETURNING id`;
}

// 把新建仓在 capacity_ledger 升 ready/granted,让 rollover 决策立刻把它纳入候选
async function liftCapacityLedger(sql, repositoryId, branch) {
  const targetJson = JSON.stringify({ repositoryId, branch });
  return await sql`
    INSERT INTO repository_capacity_ledger
      (repository_id, state, target_bytes, registered_bytes, reserved_bytes, baseline_epoch, admission_status, admission_version, admission_valid_until, admission_target)
    VALUES
      (${repositoryId}::integer, 'ready', 1000000000::bigint, 0::bigint, 0::bigint, 'm0001_capacity_init', 'granted', 'storage_repositories_writable_v1', NOW() + INTERVAL '30 days',
       ${targetJson}::jsonb)
    ON CONFLICT (repository_id) DO UPDATE
    SET state='ready',
        admission_status='granted',
        admission_version='storage_repositories_writable_v1',
        admission_valid_until=NOW() + INTERVAL '30 days',
        admission_target=EXCLUDED.admission_target,
        updated_at=NOW()
    RETURNING repository_id`;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg.dbUrl) throw new Error(`env ${cfg.dbEnv} 为空`);
  if (!cfg.token) throw new Error(`env ${cfg.ghEnv} 为空`);
  const sql = neon(cfg.dbUrl);
  let owner = cfg.owner;
  let repo = cfg.repo;
  let activeRepositoryId = null;
  let accounting = null;
  if (cfg.currentFromLedger) {
    // 现役仓从台账派生，不从配置/写死值派生（ledgersync41 根因）。
    const active = await resolveActiveRepository(sql, new Date());
    if (active.status !== 'ok' || !active.accounting) {
      // 失败关闭：不猜、不回退到任何硬编码仓；unit 的 SuccessExitStatus 只含 0/2，故退出码 3 会被
      // systemd 判为失败并告警——这是期望行为（账目不可信时宁可不探针）。accounting 缺失同样落这条
      // ——账目残缺等于账目不可信，失败关闭而非用默认值蒙混。
      console.error(JSON.stringify({ phase: 'done', status: 'no-active-repository',
        reason: active.status === 'ok' ? 'ledger accounting missing' : active.reason,
        metric: 'ledger-logical', exit: 3 }));
      process.exitCode = 3;
      return;
    }
    owner = active.repository.owner;
    repo = active.repository.repo;
    activeRepositoryId = active.repository.id;
    accounting = active.accounting;
  }
  const metric = cfg.currentFromLedger ? 'ledger-logical' : 'github-compressed';
  const cur = await readRepoSizeKib(cfg.token, owner, repo);
  const verdict = evaluateThreshold({
    metric, thresholdPct: cfg.thresholdPct, cfgTargetBytes: cfg.targetBytes, accounting, sizeKib: cur.sizeKib,
  });
  const probeLog = {
    phase: 'probe', current: `${owner}/${repo}`, repositoryId: activeRepositoryId,
    source: cfg.currentFromLedger ? 'ledger' : 'flag',
    metric, thresholdPct: cfg.thresholdPct, mode: cfg.mode,
  };
  if (verdict.thresholdKib !== null) probeLog.thresholdKib = verdict.thresholdKib;
  console.log(JSON.stringify(probeLog));

  const probeResultLog = {
    phase: 'probe-result', metric, sizeKib: cur.sizeKib, exceeded: verdict.exceeded,
    defaultBranch: cur.defaultBranch,
  };
  if (verdict.thresholdKib !== null) probeResultLog.thresholdKib = verdict.thresholdKib;
  if (verdict.usedLogicalBytes !== undefined) {
    probeResultLog.usedLogicalBytes = verdict.usedLogicalBytes.toString();
    probeResultLog.thresholdLogicalBytes = verdict.thresholdLogicalBytes.toString();
    probeResultLog.accountingTargetBytes = verdict.accountingTargetBytes.toString();
  }
  console.log(JSON.stringify(probeResultLog));

  if (!verdict.exceeded) {
    console.log(JSON.stringify({ phase: 'done', status: 'below-threshold', metric, exit: 2 }));
    process.exitCode = 2;
    return;
  }

  const nextName = await findNextName(cfg.token, owner, repo);
  console.log(JSON.stringify({ phase: 'plan', nextRepo: `${owner}/${nextName}`, branch: cur.defaultBranch, metric }));

  if (cfg.mode === 'dry-run') {
    console.log(JSON.stringify({ phase: 'done', status: 'dry-run', wouldCreate: `${owner}/${nextName}`, metric }));
    return;
  }

  await createRepo(cfg.token, nextName);
  const rows = await registerStorageRepo(sql, owner, nextName, cur.defaultBranch);
  const id = rows[0]?.id ?? null;
  if (id === null) {
    // 并发双跑输的一方: 仓位行已存在,直接读 id 再 lift capacity
    const existing = await sql`SELECT id FROM storage_repositories WHERE lower(owner)=lower(${owner}) AND lower(repo)=lower(${nextName}) LIMIT 1`;
    const existingId = existing[0] ? Number(existing[0].id) : null;
    if (existingId) {
      await liftCapacityLedger(sql, existingId, cur.defaultBranch);
      console.log(JSON.stringify({ phase: 'done', status: 'applied', repo: `${owner}/${nextName}`, storageId: existingId, note: 'concurrent-skip-register lift-capacity', metric }));
      return;
    }
    console.log(JSON.stringify({ phase: 'done', status: 'applied', repo: `${owner}/${nextName}`, storageId: 'concurrent-skip', note: '未找到既有行,跳过 lift', metric }));
    return;
  }
  await liftCapacityLedger(sql, Number(id), cur.defaultBranch);
  console.log(JSON.stringify({ phase: 'done', status: 'applied', repo: `${owner}/${nextName}`, storageId: Number(id), capacity: 'ready/granted', metric }));
}

// 仅当脚本被直接执行时才跑 main;被 import 时只暴露模块接口
const isDirect = process.argv[1] && (process.argv[1].endsWith('repo-auto-create.mjs') || process.argv[1].endsWith('repo-auto-create'));
if (isDirect) {
  main().catch(err => {
    console.error(JSON.stringify({ phase: 'error', error: (err && err.message) ? err.message.slice(0, 200) : String(err).slice(0, 200) }));
    process.exitCode = 1;
  });
}
