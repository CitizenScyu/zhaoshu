// 终态未完成书的有界重排（requeue1104）：书库只列 done 的书之后，系统任务落 partial/failed
// 的书就看不到了。这里给 owner 一个有界补救入口：给「最近一条系统任务是终态未完成、
// 全库没有任何 done、也没有活动系统任务」的书各插一条**全新**系统任务（attempt_count=1，
// 重新拿满 SOURCE_RETRY_MAX_ATTEMPTS 次退避），交给下载机队重下。
//
// 红线不变：重排只是再给一次机会，下载结果仍走原有零发布规则——缺章（partial）不发布、
// 不进书库（DOWNLOAD_GAP_PUBLISH=1 时只缺 ≤3 章且 ≤2% 的例外：占位发布，书库标「缺 N 章」）。
// 付费墙源（PAYWALL_HOSTS）打标的书全池无免费镜像，默认不重排，免得空烧出网。
//
// 事件键：`${id}:${policyVersion}:${sourceRevision}`，与 importer / 补账同一表达式；
// sourceRevision 由调用方给定（如 requeue-20261104），同一 revision 重放幂等，
// 已用过该 revision 的书不再被选中（不会让 LIMIT 反复挑到插不进去的行）。
// 单条语句 = 单个事务；dryRun 时插入 CTE 的条件恒假，只返回统计。

import { TEMPORARY_FAILURE_TTL_MS } from './download-source-candidates';
import { DEFAULT_POLICY_VERSION, type ImporterSql } from './importer-enqueue';
import { PAYWALL_HOSTS } from './source-host-health';

export const REQUEUE_MAX_LIMIT = 500;
const REVISION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** 失败原因码（从 error 文本里取第一个已知码）；未知归 other。 */
export const REQUEUE_REASONS = [
  'preview_truncated', 'no_candidates', 'source_unavailable', 'missing_chapters', 'invalid_chapter',
  'host_breaker', 'host_occupied', 'download_failed', 'toc_below_floor',
] as const;

export interface RequeueOptions {
  sourceRevision: string;
  limit: number;
  dryRun: boolean;
  /** 默认 false：付费墙源打标的书不重排。 */
  includePaywall?: boolean;
  /** 只重排这些原因码（空 = 不限）；other 表示未识别的原因。 */
  reasons?: string[];
  policyVersion?: string;
}

export interface RequeueResult {
  dryRun: boolean;
  sourceRevision: string;
  /** 符合条件（未按付费墙/原因过滤）的书数。 */
  eligible: number;
  /** 其中付费墙源打标的书数。 */
  paywall: number;
  /** 过滤后、按 limit 截取的书数。 */
  selected: number;
  /** 实际插入的新系统任务数（dryRun 恒 0）。 */
  inserted: number;
  /** tocfloor1111：nofloor- 重排挪出失败记忆窗口的闸门源数（其他前缀恒 0）。 */
  reopened: number;
  byHost: { host: string; n: number }[];
  byReason: { reason: string; n: number }[];
}

export function isValidRequeueRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value);
}

export async function requeueUnfinishedBooks(sql: ImporterSql, options: RequeueOptions): Promise<RequeueResult> {
  if (!isValidRequeueRevision(options.sourceRevision)) throw new Error('sourceRevision is invalid');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > REQUEUE_MAX_LIMIT) {
    throw new Error('limit is invalid');
  }
  const policy = (options.policyVersion ?? DEFAULT_POLICY_VERSION).trim();
  if (!policy) throw new Error('policyVersion is invalid');
  const revision = options.sourceRevision;
  const paywall = JSON.stringify(PAYWALL_HOSTS);
  const reasons = JSON.stringify(options.reasons ?? []);
  const reasonCodes = REQUEUE_REASONS.join('|');
  const rows = await sql`
    WITH last AS (
      SELECT DISTINCT ON (dt.book_id) dt.book_id, dt.status, dt.error
      FROM download_tasks dt WHERE dt.requested_by = 'system'
      ORDER BY dt.book_id, dt.id DESC
    ), cand AS (
      SELECT lb.id, lb.title, lb.author, lb.source_url,
             COALESCE(lower(substring(lb.source_url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)')), '') AS host,
             COALESCE(substring(last.error from ${`(${reasonCodes})`}), 'other') AS reason
      FROM labeled_books lb JOIN last ON last.book_id = lb.id
      WHERE last.status IN ('failed', 'partial', 'superseded_by_incomplete')
        AND NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = lb.id AND d.status = 'done')
        AND NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = lb.id
                          AND d.requested_by = 'system' AND d.status IN ('pending', 'running'))
        AND NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.requested_by = 'system'
                          AND d.enqueue_key = lb.id::text || ':' || ${policy} || ':' || ${revision})
    ), flagged AS (
      SELECT c.*, c.host IN (SELECT jsonb_array_elements_text(${paywall}::jsonb)) AS paywall FROM cand c
    ), picked AS (
      SELECT * FROM flagged f
      WHERE (${options.includePaywall === true} OR NOT f.paywall)
        AND (jsonb_array_length(${reasons}::jsonb) = 0
             OR f.reason IN (SELECT jsonb_array_elements_text(${reasons}::jsonb)))
      ORDER BY f.id DESC
      LIMIT ${options.limit}
    ), inserted AS (
      INSERT INTO download_tasks
        (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision, policy_version, enqueue_key)
      SELECT NULL, p.id, p.title, p.author, p.source_url, 'pending', 'system',
             'builtin', NULL, ${revision}, ${policy},
             p.id::text || ':' || ${policy} || ':' || ${revision}
      FROM picked p
      WHERE ${!options.dryRun}
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id, book_id
    ), reopened AS (
      -- tocfloor1111：nofloor- 重排是不带章数下限的逃生任务；同一语句把闸门拒过的源挪出 temporary 失败记忆
      -- 窗口，否则这条任务 48h 内选不回它们（与 nosrc-tool.sh enqueue 同口径）。
      UPDATE download_source_candidates c
      SET updated_at = now() - (${TEMPORARY_FAILURE_TTL_MS + 3_600_000}::bigint * interval '1 millisecond')
      WHERE ${revision.startsWith('nofloor-')} AND c.book_id IN (SELECT book_id FROM inserted)
        AND c.failure = 'temporary' AND c.failure_reason = 'toc_below_floor'
        AND c.updated_at > now() - (${TEMPORARY_FAILURE_TTL_MS}::bigint * interval '1 millisecond')
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM flagged) AS eligible,
           (SELECT count(*)::int FROM flagged WHERE paywall) AS paywall,
           (SELECT count(*)::int FROM picked) AS selected,
           (SELECT count(*)::int FROM inserted) AS inserted,
           (SELECT count(*)::int FROM reopened) AS reopened,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('host', host, 'n', n) ORDER BY n DESC, host), '[]'::jsonb)
              FROM (SELECT host, count(*)::int AS n FROM flagged GROUP BY host ORDER BY n DESC, host LIMIT 30) h) AS by_host,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('reason', reason, 'n', n) ORDER BY n DESC, reason), '[]'::jsonb)
              FROM (SELECT reason, count(*)::int AS n FROM flagged GROUP BY reason) r) AS by_reason`;
  const row = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []))[0] as Record<string, unknown> ?? {};
  return {
    dryRun: options.dryRun,
    sourceRevision: revision,
    eligible: Number(row.eligible ?? 0),
    paywall: Number(row.paywall ?? 0),
    selected: Number(row.selected ?? 0),
    inserted: Number(row.inserted ?? 0),
    reopened: Number(row.reopened ?? 0),
    byHost: Array.isArray(row.by_host) ? row.by_host as RequeueResult['byHost'] : [],
    byReason: Array.isArray(row.by_reason) ? row.by_reason as RequeueResult['byReason'] : [],
  };
}

// 试读本下架（demote1104）：tailwall1104 之前已按 done 发布的「免费前段 + 付费预览尾段」书，
// 由 owner 给出任务 id（只读扫描书尾连续短章得出），把这些**系统** done 任务改成
// partial / preview_truncated——书库与在线阅读只认 done，于是下架；GitHub 上的文件与
// artifact 指针原样不动。随后可用 requeueUnfinishedBooks（reasons=['preview_truncated']）重排换源。
// restore=true 反向恢复：只认 partial + preview_truncated 且仍挂 artifact 的行（引擎自己判的
// preview_truncated 零发布、无 artifact，不会被误恢复成 done）。单语句；dryRun 只统计。
export const DEMOTE_MAX_IDS = 500;

export interface DemoteOptions { taskIds: number[]; dryRun: boolean; restore?: boolean }
export interface DemoteResult { dryRun: boolean; restore: boolean; requested: number; matched: number; updated: number }

export async function demotePreviewTasks(sql: ImporterSql, options: DemoteOptions): Promise<DemoteResult> {
  const ids = [...new Set(options.taskIds)];
  if (!ids.length || ids.length > DEMOTE_MAX_IDS || !ids.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('taskIds is invalid');
  }
  const restore = options.restore === true;
  const rows = await sql`
    WITH target AS (
      SELECT dt.id FROM download_tasks dt
      WHERE dt.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::bigint)
        AND dt.requested_by = 'system'
        AND CASE WHEN ${restore}
              THEN dt.status = 'partial' AND dt.error = 'preview_truncated' AND to_jsonb(dt)->>'artifact_id' IS NOT NULL
              ELSE dt.status = 'done' END
    ), updated AS (
      UPDATE download_tasks d
      SET status = CASE WHEN ${restore} THEN 'done' ELSE 'partial' END,
          error = CASE WHEN ${restore} THEN '' ELSE 'preview_truncated' END,
          updated_at = now()
      FROM target t WHERE d.id = t.id AND ${!options.dryRun}
      RETURNING d.id
    )
    SELECT (SELECT count(*)::int FROM target) AS matched, (SELECT count(*)::int FROM updated) AS updated`;
  const row = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []))[0] as Record<string, unknown> ?? {};
  return {
    dryRun: options.dryRun, restore, requested: ids.length,
    matched: Number(row.matched ?? 0), updated: Number(row.updated ?? 0),
  };
}
