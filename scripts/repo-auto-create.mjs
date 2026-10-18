// repo-auto-create: 当前仓 GitHub 压缩 size 超阈值时自动创建下一个仓 + 注册到 storage_repositories。
//
// 设计依据:
// - 仓满自动切换链路草案(本轮静态盘点, novel-finder/runtime-download/repository-rollover.ts
//   是已写好的纯决策层;缺的就是候选池里没下一仓)。
// - 容量口径(repothresh44,用户 2026-10-19 裁定「尽量仓少一点,平衡一点」): **GitHub 压缩 pack 字节**。
//   目标 1GiB = 1073741824(严格贴合 GitHub 官方「仓 <1GB」建议线,对 5GB 硬限留约 5 倍余量),
//   告警阈值 85%,满仓 100%。GitHub `GET /repos/{owner}/{repo}` 的 size 字段就是这个压缩 pack
//   的 KiB 数,×1024 得字节——与判定同一度量,不再需要换算成逻辑字节。
//   旧口径(台账逻辑字节 registered+reserved 对 target_bytes=10^9)降级为**观测**:书仓 TXT 压缩
//   ≈逻辑 40%(books-2 实测逻辑 1,000,307,484 B 对压缩 397,520,896 B),按逻辑字节切仓比按真实
//   压缩限制早约 2.6 倍触发,同样内容下仓数量约 3 倍膨胀。
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
//     [--threshold-pct=85] [--compressed-target-bytes=1073741824] [--target-bytes=1000000000] \
//     [--dry-run | --apply]
//
// 出口码: 0=noop/done; 1=error; 2=threshold 未到(不需要建仓);3=无活跃可写仓(证据端口/账目错或全仓不可写)
//
// 已知边界(必须显式):
// - 只建仓+登记,不修改任何 env 变量、不更新 worker bundle;切仓生效仍依赖 capacity_ledger
//   上 ready 行 + ZHAOSHU_ROLLOVER_ENABLED=1 + bundle 重发布。
// - GitHub 私有仓 1G 上限是 GitHub 建议软上限不是硬切断(硬限 5GB);本脚本按用户口径
//   1GiB **压缩** pack 字节为切换点。
// - 不主动迁移旧书数据;旧仓保留为只读(由后续 GC/迁移任务独立处理)。
// - 「现役仓」定义:见 selectActiveRepository 注释——与 decideRepositoryForPublication
//   同一组判据,失败关闭,无任何「最后一个被封存仓」或「ZHAOSHU_BOOKS_REPO 配置值」回退,
//   否则 books-3/4 永不会被探针观察到（ledgersync41）。
// - **部署顺序**:本脚本与运行期 decide 都 SELECT 台账新列 github_size_bytes /
//   target_compressed_bytes,故必须先跑 migrations/0008_capacity_compressed_threshold.sql
//   再上这版脚本;否则查询报「column does not exist」→ 退出码 1(失败关闭,不静默按 0 判)。
// - 判定口径两种模式统一为压缩字节(见 evaluateThreshold),区别只在**目标从哪来**:
//   · --current-from-ledger（现役模式,生产在用）: 目标取该仓台账行的 target_compressed_bytes,
//     即 decideRepositoryForPublication 用的同一个值(同库同列),故探针与运行期不可能各判一套。
//     --compressed-target-bytes 在此模式只用于给**新仓**台账行种值,并与行值一起打进日志便于对照。
//   · --current=owner/repo（legacy）: 无台账行可依,目标取 --compressed-target-bytes。
//   探针用 GitHub **实时** size 对 85%×目标,运行期 decide 用台账**滞后且偏小**的 size 对 100%×目标,
//   故探针必然先于 decide 触发——不留「decide 已切、探针还 below-threshold」的死锁窗口。
//   旧逻辑口径的 used/threshold/exceeded 一并进 probe-result 日志(observation 前缀),只作对照不判定。
//   注: --target-bytes 现在**只是被接受并打进日志**(cfgTargetBytes),不再参与任何判定——
//   逻辑观测目标取的是各仓台账行自己的 target_bytes 列,不是这个参数;新仓台账行的 target_bytes
//   也仍是 INSERT 里写死的 10^9(既有行为,本次未改)。保留该参数只为不让仍在传它的老 unit 撞
//   「未知参数」;要调门槛请改台账 target_compressed_bytes 列或传 --compressed-target-bytes。

import { neon } from '@neondatabase/serverless';

const USAGE = '用法: repo-auto-create.mjs --database-url-env=NAME --github-token-env=NAME (--current=owner/repo | --current-from-ledger) [--threshold-pct=85] [--compressed-target-bytes=1073741824] [--target-bytes=1000000000] [--dry-run | --apply]';

/** 容量口径名（repothresh44）：判定一律 GitHub 压缩 pack 字节。 */
const METRIC = 'github-size';
/** 压缩目标缺省值：1GiB（用户 2026-10-19 确认「1G 安全」，不用 2GiB）。 */
const DEFAULT_COMPRESSED_TARGET_BYTES = BigInt(1_073_741_824);

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseArgs(argv, env = process.env) {
  let dbEnv, ghEnv, current, currentFromLedger = false, thresholdPct = 85, targetBytes = BigInt(1_000_000_000);
  let compressedTargetBytes = DEFAULT_COMPRESSED_TARGET_BYTES;
  let apply = false, dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--database-url-env=')) dbEnv = arg.slice(19);
    else if (arg.startsWith('--github-token-env=')) ghEnv = arg.slice(19);
    else if (arg.startsWith('--current=')) current = arg.slice(10);
    else if (arg === '--current-from-ledger') currentFromLedger = true;
    else if (arg.startsWith('--threshold-pct=')) thresholdPct = Number(arg.slice(16));
    else if (arg.startsWith('--target-bytes=')) targetBytes = BigInt(arg.slice(15));
    else if (arg.startsWith('--compressed-target-bytes=')) compressedTargetBytes = BigInt(arg.slice(26));
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
  // 压缩目标是判定分母:非正即抛(失败关闭),不让 0 目标把每一轮都判成「已超阈值」而疯狂建仓。
  if (!(compressedTargetBytes > BigInt(0))) {
    throw new Error(`--compressed-target-bytes 必须为正, 得 ${compressedTargetBytes}`);
  }
  let owner = null, repo = null;
  if (current) {
    const [parsedOwner, parsedRepo] = current.split('/');
    if (!parsedOwner || !parsedRepo) throw new Error(`--current 形态必须 owner/repo, 得 ${current}`);
    owner = parsedOwner; repo = parsedRepo;
  }
  return {
    dbEnv, ghEnv, owner, repo, currentFromLedger,
    thresholdPct, targetBytes, compressedTargetBytes,
    mode: apply ? 'apply' : 'dry-run',
    dbUrl: env[dbEnv], token: env[ghEnv],
  };
}

/**
 * 台账 bigint 列规范化：neon HTTP 驱动对 bigint 返回口径不一（bigint/number/十进制 string），
 * 统一成非负 bigint。缺失（未跑 migrations/0008 时 SELECT 会先报列不存在，故这里主要防 NULL 与
 * 非法值）或非整数一律**抛**：按 0 猜会让已满的仓看起来「无限空」，探针于是永不建仓。
 */
function ledgerBigint(value, column) {
  if (typeof value === 'bigint') {
    if (value < BigInt(0)) throw new Error(`台账列 ${column} 为负: ${value}`);
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`台账列 ${column} 缺失或非法（migrations/0008 是否已跑？）: ${String(value).slice(0, 40)}`);
}

/**
 * 「现役仓」= decideRepositoryForPublication 在当前仓已满时会选的那个仓，即候选里**第一个仍可写**
 * 的仓（id 升序）。判据逐条对齐 runtime-download/repository-rollover.ts 的 evaluateCandidate：
 *   enabled ∧ is_private ∧ ¬read_only ∧ ¬sealed        ← 注册表四门
 *   ∧ ledger state='ready'                              ← 有已对账的容量证据
 *   ∧ baseline_epoch 非空                                ← 账目快照版本存在
 *   ∧ admission_status='granted' ∧ admission_version 非空 ∧ admission_valid_until 未过期
 *   ∧ admission_target 绑定本仓（repositoryId + branch）
 *   ∧ github_size_bytes + 1 <= target_compressed_bytes   ← repothresh44：压缩口径容量门槛
 * 最后一项与运行期 decide **逐字同一判据、同一台账两列**（旧逻辑口径 registered+reserved+1 <=
 * target_bytes 已不参与判定，只随 accounting 返回作观测）。+1 = 「本次发布至少占 1 字节」，故
 * 「正好装满」的仓不会被当成现役仓——否则探针会盯一个下一个字节就写不进去的仓，而 decide 对同一次
 * 发布也会立刻切走。台账 github_size_bytes 由 sync-ledger-capacity 每小时回写，滞后且偏小；探针
 * 判定用的是 GitHub 实时 size（见 evaluateThreshold），故探针的 85% 必然先于 decide 的 100% 触发。
 * 两列缺失/非法即抛（不 continue、不按 0 猜）：那是库与代码不同步的运维故障，报「无活跃可写仓」
 * （退出码 3）会把人引向不存在的容量问题。
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
    // 容量门槛：压缩口径两列（与运行期 decide 同判据）。缺失/非法即抛，见函数头注释。
    const githubSizeBytes = ledgerBigint(row.github_size_bytes, 'github_size_bytes');
    const targetCompressedBytes = ledgerBigint(row.target_compressed_bytes, 'target_compressed_bytes');
    if (!(targetCompressedBytes > BigInt(0))) continue;
    // +1 = 本次发布的最小字节数（见函数头注释）。
    if (githubSizeBytes + BigInt(1) > targetCompressedBytes) continue;
    // 逻辑口径三列降级为观测（预留记账仍在用），缺列/NULL 容忍为 0——它们不再决定任何事。
    const registered = BigInt(row.registered_bytes ?? 0);
    const reserved = BigInt(row.reserved_bytes ?? 0);
    return {
      status: 'ok',
      repository: { id, owner: String(row.owner), repo: String(row.repo), branch: String(row.branch) },
      accounting: {
        registeredBytes: registered, reservedBytes: reserved, targetBytes: BigInt(row.target_bytes ?? 0),
        githubSizeBytes, targetCompressedBytes,
      },
    };
  }
  return { status: 'blocked', reason: 'no eligible writable repository' };
}

/**
 * 备仓判定（repofix42 幂等护栏的纯函数形态）：剔除现役行后对其余候选重跑
 * selectActiveRepository。返回 ok 即存在合格备仓——main 据此 noop 退出(successor-ready)、
 * 不再重复建仓（books-2-2..books-2-9 重复造仓的根因修复）；blocked 即无备仓，走建仓路径。
 * liftCapacityLedger 给新仓 github_size_bytes=0 且 granted，故新仓必过全部门禁（空仓压缩 size 为 0）。
 *
 * @param {Array<Record<string, unknown>>} rows 同 selectActiveRepository 的候选行
 * @param {number} activeRepositoryId 现役仓 id；非法（非正整数）即抛——失败关闭，不猜
 * @param {Date} now 显式时钟（同 selectActiveRepository，不读真实时间）
 */
export function selectSuccessor(rows, activeRepositoryId, now) {
  const id = Number(activeRepositoryId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`activeRepositoryId 非法: ${activeRepositoryId}`);
  return selectActiveRepository(rows.filter(row => Number(row.id) !== id), now);
}

/**
 * 候选行查询（**唯一一处** SQL 文本）：与 runtime-download/entry.ts 的 createRolloverEvidencePort
 * 同一组列。现役仓判定与备仓判定共用它——两处各写一遍 SQL 是 repofix42 前的漂移隐患
 * （一处补了新列、另一处没补 ⇒ 备仓判定按 undefined 走），故收敛成一个函数。
 */
export async function readCandidateRows(sql) {
  return await sql`
    SELECT r.id, r.owner, r.repo, r.branch, r.enabled, r.is_private, r.read_only, r.sealed_at,
           l.state AS ledger_state, l.baseline_epoch, l.target_bytes,
           l.registered_bytes, l.reserved_bytes,
           l.github_size_bytes, l.target_compressed_bytes,
           l.admission_status, l.admission_version, l.admission_valid_until, l.admission_target
    FROM storage_repositories r
    LEFT JOIN repository_capacity_ledger l ON l.repository_id = r.id
    ORDER BY r.id ASC`;
}

/** 读候选（列见 readCandidateRows），再按判据选现役仓。 */
export async function resolveActiveRepository(sql, now) {
  const rows = await readCandidateRows(sql);
  // 只记候选数量，不含仓名/凭据。
  console.log(JSON.stringify({ phase: 'candidates', count: rows.length }));
  return selectActiveRepository(rows, now);
}

/**
 * 阈值判定（纯函数，repothresh44 起**单一口径**：GitHub 压缩 pack 字节）。
 * 判定只读入参、不读时钟、不发网络，便于反例验证。
 *
 *   exceeded = sizeKib×1024 >= compressedTargetBytes × thresholdPct / 100
 *
 * - compressedTargetBytes：现役模式（--current-from-ledger）取台账行的 target_compressed_bytes
 *   ——与运行期 decideRepositoryForPublication 用的是同一个库同一列，故两边不可能各判一套；
 *   legacy 模式（--current=）无台账行可依，取 --compressed-target-bytes。
 * - 比较方向 >=（边界本身算过线），沿用旧 legacy 语义。
 * - 百分比在**字节**上取整（旧 legacy 先把目标 /1024 再乘百分比，会在 KiB 边界上算歪）。
 * - accounting（台账逻辑账）只喂 observation：旧口径的 used/threshold/exceeded 一并算出来供运维
 *   对照，**不参与判定**。legacy 模式传 null ⇒ observation 为 null。observation 里的任何异常
 *   （如逻辑目标非正）都不抛——观测值不该让探针失败关闭。
 *
 * @param {{ thresholdPct: number, sizeKib: number, compressedTargetBytes: bigint,
 *           accounting: {registeredBytes: bigint, reservedBytes: bigint, targetBytes: bigint,
 *                        githubSizeBytes: bigint, targetCompressedBytes: bigint}|null }} input
 */
export function evaluateThreshold({ thresholdPct, sizeKib, compressedTargetBytes, accounting }) {
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct >= 100) {
    throw new Error(`thresholdPct 必须在 (0,100), 得 ${thresholdPct}`);
  }
  // GitHub 报回非法 size（负数/NaN/小数）时不按 0 猜：0 会让满仓看起来空，探针于是永不建仓。
  if (!Number.isSafeInteger(sizeKib) || sizeKib < 0) {
    throw new Error(`sizeKib 非法: ${String(sizeKib).slice(0, 40)}`);
  }
  const target = BigInt(compressedTargetBytes);
  if (!(target > BigInt(0))) throw new Error(`compressedTargetBytes 非正: ${compressedTargetBytes}`);
  const compressedBytes = BigInt(sizeKib) * BigInt(1024);
  const thresholdCompressedBytes = target * BigInt(thresholdPct) / BigInt(100);
  let observation = null;
  if (accounting !== null && accounting !== undefined) {
    const usedLogicalBytes = BigInt(accounting.registeredBytes) + BigInt(accounting.reservedBytes);
    const accountingTargetBytes = BigInt(accounting.targetBytes);
    const thresholdLogicalBytes = accountingTargetBytes > BigInt(0)
      ? accountingTargetBytes * BigInt(thresholdPct) / BigInt(100) : null;
    observation = {
      usedLogicalBytes, accountingTargetBytes, thresholdLogicalBytes,
      logicalExceeded: thresholdLogicalBytes === null ? null : usedLogicalBytes >= thresholdLogicalBytes,
      // 台账里的压缩 size 是 sync 上一轮写的**滞后**值；与本次实时值并列，便于判断 sync 是否新鲜。
      ledgerGithubSizeBytes: BigInt(accounting.githubSizeBytes),
      ledgerTargetCompressedBytes: BigInt(accounting.targetCompressedBytes),
    };
  }
  return {
    metric: METRIC, exceeded: compressedBytes >= thresholdCompressedBytes,
    sizeKib, compressedBytes, thresholdCompressedBytes, compressedTargetBytes: target, observation,
  };
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

async function ignoreRepo(token, owner, repo) {
  // GitHub 默认自动 watch 新建仓库,20 worker 高频 push 会刷爆账号邮箱;
  // 建仓成功后立刻把自己设为 ignored(best-effort,失败不阻断建仓流程)
  try {
    const res = await ghFetch(token, 'PUT', `/repos/${owner}/${repo}/subscription`, { ignored: true });
    if (res.status !== 202) console.log(JSON.stringify({ phase: 'note', what: 'auto-ignore', repo: `${owner}/${repo}`, status: res.status, outcome: 'ignored-not-set' }));
  } catch (err) {
    console.log(JSON.stringify({ phase: 'note', what: 'auto-ignore', repo: `${owner}/${repo}`, outcome: 'failed-nonfatal', error: String(err && err.message).slice(0, 120) }));
  }
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

// 把新建仓在 capacity_ledger 升 ready/granted,让 rollover 决策立刻把它纳入候选。
// targetCompressedBytes 是必填参数（不给默认值）：让每个调用点都显式写出目标从哪来，
// 不靠「默认值恰好对」的记忆——容量口径漂移正是本任务要消灭的形态。
// github_size_bytes **不进列表**：走列默认 0（新仓确实是空的，首轮 sync-ledger-capacity 写真值），
// 且 DO UPDATE 也不碰它——绝不能把已观测到的压缩 size 重置回 0（那等于把满仓报成空仓）。
async function liftCapacityLedger(sql, repositoryId, branch, targetCompressedBytes) {
  const targetJson = JSON.stringify({ repositoryId, branch });
  return await sql`
    INSERT INTO repository_capacity_ledger
      (repository_id, state, target_bytes, registered_bytes, reserved_bytes, target_compressed_bytes, baseline_epoch, admission_status, admission_version, admission_valid_until, admission_target)
    VALUES
      (${repositoryId}::integer, 'ready', 1000000000::bigint, 0::bigint, 0::bigint, ${targetCompressedBytes.toString()}::bigint, 'm0001_capacity_init', 'granted', 'storage_repositories_writable_v1', NOW() + INTERVAL '30 days',
       ${targetJson}::jsonb)
    ON CONFLICT (repository_id) DO UPDATE
    SET state='ready',
        admission_status='granted',
        admission_version='storage_repositories_writable_v1',
        admission_valid_until=NOW() + INTERVAL '30 days',
        admission_target=EXCLUDED.admission_target,
        target_compressed_bytes=EXCLUDED.target_compressed_bytes,
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
        metric: METRIC, exit: 3 }));
      process.exitCode = 3;
      return;
    }
    owner = active.repository.owner;
    repo = active.repository.repo;
    activeRepositoryId = active.repository.id;
    accounting = active.accounting;
  }
  // 判定目标：现役模式跟台账行走（与运行期 decide 同值），legacy 模式跟 --compressed-target-bytes。
  const compressedTargetBytes = accounting ? accounting.targetCompressedBytes : cfg.compressedTargetBytes;
  const cur = await readRepoSizeKib(cfg.token, owner, repo);
  const verdict = evaluateThreshold({
    thresholdPct: cfg.thresholdPct, sizeKib: cur.sizeKib, compressedTargetBytes, accounting,
  });
  const probeLog = {
    phase: 'probe', current: `${owner}/${repo}`, repositoryId: activeRepositoryId,
    source: cfg.currentFromLedger ? 'ledger' : 'flag',
    metric: METRIC, thresholdPct: cfg.thresholdPct, mode: cfg.mode,
    // 两个压缩目标并列：台账行值（判定用）与 CLI 值（新仓种值用）。不等即口径漂移，一眼可见。
    compressedTargetBytes: compressedTargetBytes.toString(),
    cfgCompressedTargetBytes: cfg.compressedTargetBytes.toString(),
    // 旧逻辑口径目标一并展示（只作对照，不判定）。
    cfgTargetBytes: cfg.targetBytes.toString(),
  };
  console.log(JSON.stringify(probeLog));

  const probeResultLog = {
    phase: 'probe-result', metric: METRIC, sizeKib: cur.sizeKib, exceeded: verdict.exceeded,
    defaultBranch: cur.defaultBranch,
    compressedBytes: verdict.compressedBytes.toString(),
    thresholdCompressedBytes: verdict.thresholdCompressedBytes.toString(),
  };
  if (verdict.observation) {
    // 旧口径（台账逻辑字节）与台账里的滞后压缩值：只作运维对照，不参与 exceeded。
    const o = verdict.observation;
    probeResultLog.observationUsedLogicalBytes = o.usedLogicalBytes.toString();
    probeResultLog.observationThresholdLogicalBytes = o.thresholdLogicalBytes === null ? null : o.thresholdLogicalBytes.toString();
    probeResultLog.observationLogicalExceeded = o.logicalExceeded;
    probeResultLog.observationAccountingTargetBytes = o.accountingTargetBytes.toString();
    probeResultLog.observationLedgerGithubSizeBytes = o.ledgerGithubSizeBytes.toString();
    probeResultLog.observationLedgerTargetCompressedBytes = o.ledgerTargetCompressedBytes.toString();
  }
  console.log(JSON.stringify(probeResultLog));

  if (!verdict.exceeded) {
    console.log(JSON.stringify({ phase: 'done', status: 'below-threshold', metric: METRIC, exit: 2 }));
    process.exitCode = 2;
    return;
  }

  // 幂等护栏（repofix42）: 阈值已超但备仓已就绪 → noop 退出 0,不再建新仓。
  // 否则探针每小时都会重复造仓(books-2-2..books-2-9 的根因)。设计意图是探针在 85%
  // 处先于 decide 的 100% 切仓把下一个仓建好;建好之后到真正切仓之间的每一轮探针都应 noop。
  // 仅现役模式(activeRepositoryId 非空)可判;legacy --current= 模式无台账行,照旧直接走建仓路径。
  if (activeRepositoryId !== null) {
    // selectSuccessor 剔除现役行后按**同一组判据**（含压缩容量门槛）重选,返回 ok 即存在合格备仓
    // (liftCapacityLedger 给新仓 github_size_bytes=0 且 granted,必过全部门禁)。
    const rows = await readCandidateRows(sql);
    const successor = selectSuccessor(rows, activeRepositoryId, new Date());
    if (successor.status === 'ok') {
      console.log(JSON.stringify({ phase: 'done', status: 'successor-ready',
        successor: `${successor.repository.owner}/${successor.repository.repo}`, metric: METRIC }));
      return;
    }
  }

  const nextName = await findNextName(cfg.token, owner, repo);
  console.log(JSON.stringify({ phase: 'plan', nextRepo: `${owner}/${nextName}`, branch: cur.defaultBranch, metric: METRIC }));

  if (cfg.mode === 'dry-run') {
    console.log(JSON.stringify({ phase: 'done', status: 'dry-run', wouldCreate: `${owner}/${nextName}`, metric: METRIC }));
    return;
  }

  await createRepo(cfg.token, nextName);
  await ignoreRepo(cfg.token, owner, nextName);
  const rows = await registerStorageRepo(sql, owner, nextName, cur.defaultBranch);
  const id = rows[0]?.id ?? null;
  if (id === null) {
    // 并发双跑输的一方: 仓位行已存在,直接读 id 再 lift capacity
    const existing = await sql`SELECT id FROM storage_repositories WHERE lower(owner)=lower(${owner}) AND lower(repo)=lower(${nextName}) LIMIT 1`;
    const existingId = existing[0] ? Number(existing[0].id) : null;
    if (existingId) {
      await liftCapacityLedger(sql, existingId, cur.defaultBranch, cfg.compressedTargetBytes);
      console.log(JSON.stringify({ phase: 'done', status: 'applied', repo: `${owner}/${nextName}`, storageId: existingId, note: 'concurrent-skip-register lift-capacity', metric: METRIC }));
      return;
    }
    console.log(JSON.stringify({ phase: 'done', status: 'applied', repo: `${owner}/${nextName}`, storageId: 'concurrent-skip', note: '未找到既有行,跳过 lift', metric: METRIC }));
    return;
  }
  await liftCapacityLedger(sql, Number(id), cur.defaultBranch, cfg.compressedTargetBytes);
  console.log(JSON.stringify({ phase: 'done', status: 'applied', repo: `${owner}/${nextName}`, storageId: Number(id), capacity: 'ready/granted', metric: METRIC }));
}

// 仅当脚本被直接执行时才跑 main;被 import 时只暴露模块接口
const isDirect = process.argv[1] && (process.argv[1].endsWith('repo-auto-create.mjs') || process.argv[1].endsWith('repo-auto-create'));
if (isDirect) {
  main().catch(err => {
    console.error(JSON.stringify({ phase: 'error', error: (err && err.message) ? err.message.slice(0, 200) : String(err).slice(0, 200) }));
    process.exitCode = 1;
  });
}
