import { getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';
import { createDeadline, raceDeadline, type RequestDeadline } from '@/lib/deadline';
import { validateSourceUrl } from '@/lib/source-policy';

// 书源合集（yckceo.com）拉取、合并去重、失效治理。
// 列表页是静态 HTML，合集 JSON 端点按 id 取；yckceo 在国内直连被 SNI 重置，
// 但 Vercel 出口在美国，直连没问题（2026-09-13 经凤凰城 VPS 验证）。

const INDEX_URL = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const jsonUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
const LATEST_COUNT = 3; // 只跟最新 3 个合集
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_CONCURRENCY = 10;
const INSERT_CHUNK = 100;
const SOURCE_STATUS_LIMIT = 100;
const WRITE_RESERVE_MS = 5_000;
// 响应体读取（json/text）超时：超出即中止该响应，不认为已恢复
export const RESPONSE_TIMEOUT_MS = 12_000;
// 刷新总预算：index + 合集 JSON + 失效源探活 共用这一整份预算；
// 剩余时间不足时不再新增探活（未探测的源不能当作已恢复）。
export const REFRESH_BUDGET_MS = 90_000;

export type ShuyuanCollection = { id: number; title: string; count: number };

export type ShuyuanAvailability = 'unprobed' | 'pending' | 'reachable' | 'failed';
export type ShuyuanCounts = {
  total: number;
  active: number; // 兼容字段：启用且最近探测可达，不能用未禁用数量填充。
  enabled: number;
  disabled: number;
  unprobed: number;
  pending: number;
  reachable: number;
  failed: number;
};
export type ShuyuanSourceStatus = {
  url: string; name: string; disabled: boolean; availability: ShuyuanAvailability;
  lastError: string; checkedAt: string | null; probeError: string | null;
};
export type ShuyuanStats = ShuyuanCounts & {
  collections: ShuyuanCollection[];
  refreshedAt: string | null;
  sources: ShuyuanSourceStatus[];
  sourcesLimit: number;
};

type Sql = ReturnType<typeof getSql>;
type ProbeState = { url: string; status: ShuyuanAvailability; checked_at: string | null; error: string | null };
type MetaRow = { collections: unknown; refreshed_at: string | null };
type StoredSource = {
  source_url: string; source: Record<string, unknown>; last_error: string; disabled_at: string | null;
};

export interface ReadingSource {
  url: string;
  name: string;
  searchUrl: unknown;
  rules: Record<string, unknown>;
}

/** On-demand searches may check unprobed/pending sources, without calling them reachable. */
export async function getReadingSources(signal: AbortSignal): Promise<ReadingSource[]> {
  const s = getSql();
  const { states } = readMeta((await storedMeta(s, signal)).collections);
  const rows = await readRows<StoredSource & { name: string }>(s, s`
    SELECT source_url, name, source, disabled_at::text AS disabled_at, last_error
    FROM shuyuan_sources WHERE source_url ILIKE 'https://book15.net%' ORDER BY source_url`, signal);
  const supported = rows.filter((row) => canProbe(row.source_url));
  const defaultSearch = 'https://book15.net/books/search.html?kw={{key}}';
  // The same built-in adapter as the download worker, only when the collection
  // has no record for this host. A disabled/failed record must never be bypassed.
  if (!supported.length) return [{ url: 'https://book15.net/', name: 'book15.net', searchUrl: defaultSearch, rules: {} }];
  return supported.filter((row) => !row.disabled_at && isRecord(row.source) && row.source.enabled !== false && states.get(row.source_url)?.status !== 'failed')
    .sort((a, b) => Number(states.get(b.source_url)?.status === 'reachable') - Number(states.get(a.source_url)?.status === 'reachable'))
    .slice(0, 4)
    .map((row) => ({
      url: validateSourceUrl(row.source_url).href, name: row.name.slice(0, 200) || 'book15.net',
      searchUrl: row.source.searchUrl ?? defaultSearch, rules: row.source,
    }));
}

function canProbe(url: string): boolean {
  try { validateSourceUrl(url); return true; } catch { return false; }
}

// collections 仍是数组，首项附带仅由服务端产生的版本化探测快照；旧数据默认未探测。
// 不需要 DDL，也不信任上游规则 JSON 中自报的健康状态。
function readMeta(value: unknown): { collections: ShuyuanCollection[]; states: Map<string, ProbeState> } {
  const list = Array.isArray(value) ? value : [];
  const collections = list.filter((item) => isRecord(item) &&
    typeof item.id === 'number' && typeof item.title === 'string' && typeof item.count === 'number')
    .map((item) => ({ id: item.id as number, title: item.title as string, count: item.count as number }));
  const snapshot: unknown = isRecord(list[0]) ? list[0].probeSnapshot : undefined;
  const states = new Map<string, ProbeState>();
  const seen = new Set<string>();
  if (isRecord(snapshot) && snapshot.version === 1 && Array.isArray(snapshot.entries)) {
    for (const entry of snapshot.entries) {
      if (!isRecord(entry) || typeof entry.url !== 'string') continue;
      if (seen.has(entry.url)) { states.delete(entry.url); continue; }
      seen.add(entry.url);
      if (!['pending', 'reachable', 'failed'].includes(String(entry.status))) continue;
      const status = entry.status as ProbeState['status'];
      const checkedAt = typeof entry.checked_at === 'string' && Number.isFinite(Date.parse(entry.checked_at))
        ? entry.checked_at : null;
      if (status !== 'pending' && (!canProbe(entry.url) || !checkedAt)) continue;
      states.set(entry.url, {
        url: entry.url, status, checked_at: status === 'pending' ? null : checkedAt,
        error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : null,
      });
    }
  }
  return { collections, states };
}

function sameRules(a: unknown, b: unknown): boolean {
  // jsonb 对象键顺序不是规则变化，数组顺序仍有意义。
  const stable = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  return stable(a) === stable(b);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// PG jsonb 严禁 NUL，孤立 UTF-16 代理项编码成 UTF-8 也非法；
// 上游合集里确实存在这类脏数据（2026-09-13 实测 bookSourceComment 混入 NUL）。
function cleanJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\u0000/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '�')
      .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
  }
  if (Array.isArray(value)) return value.map(cleanJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanJson(item)]));
  }
  return value;
}

async function fetchText(url: string, timeoutMs: number, parentSignal: AbortSignal): Promise<string> {
  const deadline = createDeadline(timeoutMs);
  const signal = AbortSignal.any([parentSignal, deadline.signal]);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    signal.throwIfAborted();
    const pending = fetch(url, {
      signal, redirect: 'error',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu/1.0)' },
    });
    void pending.then((late) => {
      if (signal.aborted && late.body && !late.body.locked) void late.body.cancel().catch(() => {});
    }, () => {});
    response = await raceDeadline(signal, () => pending);
    if (!response.ok || response.redirected) throw new Error(`${response.status} ${url}`);
    if (!response.body) return '';
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const result = await raceDeadline(signal, () => reader!.read());
      if (result.done) { complete = true; return text + decoder.decode(); }
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    if (reader) {
      if (!complete) void reader.cancel(signal.reason).catch(() => {});
      reader.releaseLock();
    } else if (response?.body && !response.body.locked) {
      void response.body.cancel(signal.reason).catch(() => {});
    }
    deadline.dispose();
  }
}

function parseIndex(html: string): { id: number; title: string }[] {
  const entries: { id: number; title: string }[] = [];
  const re = /href="\/yuedu\/shuyuans\/content\/id\/(\d+)\.html"[^>]*>([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    entries.push({ id: Number(m[1]), title: m[2].trim() });
  }
  return entries;
}

async function readRows<T>(s: Sql, query: ReturnType<Sql>, signal?: AbortSignal): Promise<T[]> {
  if (!signal) return await query as T[];
  signal.throwIfAborted();
  const [rows] = await raceDeadline(signal, () => s.transaction([query], { readOnly: true, fetchOptions: { signal } }));
  signal.throwIfAborted();
  return rows as T[];
}

async function storedMeta(s: Sql, signal?: AbortSignal): Promise<MetaRow> {
  const rows = await readRows<MetaRow>(s, s`
    SELECT collections, refreshed_at::text AS refreshed_at FROM shuyuan_meta WHERE id = 1`, signal);
  return rows[0] ?? { collections: [], refreshed_at: null };
}

async function countsFromStates(s: Sql, states: Map<string, ProbeState>, signal?: AbortSignal): Promise<ShuyuanCounts> {
  const rows = await readRows<ShuyuanCounts>(s, s`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE disabled_at IS NULL AND p.status = 'reachable')::int AS active,
           count(*) FILTER (WHERE disabled_at IS NULL)::int AS enabled,
           count(*) FILTER (WHERE disabled_at IS NOT NULL)::int AS disabled,
           count(*) FILTER (WHERE p.status IS NULL)::int AS unprobed,
           count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE p.status = 'reachable')::int AS reachable,
           count(*) FILTER (WHERE p.status = 'failed')::int AS failed
    FROM shuyuan_sources
    LEFT JOIN jsonb_to_recordset(${JSON.stringify([...states.values()])}::jsonb)
      AS p(url text, status text, checked_at text, error text) ON p.url = source_url`, signal);
  if (!rows[0]) throw new Error('Missing shuyuan aggregate');
  return rows[0];
}

export async function getShuyuanCounts(signal?: AbortSignal): Promise<ShuyuanCounts> {
  const s = getSql();
  const meta = readMeta((await storedMeta(s, signal)).collections);
  return countsFromStates(s, meta.states, signal);
}

export async function getShuyuanStats(signal?: AbortSignal): Promise<ShuyuanStats> {
  const s = getSql();
  const rawMeta = await storedMeta(s, signal);
  const { collections, states } = readMeta(rawMeta.collections);
  const counts = await countsFromStates(s, states, signal);
  const rows = await readRows<{
    url: string; name: string; disabled: boolean; availability: ShuyuanAvailability;
    last_error: string; checked_at: string | null; probe_error: string | null;
  }>(s, s`
    SELECT source_url AS url, name, disabled_at IS NOT NULL AS disabled,
           COALESCE(p.status, 'unprobed') AS availability,
           last_error, p.checked_at, p.error AS probe_error
    FROM shuyuan_sources
    LEFT JOIN jsonb_to_recordset(${JSON.stringify([...states.values()])}::jsonb)
      AS p(url text, status text, checked_at text, error text) ON p.url = source_url
    ORDER BY COALESCE(p.status = 'pending', false) DESC,
             (last_error <> '' OR disabled_at IS NOT NULL) DESC, source_url
    LIMIT ${SOURCE_STATUS_LIMIT}`, signal);
  return {
    ...counts, collections, refreshedAt: rawMeta.refreshed_at, sourcesLimit: SOURCE_STATUS_LIMIT,
    sources: rows.map((row) => ({
      url: row.url, name: row.name, disabled: row.disabled, availability: row.availability,
      lastError: row.last_error, checkedAt: row.checked_at, probeError: row.probe_error,
    })),
  };
}

// V2 搜索失败时打失效标记：被标记的源不再进入搜索轮换
export async function disableShuyuanSource(url: string, reason: string): Promise<boolean> {
  const s = getSql();
  const rows = (await s`
    UPDATE shuyuan_sources
    SET disabled_at = now(), last_error = COALESCE(NULLIF(${reason.slice(0, 200)}, ''), last_error)
    WHERE source_url = ${normalizeUrl(url)}
    RETURNING id`) as { id: number }[];
  return rows.length > 0;
}

// 固定合集拉取、规则核对、有限探测和写回共用原有 90s 预算。
export async function refreshShuyuan(parentSignal?: AbortSignal): Promise<ShuyuanStats> {
  const budget = createDeadline(REFRESH_BUDGET_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, budget.signal]) : budget.signal;
  try {
    return await refreshWithinBudget(getSql(), budget, signal);
  } finally {
    budget.dispose();
  }
}

async function refreshWithinBudget(s: Sql, budget: RequestDeadline, signal: AbortSignal): Promise<ShuyuanStats> {
  const assertActive = () => { signal.throwIfAborted(); budget.assert(); };
  assertActive();
  const html = await fetchText(INDEX_URL, RESPONSE_TIMEOUT_MS * 2, signal);
  const entries = parseIndex(html);
  if (entries.length === 0) throw new Error('书源列表页解析到 0 个合集，页面结构可能变了');

  const merged = new Map<string, Record<string, unknown>>();
  const collections: ShuyuanCollection[] = [];
  for (const entry of entries.slice(0, LATEST_COUNT)) {
    assertActive();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fetchText(jsonUrl(entry.id), RESPONSE_TIMEOUT_MS, signal));
    } catch {
      assertActive();
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.bookSourceUrl !== 'string') continue;
      const url = normalizeUrl(item.bookSourceUrl);
      if (!url || merged.has(url)) continue;
      const cleaned = cleanJson(item);
      if (isRecord(cleaned)) merged.set(url, cleaned);
    }
    collections.push({ id: entry.id, title: entry.title, count: parsed.length });
  }
  if (merged.size === 0) throw new Error('所有书源合集下载失败');
  const expected = Math.min(LATEST_COUNT, entries.length);
  if (collections.length < expected) {
    throw new Error(`仅拉到 ${collections.length}/${expected} 个书源合集，本次刷新中止，保留既有数据`);
  }

  const previousRows = await readRows<StoredSource>(s, s`
    SELECT source_url, last_error, source, disabled_at::text AS disabled_at FROM shuyuan_sources`, signal);
  const previous = new Map(previousRows.map((row) => [row.source_url, row]));
  const oldMeta = await storedMeta(s, signal);
  const oldStates = readMeta(oldMeta.collections).states;
  const states = new Map<string, ProbeState>();
  const probes: string[] = [];
  for (const [url, item] of merged) {
    const old = previous.get(url);
    if (old && !sameRules(old.source, item)) {
      states.set(url, { url, status: 'pending', checked_at: null, error: null });
      continue;
    }
    const state = oldStates.get(url);
    if (state) states.set(url, state);
    if (old?.last_error && state?.status !== 'pending' && canProbe(url)) probes.push(url);
  }

  let next = 0;
  async function probeWorker() {
    while (next < probes.length) {
      if (signal.aborted || budget.remainingMs <= PROBE_TIMEOUT_MS + WRITE_RESERVE_MS) return;
      const url = probes[next++];
      try {
        await fetchText(validateSourceUrl(url).href, PROBE_TIMEOUT_MS, signal);
        states.set(url, { url, status: 'reachable', checked_at: new Date().toISOString(), error: null });
      } catch (error) {
        if (signal.aborted) return;
        states.set(url, {
          url, status: 'failed', checked_at: new Date().toISOString(),
          error: (error instanceof Error ? error.message : '探测失败').slice(0, 200),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, probes.length) }, () => probeWorker()));
  assertActive();

  const rows = [...merged.entries()].map(([url, item]) => ({
    url, name: typeof item.bookSourceName === 'string' ? item.bookSourceName : '',
    grp: typeof item.bookSourceGroup === 'string' ? item.bookSourceGroup : '', source: item,
    disabled_at: previous.get(url)?.disabled_at ?? null,
    err: previous.get(url)?.last_error ?? '',
  }));
  const insertChunk = (chunk: typeof rows) => s`
    INSERT INTO shuyuan_sources (source_url, name, group_name, source, disabled_at, last_error)
    SELECT url, name, grp, source, disabled_at, err
    FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
    AS t(url text, name text, grp text, source jsonb, disabled_at timestamptz, err text)`;
  const savedCollections = collections.map((collection, i) => i === 0 ? {
    ...collection, probeSnapshot: { version: 1, entries: [...states.values()] },
  } : collection);
  const updateMeta = s`
    UPDATE shuyuan_meta
    SET collections = ${JSON.stringify(cleanJson(savedCollections))}::jsonb, refreshed_at = now()
    WHERE id = 1`;
  const chunks = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) chunks.push(insertChunk(rows.slice(i, i + INSERT_CHUNK)));

  // 锁、快照守卫、全量替换和元数据在同一非交互事务内，避免覆盖并发禁用。
  const oldFlags = previousRows.map((row) => ({
    url: row.source_url, disabled_at: row.disabled_at, last_error: row.last_error,
  }));
  try {
    await s.transaction([
      s`SET LOCAL lock_timeout = '5s'`,
      s`SET LOCAL statement_timeout = '10s'`,
      s`LOCK TABLE shuyuan_sources IN SHARE ROW EXCLUSIVE MODE`,
      s`SELECT 1 / CASE WHEN
        (SELECT refreshed_at FROM shuyuan_meta WHERE id = 1) IS DISTINCT FROM ${oldMeta.refreshed_at}::timestamptz
        OR EXISTS (
          SELECT 1 FROM shuyuan_sources current
          FULL JOIN jsonb_to_recordset(${JSON.stringify(oldFlags)}::jsonb)
            AS old(url text, disabled_at timestamptz, last_error text) ON old.url = current.source_url
          WHERE current.source_url IS NULL OR old.url IS NULL
             OR current.disabled_at IS DISTINCT FROM old.disabled_at
             OR current.last_error IS DISTINCT FROM old.last_error
        ) THEN 0 ELSE 1 END AS snapshot_matches`,
      s`DELETE FROM shuyuan_sources`, ...chunks, updateMeta,
    ], { fetchOptions: { signal } });
  } catch (error) {
    if (isRecord(error) && error.code === '22012') throw new Error('书源在刷新期间发生变化，本次保留原数据，请重新刷新');
    throw error;
  }
  return getShuyuanStats(signal);
}
