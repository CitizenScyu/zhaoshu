// bsrcfix-41：builtin 回退候选源持久化与跨实例 host 占位（migrations/0005 三表），全部经 neon sql tag。
// 失败分类：identity_mismatch* ⇒ permanent，其余 ⇒ temporary。两类同为失败记忆：usable 只回 failure=''，
// 补扫按 failedCandidateSources 以 source_url 单源排除、换其他源补齐，不每轮扫回同坏源；
// permanent 只废单个 (book, source)，同 host 其他 URL 不连带禁掉。
// 占位/预取认领以 expires_at 判过期、原子接管，无需清理器。错误消息只含原因码，不含 URL/书名/作者。

import type { neon } from '@neondatabase/serverless';

export type CandidateSql = ReturnType<typeof neon>;

export type CandidateFailureKind = '' | 'permanent' | 'temporary';

export interface SourceCandidateRow {
  source_url: string;
  host: string;
  position: number;
  failure: CandidateFailureKind;
}

/** 从 URL 取 host；解析失败回 ''（与 builtin-fallback 的 hostOf 同口径）。 */
export const candidateHostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

/** 读某本书的可用候选源（position 升序）；已失败（temporary/permanent）的行不回——recall 不重试坏源。 */
export async function usableSourceCandidates(sql: CandidateSql, bookId: number): Promise<SourceCandidateRow[]> {
  const rows = await sql`
    SELECT source_url, host, position, failure
    FROM download_source_candidates
    WHERE book_id = ${bookId} AND failure = ''
    ORDER BY position, source_url` as unknown as SourceCandidateRow[];
  return rows;
}

/** 该书已失败候选（temporary/permanent）的 source_url 集——补扫按单源精确排除，不禁整个 host。 */
export async function failedCandidateSources(sql: CandidateSql, bookId: number): Promise<Set<string>> {
  const rows = await sql`
    SELECT DISTINCT source_url FROM download_source_candidates
    WHERE book_id = ${bookId} AND failure <> ''` as unknown as { source_url: string }[];
  return new Set(rows.map(row => row.source_url));
}

/** 选源结果落库：先锁 book 行（与 markCandidateFailure 同序，写侧互斥）；只删未失败旧行，新行不重置已失败行。 */
export async function replaceSourceCandidates(
  sql: CandidateSql,
  bookId: number,
  sources: string[],
): Promise<void> {
  if (!sources.length) return;
  const rows = sources.map(url => ({ url, host: candidateHostOf(url) }));
  const urls = rows.map(row => row.url);
  const hosts = rows.map(row => row.host);
  await sql.transaction(tx => [
    tx`SELECT id FROM labeled_books WHERE id = ${bookId} FOR UPDATE`,
    tx`DELETE FROM download_source_candidates WHERE book_id = ${bookId} AND failure = ''`,
    tx`INSERT INTO download_source_candidates (book_id, source_url, host, position)
       SELECT ${bookId}, url, host, position - 1
       FROM unnest(${urls}::text[], ${hosts}::text[]) WITH ORDINALITY AS t(url, host, position)
       ON CONFLICT (book_id, source_url) DO NOTHING`,
  ]);
}

/** 与 replace 同序先锁 book 行；候选被并发替换删除后仍补写失败记忆。 */
export async function markCandidateFailure(
  sql: CandidateSql,
  bookId: number,
  sourceUrl: string,
  kind: Exclude<CandidateFailureKind, ''>,
  reason: string,
): Promise<void> {
  await sql.transaction(tx => [
    tx`SELECT id FROM labeled_books WHERE id = ${bookId} FOR UPDATE`,
    tx`INSERT INTO download_source_candidates
         (book_id, source_url, host, position, failure, failure_reason, updated_at)
       VALUES (${bookId}, ${sourceUrl}, ${candidateHostOf(sourceUrl)}, 0, ${kind}, ${reason.slice(0, 64)}, now())
       ON CONFLICT (book_id, source_url) DO UPDATE
         SET failure = EXCLUDED.failure, failure_reason = EXCLUDED.failure_reason, updated_at = now()`,
  ]);
}

/** host 原子占位：被他人持有且未过期 ⇒ false；过期原子接管。expiresMs 必须 > 0。 */
export async function tryOccupyHost(
  sql: CandidateSql,
  host: string,
  holder: string,
  kind: 'download' | 'prefetch',
  taskId: number | null,
  expiresMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= 0) throw new Error('expiresMs is invalid');
  const rows = await sql`
    INSERT INTO download_host_occupancy (host, holder, kind, task_id, expires_at)
    VALUES (${host}, ${holder}, ${kind}, ${taskId}, now() + (${expiresMs}::bigint * interval '1 millisecond'))
    ON CONFLICT (host) DO UPDATE
      SET holder = ${holder}, kind = ${kind}, task_id = ${taskId},
          claimed_at = now(), expires_at = now() + (${expiresMs}::bigint * interval '1 millisecond')
      WHERE download_host_occupancy.expires_at <= now()
    RETURNING host` as unknown as { host: string }[];
  return rows.length === 1;
}

/** 释放本 holder 的占位（下载收口/预取完成时）；不是自己的占位不碰。 */
export async function releaseHostOccupancy(sql: CandidateSql, host: string, holder: string): Promise<void> {
  await sql`
    DELETE FROM download_host_occupancy WHERE host = ${host} AND holder = ${holder}`;
}

/** 某时刻仍被（未过期占位）占用的 host 集合——选源排除用；给 now 参数便于测试。 */
export async function occupiedHosts(
  sql: CandidateSql,
  atIso: string | null = null,
): Promise<Set<string>> {
  const at = atIso ? new Date(atIso) : new Date();
  const rows = await sql`
    SELECT host FROM download_host_occupancy WHERE expires_at > ${at.toISOString()}` as unknown as { host: string }[];
  return new Set(rows.map(row => row.host));
}

/** 预取按书原子认领：未认领或已过期 ⇒ true；被他人持有 ⇒ false。与 tryOccupyHost 同型。 */
export async function claimSourcePrefetch(
  sql: CandidateSql,
  bookId: number,
  owner: string,
  expiresMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= 0) throw new Error('expiresMs is invalid');
  const rows = await sql`
    INSERT INTO download_source_prefetch (book_id, owner, expires_at)
    VALUES (${bookId}, ${owner}, now() + (${expiresMs}::bigint * interval '1 millisecond'))
    ON CONFLICT (book_id) DO UPDATE
      SET owner = ${owner}, claimed_at = now(), expires_at = now() + (${expiresMs}::bigint * interval '1 millisecond')
      WHERE download_source_prefetch.expires_at <= now()
    RETURNING book_id` as unknown as { book_id: number }[];
  return rows.length === 1;
}

/** 释放本 owner 的预取认领。不是自己的认领不碰。 */
export async function releaseSourcePrefetch(sql: CandidateSql, bookId: number, owner: string): Promise<void> {
  await sql`
    DELETE FROM download_source_prefetch WHERE book_id = ${bookId} AND owner = ${owner}`;
}

/** 下载失败 → 候选失败分类（permanent/temporary）。判据与 AdapterOutcome.failure.code 对齐。 */
export function classifyFailure(code: string): Exclude<CandidateFailureKind, ''> {
  // identity_mismatch_or_no_candidate：该源详情页/正文身份不符——确定不是这本书，重试无意义。
  return code === 'identity_mismatch_or_no_candidate' ? 'permanent' : 'temporary';
}
