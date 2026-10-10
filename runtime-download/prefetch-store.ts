import { randomUUID } from 'node:crypto';
import type { neon } from '@neondatabase/serverless';
import type { PrefetchStore, PrefetchTask } from './prefetch';

export type PrefetchSql = ReturnType<typeof neon>;

const DEFAULT_BUDGET_MS = 300_000;

type PrefetchRow = {
  id: number;
  book_id: number;
  title: string;
  author: string;
  source_urls: string[];
};

type OwnerRow = { book_id: number };

function requireDelay(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function sourceParts(sourceUrls: string[]): { urls: string[]; hosts: string[] } {
  const urls: string[] = [];
  const hosts: string[] = [];
  const seenHosts = new Set<string>();
  for (const sourceUrl of sourceUrls) {
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { continue; }
    if (parsed.protocol !== 'https:' || !parsed.hostname || seenHosts.has(parsed.hostname)) continue;
    seenHosts.add(parsed.hostname);
    urls.push(sourceUrl);
    hosts.push(parsed.hostname);
    if (urls.length === 2) break;
  }
  return { urls, hosts };
}

export function createPrefetchStore(
  sql: PrefetchSql,
  options: { leaseMs: number; budgetMs?: number },
): PrefetchStore {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  requireDelay(budgetMs, 'budgetMs', true);
  requireDelay(options.leaseMs, 'leaseMs');
  if (options.leaseMs <= Math.max(budgetMs, DEFAULT_BUDGET_MS)) throw new Error('leaseMs must exceed budgetMs');
  const leaseMs = options.leaseMs;
  const tokens = new WeakMap<PrefetchTask, string>();
  const snapshots = new WeakMap<PrefetchTask, string[]>();

  return {
    async busyHosts(signal) {
      signal.throwIfAborted();
      // running 行只声明 source_url 的 host，不覆盖重定向后的物理 host。
      const rows = await sql.transaction((tx) => [tx`
        SELECT host, '' AS source_url FROM download_host_occupancy
        WHERE expires_at > now() AND host <> ''
        UNION
        SELECT '' AS host, source_url
        FROM download_tasks
        WHERE status = 'running' AND lease_owner <> '' AND source_url <> ''
      `], { readOnly: true, fetchOptions: { signal } }) as unknown as { host: string; source_url: string }[][];
      signal.throwIfAborted();
      const hosts = (rows[0] ?? []).map(row => {
        if (row.host) return row.host;
        try { return new URL(row.source_url).hostname; } catch { return ''; }
      });
      return [...new Set(hosts.filter(Boolean))];
    },

    async claimNext(signal) {
      signal.throwIfAborted();
      const owner = randomUUID();
      const rows = await sql.transaction((tx) => [tx`
        WITH ranked AS MATERIALIZED (
          SELECT t.id, t.book_id, t.title, t.author, t.created_at,
            row_number() OVER (PARTITION BY t.book_id ORDER BY t.created_at, t.id) AS book_rank
          FROM download_tasks t
          WHERE t.status = 'pending' AND t.book_id IS NOT NULL
            AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
            AND NOT EXISTS (
              SELECT 1 FROM download_tasks running
              WHERE running.book_id = t.book_id AND running.status = 'running' AND running.lease_owner <> ''
            )
            AND (
              SELECT count(DISTINCT lower(c.host)) FROM download_source_candidates c
              WHERE c.book_id = t.book_id AND c.failure = '' AND c.host <> ''
                AND c.source_url ~* '^https://'
            ) < 2
            AND NOT EXISTS (
              SELECT 1 FROM download_source_prefetch p
              WHERE p.book_id = t.book_id AND p.expires_at > now()
            )
        ), chosen AS MATERIALIZED (
          SELECT id, book_id, title, author
          FROM ranked
          WHERE book_rank = 1
          ORDER BY created_at, id
          LIMIT 1
        ), claimed AS (
          INSERT INTO download_source_prefetch (book_id, owner, claimed_at, expires_at)
          SELECT book_id, ${owner}, now(), now() + (${leaseMs}::bigint * interval '1 millisecond')
          FROM chosen
          ON CONFLICT (book_id) DO UPDATE
            SET owner = ${owner}, claimed_at = now(),
                expires_at = now() + (${leaseMs}::bigint * interval '1 millisecond')
            WHERE download_source_prefetch.expires_at <= now()
          RETURNING book_id
        )
        SELECT c.id, c.book_id, c.title, c.author,
          ARRAY(SELECT s.source_url FROM download_source_candidates s
                WHERE s.book_id = c.book_id AND s.failure = '' ORDER BY s.source_url) AS source_urls
        FROM chosen c JOIN claimed p ON p.book_id = c.book_id
      `], { fetchOptions: { signal } }) as unknown as PrefetchRow[][];
      const row = rows[0]?.[0];
      if (!row) return null;
      const task: PrefetchTask = {
        id: Number(row.id),
        bookId: Number(row.book_id),
        title: row.title,
        author: row.author,
        sourceUrls: row.source_urls,
      };
      tokens.set(task, owner);
      snapshots.set(task, [...(row.source_urls ?? [])]);
      // 返回已领对象供调度器在响应后中止时归还，不能在此抛错丢掉 owner。
      return task;
    },

    async finish(task, plan) {
      const owner = tokens.get(task);
      if (!owner) return false;
      const snapshot = snapshots.get(task) ?? [];
      const { urls, hosts } = sourceParts([...snapshot, ...plan.sourceUrls]);
      if (!plan.sourceUrls.length || !urls.length) return false;

      const results = await sql.transaction((tx) => [
        tx`SELECT id FROM labeled_books WHERE id = ${task.bookId} FOR UPDATE`,
        tx`
          DELETE FROM download_source_prefetch p
          WHERE p.book_id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
            AND ARRAY(
              SELECT c.source_url FROM download_source_candidates c
              WHERE c.book_id = ${task.bookId} AND c.failure = '' ORDER BY c.source_url
            ) <> ${snapshot}::text[]
        `,
        tx`
          SELECT lb.id, p.owner
          FROM labeled_books lb
          JOIN download_source_prefetch p ON p.book_id = lb.id
          WHERE lb.id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
          FOR UPDATE OF p
        `,
        tx`
          INSERT INTO download_source_candidates
            (book_id, source_url, host, position, failure, failure_reason, updated_at)
          SELECT ${task.bookId}, source_url, host,
            position + COALESCE((SELECT max(c.position) FROM download_source_candidates c
              WHERE c.book_id = ${task.bookId} AND c.failure = ''), -1), '', '', now()
          FROM unnest(${urls}::text[], ${hosts}::text[]) WITH ORDINALITY AS v(source_url, host, position)
          WHERE NOT (source_url = ANY(${snapshot}::text[])) AND EXISTS (
            SELECT 1 FROM download_source_prefetch p
            WHERE p.book_id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
          )
          ON CONFLICT (book_id, source_url) DO UPDATE
            SET host = EXCLUDED.host, position = EXCLUDED.position, updated_at = now()
            WHERE download_source_candidates.failure = ''
              AND EXISTS (
                SELECT 1 FROM download_source_prefetch p
                WHERE p.book_id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
              )
        `,
        tx`
          SELECT 1 / CASE WHEN EXISTS (
            SELECT 1 FROM download_source_prefetch p
            WHERE p.book_id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
          ) AND NOT EXISTS (
            SELECT 1 FROM download_source_candidates c
            WHERE c.book_id = ${task.bookId} AND c.failure = ''
          ) THEN 0 ELSE 1 END AS candidate_proof
        `,
        tx`
          WITH cooled AS (
            UPDATE download_source_prefetch p
            SET owner = '', expires_at = now() + interval '60 seconds'
            WHERE p.book_id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
              AND (SELECT count(DISTINCT lower(c.host)) FROM download_source_candidates c
                   WHERE c.book_id = p.book_id AND c.failure = '' AND c.host <> ''
                     AND c.source_url ~* '^https://') < 2
            RETURNING book_id
          ), released AS (
            DELETE FROM download_source_prefetch p
            WHERE p.book_id = ${task.bookId} AND p.owner = ${owner} AND p.expires_at > now()
              AND (SELECT count(DISTINCT lower(c.host)) FROM download_source_candidates c
                   WHERE c.book_id = p.book_id AND c.failure = '' AND c.host <> ''
                     AND c.source_url ~* '^https://') >= 2
            RETURNING book_id
          )
          SELECT book_id FROM cooled UNION ALL SELECT book_id FROM released
        `,
      ]) as unknown as unknown[][];
      tokens.delete(task);
      snapshots.delete(task);
      return (results[5] as OwnerRow[]).length === 1;
    },

    async release(task, input) {
      const owner = tokens.get(task);
      if (!owner) return false;
      let rows: OwnerRow[];
      if (input.retryDelayMs !== undefined) {
        requireDelay(input.retryDelayMs, 'retryDelayMs', true);
        rows = await sql`
          UPDATE download_source_prefetch
          SET owner = '', expires_at = now() + (${input.retryDelayMs}::bigint * interval '1 millisecond')
          WHERE book_id = ${task.bookId} AND owner = ${owner} AND expires_at > now()
          RETURNING book_id` as unknown as OwnerRow[];
      } else {
        rows = await sql`
          DELETE FROM download_source_prefetch
          WHERE book_id = ${task.bookId} AND owner = ${owner} AND expires_at > now()
          RETURNING book_id` as unknown as OwnerRow[];
      }
      if (rows.length === 1) {
        tokens.delete(task);
        snapshots.delete(task);
        return true;
      }
      const active = await sql`
        SELECT book_id FROM download_source_prefetch
        WHERE book_id = ${task.bookId} AND owner = ${owner} AND expires_at > now()
      ` as unknown as OwnerRow[];
      if (active.length === 0) {
        tokens.delete(task);
        snapshots.delete(task);
      }
      return false;
    },
  };
}
