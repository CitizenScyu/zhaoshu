// zhuigeng42：追更 / 增量更新（v1）。
//
// 一轮 = 选候选（书架在读 × 最新 done × 无活动任务 × 到期）→ 串行探测目录 → 纯追加判定 →
// 入队 download_tasks → 写回探测状态。路由 POST /api/followup 由 phoenix 侧 timer 定期打。
//
// 三条硬约束贯穿本文件：
//   1. **只在「纯追加」时入队**：新目录章数变多，且前 N 章标题指纹逐字未变（followupPrefixKey）。
//      站方改写旧章标题、目录收缩、切到另一个源拿到不同目录 —— 全部判否（保守正确）。
//   2. **上游每源串行**：一轮内书逐本探测（不并发），单本源走 SourceRequestContext 的每源闸门。
//   3. **零新增 env**：复用既有 DATABASE_URL / CRON_SECRET，节奏常量在本文件。
//
// 指纹算法与客户端 reader-preferences.ts 的 catalogPrefixKey 同构（FNV-1a + djb2 双哈希、
// 0x1f 分隔符、带前缀长度）。**两边必须同改**：跨设备的前缀口径变了，两边算出的指纹就对不上，
// 表现是「进度锚点错位」而不是报错。

import { getSql, ensureSchema } from './db';
import { createDeadline } from './deadline';
import { resolveDownloadSource } from './download-source';
import { recordCronSuccess } from './source-health';
import { SourcePolicyError } from './source-policy';
import { probeCooldownSlots, resolveSourceBook, SourceReaderError, SourceRequestContext, type SourceCatalog } from './source-reader';
import type { SourceBookIdentity } from './source-parser';
import { getBuiltinRequestSource, getEngineSources, type ReadingSource } from './shuyuan';

type FollowupSql = ReturnType<typeof getSql>;

/** 一轮的墙钟预算（路由 maxDuration=60，留余量给鉴权与建表）。 */
export const FOLLOWUP_ROUND_BUDGET_MS = 45_000;
/** 单本书的探测预算：目录一次解析，超时即按失败退避，不拖住整轮。 */
export const FOLLOWUP_PROBE_BUDGET_MS = 15_000;
/** 每轮最多探测几本（串行，预算内跑不完的留到下一轮）。 */
export const FOLLOWUP_CANDIDATE_LIMIT = 6;
/** 无新章 / 探测失败的下次探测间隔基数；实际间隔按 followupBackoffMs 递增。 */
export const FOLLOWUP_BASE_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** 退避上限（连续 3 轮无进展即到顶：连载停了或站方长期不可达）。 */
export const FOLLOWUP_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * 重叠保护用的租约行（cron_health），与准入租约同结构、不同行名 → 两轮互不干扰。
 * ⚠️ 这行**不是**成功心跳：它的 last_success_at 存的是租约**到期时刻**（now()+TTL，未来时间），
 * 每轮开始时就被推进，跑没跑完都一样。判活用同表的 'followup' 行（见 runFollowupRound 尾部），
 * 健康端点与探针读的也是那一行——把租约行当心跳会让「timer 在打但每轮都失败」永远看不出来。
 */
export const FOLLOWUP_LEASE_ROW = 'followup_probe_lease';
export const FOLLOWUP_LEASE_TTL_MS = 50_000;
/** 成功心跳行名（obsfix45）。与 FOLLOWUP_LEASE_ROW 同表不同行，语义见 recordCronSuccess。 */
export const FOLLOWUP_HEALTH_ROW = 'followup';

/**
 * 把多个取消信号合成一个。刻意不用 AbortSignal.any：仓里 lib.dom 声明缺 any() 的重载，
 * 用它会在 tsc --noEmit 上新增两条与存量同类的报错。
 */
function linkSignals(signals: AbortSignal[]): AbortSignal {
  const merged = new AbortController();
  const abort = () => { for (const signal of signals) if (signal.aborted) return merged.abort(signal.reason); };
  for (const signal of signals) {
    if (signal.aborted) { merged.abort(signal.reason); break; }
    signal.addEventListener('abort', abort, { once: true });
  }
  return merged.signal;
}

/** 单次探测里同一源两次请求的最小间隔；一轮内书与书共享（与扇出 probe 同口径的每源串行）。 */
const FOLLOWUP_THROTTLE_SLOTS = new Map<string, number>();
const PROBE_REQUEST_LIMIT = 12;

/** 上一次已知的目录状态；null = 从未探测过（本轮只记基线）。 */
export interface FollowupBaseline {
  chapterCount: number | null;
  prefixHash: string;
}

export type FollowupVerdictKind = 'baseline' | 'appended' | 'unchanged' | 'rebased';
export interface FollowupVerdict {
  kind: FollowupVerdictKind;
  /** 本轮之后应当记下的基线指纹（appended 时是新目录的整本指纹）。 */
  prefixHash: string;
  chapterCount: number;
}

/**
 * 目录前缀指纹：把 titles[0..count-1] 按序混入两个独立的 32 位哈希，并带上前缀长度。
 * 与 reader-preferences.ts 的 catalogPrefixKey 逐字同算法（含 0x1f 分隔符：避免
 * ['ab','c'] 与 ['a','bc'] 拼出同一指纹）。
 */
export function followupPrefixKey(titles: readonly string[], count: number): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < count; i++) {
    const title = titles[i] ?? '';
    for (let j = 0; j < title.length; j++) {
      const code = title.charCodeAt(j);
      a = Math.imul(a ^ code, 0x01000193);
      b = (Math.imul(b, 33) + code) | 0;
    }
    a = Math.imul(a ^ 0x1f, 0x01000193);
    b = (Math.imul(b, 33) + 0x1f) | 0;
  }
  return `${count}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/**
 * 纯追加判定。纯函数：入参是新目录的章节标题与旧基线，返回这一轮该怎么处理。
 * 任何不确定的情形都归到不入队的分支（rebased / unchanged）——追更的收益是多抓一次，
 * 误判的代价是全书重抓 + 版本前移 + 书架亮更新，保守一侧永远划算。
 */
export function decideFollowup(baseline: FollowupBaseline, titles: readonly string[]): FollowupVerdict {
  const count = titles.length;
  const oldCount = baseline.chapterCount;
  // 首轮（或旧行缺指纹）：只记基线。没有旧目录就没有「追加」的证据。
  if (oldCount === null || !baseline.prefixHash) {
    return { kind: 'baseline', prefixHash: followupPrefixKey(titles, count), chapterCount: count };
  }
  // 目录收缩：站方删章 / 换了另一份目录。不入队，按新目录重建基线。
  if (count < oldCount) return { kind: 'rebased', prefixHash: followupPrefixKey(titles, count), chapterCount: count };
  if (followupPrefixKey(titles, oldCount) === baseline.prefixHash) {
    if (count === oldCount) return { kind: 'unchanged', prefixHash: baseline.prefixHash, chapterCount: count };
    return { kind: 'appended', prefixHash: followupPrefixKey(titles, count), chapterCount: count };
  }
  // 前缀指纹断：站方改写了旧章标题（哪怕章数没少）。按新目录重建基线，绝不入队。
  return { kind: 'rebased', prefixHash: followupPrefixKey(titles, count), chapterCount: count };
}

/**
 * 退避节奏：连续 N 轮「没入队」（无新章与探测失败都算）⇒ 间隔 4h·2^N，封顶 24h。
 * 入队成功即计数清零（回到 4h）。连载完结没有可靠信号，软退避到 24h 一轮是 v1 的取舍。
 */
export function followupBackoffMs(consecutiveNoNew: number): number {
  const rounds = Number.isSafeInteger(consecutiveNoNew) && consecutiveNoNew > 0 ? consecutiveNoNew : 0;
  return Math.min(FOLLOWUP_BASE_INTERVAL_MS * 2 ** Math.min(rounds, 8), FOLLOWUP_MAX_INTERVAL_MS);
}

export interface FollowupCandidate {
  userId: number;
  bookId: number;
  title: string;
  author: string;
  sourceUrl: string;
  sourceKind: string;
  sourceId: string | null;
  sourceRevision: string;
  lastChapterCount: number | null;
  lastTocPrefixHash: string;
  consecutiveNoNew: number;
}

/**
 * 候选 = （用户读过这本书某一版全文）∩（该用户该书最新任务 done）∩（无 pending/running）
 * ∩（到期的探测状态，无行视为到期）。
 *
 * 「在读」用 reader_sync_state 的进度项与 **done 任务 id** 的对应关系表达：进度项 item_key 是
 * `progress:novel-finder-reading-progress-u<uid>-<taskId>`（见 user-scope.ts / reader-sync.ts），
 * 所以「这个用户读过这本书的某一版全文」= 存在一条进度项指向该 (用户, 书) 的 done 任务。
 * 用**任意一版**而不是最新一版：追更入队后最新 done 任务 id 会变，用户还没重新打开书时若
 * 只认最新一版，这本书会立刻掉出候选、再也不会被追更。
 *
 * 任务归属用 requested_by='user'（与 /api/download 同一口径）：download_tasks 的
 * request_identity_check 禁止 system 任务带 user_id，而追更要入到**在读那个用户**名下，
 * 书架的下载列表与续读入口才看得到这单。代价是没有 enqueue_key 的事件级去重（那个唯一索引
 * 只覆盖 requested_by='system'），改由同一 (user_id, book_id) 的活动任务唯一索引兜底 ——
 * 与 /api/download 的 409 冲突同源。
 */
export function followupCandidatesQuery(sql: FollowupSql, limit: number) {
  return sql`
    WITH done_tasks AS (
      SELECT id, user_id, book_id, title, author, source_url, source_kind, source_id, source_revision, created_at
      FROM download_tasks
      WHERE status = 'done' AND requested_by = 'user' AND user_id IS NOT NULL
    ), reading AS (
      SELECT DISTINCT t.user_id, t.book_id
      FROM reader_sync_state s JOIN done_tasks t
        ON t.user_id = s.user_id
       AND s.item_key = 'progress:novel-finder-reading-progress-u' || t.user_id::text || '-' || t.id::text
    ), latest AS (
      SELECT DISTINCT ON (t.user_id, t.book_id)
        t.user_id, t.book_id, t.title, t.author, t.source_url, t.source_kind, t.source_id, t.source_revision
      FROM done_tasks t
      ORDER BY t.user_id, t.book_id, t.created_at DESC, t.id DESC
    )
    SELECT l.user_id, l.book_id, l.title, l.author, l.source_url, l.source_kind, l.source_id, l.source_revision,
      s.last_chapter_count, s.last_toc_prefix_hash, s.consecutive_no_new
    FROM latest l
    JOIN reading r ON r.user_id = l.user_id AND r.book_id = l.book_id
    JOIN labeled_books b ON b.id = l.book_id AND b.source_url <> ''
    LEFT JOIN followup_probe_state s ON s.book_id = l.book_id
    WHERE NOT EXISTS (
      SELECT 1 FROM download_tasks a
      WHERE a.user_id = l.user_id AND a.book_id = l.book_id AND a.status IN ('pending', 'running')
    )
      AND (s.next_probe_at IS NULL OR s.next_probe_at <= now())
    ORDER BY s.next_probe_at NULLS FIRST, l.user_id, l.book_id
    LIMIT ${limit}`;
}

export interface FollowupProbeOutcome {
  ok: boolean;
  /** 新目录的章节标题（判定需要「前 N 章」指纹，故整份标题表带回来，不只带整本指纹）。 */
  titles: string[];
  /** ok=false 时的有限分类，只进日志与计数，不进对外文案。 */
  reason?: string;
}

/** 探测依赖的上游取源：失败（源退役 / 不在池 / host 门拒）一律按探测失败退避。 */
export type FollowupSourceResolver = (candidate: FollowupCandidate, signal: AbortSignal) => Promise<ReadingSource | null>;

/** 把 done 任务登记过的来源还原成可探测的 ReadingSource（与 /api/download 同一来源口径）。 */
export const defaultFollowupSourceResolver: FollowupSourceResolver = async (candidate, signal) => {
  let resolved: Awaited<ReturnType<typeof resolveDownloadSource>>;
  try {
    resolved = await resolveDownloadSource(candidate.sourceUrl);
  } catch (error) {
    if (error instanceof SourcePolicyError) return null;
    throw error;
  }
  if (resolved.kind === 'builtin') {
    return getBuiltinRequestSource(new URL(resolved.url).hostname, signal);
  }
  const pool = await getEngineSources(signal);
  return pool.find((source) => source.url === resolved.id) ?? null;
};

/**
 * 探测一本书的目录：单本源解析（不走整池遍历），取章节标题供判定。
 * 任何上游失败都归 ok=false —— 追更链路对用户不可见，绝不因一次源故障抛到路由层。
 */
export async function probeFollowupCatalog(
  candidate: FollowupCandidate,
  resolveSource: FollowupSourceResolver,
  signal: AbortSignal,
): Promise<FollowupProbeOutcome> {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), FOLLOWUP_PROBE_BUDGET_MS);
  (timer as { unref?: () => void }).unref?.();
  const probeSignal = linkSignals([signal, budget.signal]);
  try {
    const source = await resolveSource(candidate, probeSignal);
    if (!source) return { ok: false, titles: [], reason: 'source_unavailable' };
    const context = new SourceRequestContext(probeSignal, PROBE_REQUEST_LIMIT, {
      throttleSlots: FOLLOWUP_THROTTLE_SLOTS,
      // 46-revfix：冷却表与 probe / 阅读根 context 同一张（进程级共享）。此前 followup 只共享节流
      // 不共享冷却 —— probe 吃到的 429 冷却对追更探测不可见，定时器一轮会对同一站重打。必须同一张表
      // 才走 sharedCooldownUntil 的 10 分钟钳制（Retry-After 投毒防线），不能另建 FOLLOWUP_COOLDOWN_SLOTS。
      cooldownSlots: probeCooldownSlots(),
    });
    try {
      const catalog: SourceCatalog = await resolveSourceBook(
        { title: candidate.title, author: candidate.author } satisfies SourceBookIdentity,
        context,
        { sources: [source], deferNotFoundWarnings: true },
      );
      return { ok: true, titles: catalog.chapters.map((chapter) => chapter.title) };
    } catch (error) {
      probeSignal.throwIfAborted();
      return { ok: false, titles: [], reason: probeFailureReason(error) };
    }
  } catch (error) {
    // 整轮取消（父 signal）向上抛；取源阶段的意外错误按探测失败兜住。
    signal.throwIfAborted();
    void error;
    return { ok: false, titles: [], reason: 'probe_failed' };
  } finally {
    clearTimeout(timer);
  }
}

function probeFailureReason(error: unknown): string {
  if (error instanceof SourceReaderError) return error.code;
  if (error instanceof SourcePolicyError) return 'SOURCE_REJECTED';
  return 'probe_failed';
}

/** 写回探测状态（探测成功时）。intervalMs 由本轮判定给出：入队清零计数、其余按退避递增。 */
export function saveProbeStateQuery(
  sql: FollowupSql,
  row: { bookId: number; chapterCount: number; prefixHash: string; consecutiveNoNew: number; intervalMs: number; taskId: number | null },
) {
  return sql`
    INSERT INTO followup_probe_state
      (book_id, last_probe_at, last_chapter_count, last_toc_prefix_hash, consecutive_no_new, next_probe_at, last_enqueued_task_id, updated_at)
    VALUES (${row.bookId}, now(), ${row.chapterCount}, ${row.prefixHash}, ${row.consecutiveNoNew},
      now() + (${row.intervalMs}::bigint * interval '1 millisecond'), ${row.taskId}, now())
    ON CONFLICT (book_id) DO UPDATE SET
      last_probe_at = EXCLUDED.last_probe_at,
      last_chapter_count = EXCLUDED.last_chapter_count,
      last_toc_prefix_hash = EXCLUDED.last_toc_prefix_hash,
      consecutive_no_new = EXCLUDED.consecutive_no_new,
      next_probe_at = EXCLUDED.next_probe_at,
      last_enqueued_task_id = COALESCE(EXCLUDED.last_enqueued_task_id, followup_probe_state.last_enqueued_task_id),
      updated_at = now()
    RETURNING book_id`;
}

/** 探测失败也要写状态：推进 last_probe_at 与退避，让这本书不再每轮都被选中。 */
export function saveProbeFailureQuery(
  sql: FollowupSql,
  row: { bookId: number; consecutiveNoNew: number; intervalMs: number },
) {
  return sql`
    INSERT INTO followup_probe_state (book_id, last_probe_at, consecutive_no_new, next_probe_at, updated_at)
    VALUES (${row.bookId}, now(), ${row.consecutiveNoNew},
      now() + (${row.intervalMs}::bigint * interval '1 millisecond'), now())
    ON CONFLICT (book_id) DO UPDATE SET
      last_probe_at = EXCLUDED.last_probe_at,
      consecutive_no_new = EXCLUDED.consecutive_no_new,
      next_probe_at = EXCLUDED.next_probe_at,
      updated_at = now()
    RETURNING book_id`;
}

/**
 * 入队：与 /api/download 同一口径的用户任务（requested_by='user' + 该 done 行的 user_id，
 * 源四件套沿用 done 行 —— worker 只读 source_kind 与 source_url，id/revision 是记账）。
 * 活动任务唯一索引 download_tasks_user_active_book_idx 在库级兜底并发重复入队；23505 视作
 * 「已有活动任务」而非错误（与下载路由的冲突处理同款）。
 */
export function enqueueFollowupTaskQuery(sql: FollowupSql, candidate: FollowupCandidate) {
  return sql`
    INSERT INTO download_tasks
      (user_id, book_id, title, author, source_url, status, requested_by, source_kind, source_id, source_revision)
    VALUES (${candidate.userId}, ${candidate.bookId}, ${candidate.title}, ${candidate.author},
      ${candidate.sourceUrl}, 'pending', 'user', ${candidate.sourceKind}, ${candidate.sourceId}, ${candidate.sourceRevision})
    ON CONFLICT (user_id, book_id) WHERE status IN ('pending', 'running') DO NOTHING
    RETURNING id`;
}

export type FollowupLeaseHandle = { generation: string };

/**
 * 领租约：单条语句原子领取（行不存在→插入 / 已过期→抢占 / 未过期→拿不到），形状照准入租约。
 * 领取失败（库抖动）按未领到处理——fail closed：本轮不探，绝不在拿不准互斥时并发探测。
 */
export async function claimFollowupLease(sql: FollowupSql): Promise<FollowupLeaseHandle | null> {
  try {
    const rows = await sql`
      INSERT INTO cron_health (name, last_success_at, lease_generation)
      VALUES (${FOLLOWUP_LEASE_ROW}, now() + ${FOLLOWUP_LEASE_TTL_MS}::int * interval '1 millisecond', 1)
      ON CONFLICT (name) DO UPDATE SET
        last_success_at = EXCLUDED.last_success_at,
        lease_generation = cron_health.lease_generation + 1
      WHERE cron_health.last_success_at <= now()
        AND cron_health.lease_generation >= 0
        AND cron_health.lease_generation < 9223372036854775807
      RETURNING lease_generation::text AS generation` as { generation: string | null }[];
    const generation = rows[0]?.generation;
    if (typeof generation === 'string' && /^[1-9][0-9]{0,18}$/.test(generation)) return { generation };
  } catch {
    // 领取失败按未领到处理（fail closed）。
  }
  return null;
}

/** 候选查询的库侧行形状（驱动返回列名，不做自动驼峰化）。 */
interface FollowupCandidateRow {
  user_id: number; book_id: number; title: string; author: string; source_url: string;
  source_kind: string; source_id: string | null; source_revision: string;
  last_chapter_count: number | null; last_toc_prefix_hash: string | null; consecutive_no_new: number | null;
}

function candidateOf(row: FollowupCandidateRow): FollowupCandidate {
  return {
    userId: row.user_id, bookId: row.book_id, title: row.title, author: row.author, sourceUrl: row.source_url,
    sourceKind: row.source_kind, sourceId: row.source_id, sourceRevision: row.source_revision,
    lastChapterCount: row.last_chapter_count, lastTocPrefixHash: row.last_toc_prefix_hash ?? '',
    consecutiveNoNew: row.consecutive_no_new ?? 0,
  };
}

export interface FollowupRoundReport {
  skipped?: 'lease';
  candidates: number;
  probed: number;
  enqueued: number;
  rebased: number;
  failed: number;
  /** 逐本处置记录（只留 id 与分类，不带书名/作者/URL）。 */
  items: { bookId: number; outcome: FollowupVerdictKind | 'probe_failed' | 'deduped'; taskId: number | null }[];
  elapsedMs: number;
}

export interface FollowupRoundDeps {
  resolveSource?: FollowupSourceResolver;
  /** 单本源解析的可注入实现（测试用假目录，不发上游请求）。 */
  probe?: (candidate: FollowupCandidate, resolveSource: FollowupSourceResolver, signal: AbortSignal) => Promise<FollowupProbeOutcome>;
}

/**
 * 一轮追更。并发保护两层：cron_health 租约（与准入轮同形状、同一张表不同行 → 两轮互不干扰）
 * + 候选行的 next_probe_at 到期判据（即便租约被时钟骗过，重复轮也只会拿到已推进、不再到期���行）。
 * 租约拿不到直接返回，绝不并发探测。书与书之间串行，每本源每次一条目录请求。
 */
export async function runFollowupRound(parentSignal?: AbortSignal, deps: FollowupRoundDeps = {}): Promise<FollowupRoundReport> {
  const startedAt = Date.now();
  const budget = createDeadline(FOLLOWUP_ROUND_BUDGET_MS);
  const signal = parentSignal ? linkSignals([parentSignal, budget.signal]) : budget.signal;
  const sql = getSql();
  try {
    await ensureSchema();
    const lease = await claimFollowupLease(sql);
    if (!lease) return { skipped: 'lease', candidates: 0, probed: 0, enqueued: 0, rebased: 0, failed: 0, items: [], elapsedMs: Date.now() - startedAt };
    const resolveSource = deps.resolveSource ?? defaultFollowupSourceResolver;
    const probe = deps.probe ?? probeFollowupCatalog;
    const report: FollowupRoundReport = { candidates: 0, probed: 0, enqueued: 0, rebased: 0, failed: 0, items: [], elapsedMs: 0 };
    // 驱动返回的是库列名（snake_case），映射到候选形状只在这一处发生。
    const rows = await followupCandidatesQuery(sql, FOLLOWUP_CANDIDATE_LIMIT) as unknown as FollowupCandidateRow[];
    const candidates = rows.map(candidateOf);
    report.candidates = candidates.length;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      report.probed += 1;
      const outcome = await probe(candidate, resolveSource, signal);
      const handled = await processFollowupCandidate(sql, candidate, outcome);
      report.items.push({ bookId: candidate.bookId, outcome: handled.outcome, taskId: handled.taskId });
      if (handled.outcome === 'appended') report.enqueued += 1;
      else if (handled.outcome === 'rebased') report.rebased += 1;
      else if (handled.outcome === 'probe_failed') report.failed += 1;
    }
    // obsfix45：真跑完一轮才记成功心跳（上面的 skipped:'lease' 分支不记）。候选为 0 也记——
    // 「这一轮没有到期候选」是正常空转，心跳要证明的是 timer/路由/库这条链活着。
    // recordCronSuccess 自己吞异常，写不进心跳不会把追更轮打挂。
    await recordCronSuccess(FOLLOWUP_HEALTH_ROW);
    return { ...report, elapsedMs: Date.now() - startedAt };
  } finally {
    budget.dispose();
  }
}

/**
 * 单本处置：探测结果 → 判定 → （纯追加时）入队 → 写回探测状态。
 * 与 runner 分开是为了让这一段（判定 + 入队 + 退避写库）能在真库上被直接驱动测。
 */
export async function processFollowupCandidate(
  sql: FollowupSql,
  candidate: FollowupCandidate,
  outcome: FollowupProbeOutcome,
): Promise<{ outcome: FollowupVerdictKind | 'probe_failed' | 'deduped'; taskId: number | null }> {
  if (!outcome.ok) {
    const consecutive = (candidate.consecutiveNoNew ?? 0) + 1;
    await saveProbeFailureQuery(sql, {
      bookId: candidate.bookId, consecutiveNoNew: consecutive, intervalMs: followupBackoffMs(consecutive),
    });
    return { outcome: 'probe_failed', taskId: null };
  }
  const verdict = decideFollowup(
    { chapterCount: candidate.lastChapterCount, prefixHash: candidate.lastTocPrefixHash },
    outcome.titles,
  );
  if (verdict.kind !== 'appended') {
    const consecutive = (candidate.consecutiveNoNew ?? 0) + 1;
    await saveProbeStateQuery(sql, {
      bookId: candidate.bookId, chapterCount: verdict.chapterCount, prefixHash: verdict.prefixHash,
      consecutiveNoNew: consecutive, intervalMs: followupBackoffMs(consecutive), taskId: null,
    });
    return { outcome: verdict.kind, taskId: null };
  }
  const taskId = await enqueueFollowupTask(sql, candidate);
  // 入队被库级唯一索引挡下（已有同书活动任务）：状态照写、基线推进到新目录，
  // 但退避计数不清零 —— 没入队成功就不该享受 4h 的连载节奏。
  const consecutive = taskId === null ? (candidate.consecutiveNoNew ?? 0) + 1 : 0;
  await saveProbeStateQuery(sql, {
    bookId: candidate.bookId, chapterCount: verdict.chapterCount, prefixHash: verdict.prefixHash,
    consecutiveNoNew: consecutive, taskId,
    intervalMs: taskId === null ? followupBackoffMs(consecutive) : FOLLOWUP_BASE_INTERVAL_MS,
  });
  return { outcome: taskId === null ? 'deduped' : 'appended', taskId };
}

/**
 * 入队并返回新任务 id；已有同书活动任务（库级唯一索引 23505，或候选判据过期后被别人插队）
 * 时返回 null —— 调用方据此记 deduped，不当错误。
 */
export async function enqueueFollowupTask(sql: FollowupSql, candidate: FollowupCandidate): Promise<number | null> {
  try {
    const rows = await enqueueFollowupTaskQuery(sql, candidate) as { id: number }[];
    return rows[0]?.id ?? null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return null;
    throw error;
  }
}
