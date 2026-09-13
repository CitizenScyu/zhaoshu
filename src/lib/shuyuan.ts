import { getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';

// 书源合集（yckceo.com）拉取、合并去重、失效治理。
// 列表页是静态 HTML，合集 JSON 端点按 id 取；yckceo 在国内直连被 SNI 重置，
// 但 Vercel 出口在美国，直连没问题（2026-09-13 经凤凰城 VPS 验证）。

const INDEX_URL = 'https://www.yckceo.com/yuedu/shuyuans/index.html';
const jsonUrl = (id: number) => `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
const LATEST_COUNT = 3; // 只跟最新 3 个合集
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_CONCURRENCY = 10;
const INSERT_CHUNK = 100;

export type ShuyuanCollection = { id: number; title: string; count: number };

export type ShuyuanStats = {
  total: number;
  active: number;
  disabled: number;
  collections: ShuyuanCollection[];
  refreshedAt: string | null;
};

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu/1.0)' },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseIndex(html: string): { id: number; title: string }[] {
  const entries: { id: number; title: string }[] = [];
  const re = /href="\/yuedu\/shuyuans\/content\/id\/(\d+)\.html"[^>]*>([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    entries.push({ id: Number(m[1]), title: m[2].trim() });
  }
  return entries;
}

export async function getShuyuanStats(): Promise<ShuyuanStats> {
  const s = getSql();
  const metaRows = (await s`
    SELECT collections, refreshed_at::text AS refreshed_at FROM shuyuan_meta WHERE id = 1`) as {
    collections: ShuyuanCollection[] | null;
    refreshed_at: string | null;
  }[];
  const countRows = (await s`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE disabled_at IS NULL)::int AS active
    FROM shuyuan_sources`) as { total: number; active: number }[];
  const total = countRows[0]?.total ?? 0;
  const active = countRows[0]?.active ?? 0;
  return {
    total,
    active,
    disabled: total - active,
    collections: metaRows[0]?.collections ?? [],
    refreshedAt: metaRows[0]?.refreshed_at ?? null,
  };
}

// V2 搜索失败时打失效标记：被标记的源不再进入搜索轮换
export async function disableShuyuanSource(url: string, reason: string): Promise<boolean> {
  const s = getSql();
  const rows = (await s`
    UPDATE shuyuan_sources
    SET disabled_at = now(), last_error = ${reason.slice(0, 200)}
    WHERE source_url = ${normalizeUrl(url)}
    RETURNING id`) as { id: number }[];
  return rows.length > 0;
}

// 拉最新合集 → 合并去重 → 全量替换表内容（保留失效标记，并复探失效源看是否复活）。
// 上游合集里删掉的源会随全量替换一起消失。
export async function refreshShuyuan(): Promise<ShuyuanStats> {
  const s = getSql();
  const html = await fetchText(INDEX_URL, 30_000);
  const entries = parseIndex(html);
  if (entries.length === 0) {
    throw new Error('书源列表页解析到 0 个合集，页面结构可能变了');
  }

  const merged = new Map<string, Record<string, unknown>>();
  const collections: ShuyuanCollection[] = [];
  for (const entry of entries.slice(0, LATEST_COUNT)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fetchText(jsonUrl(entry.id), 60_000));
    } catch {
      continue; // 单个合集挂了不致命，其余继续
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.bookSourceUrl !== 'string') continue;
      const url = normalizeUrl(item.bookSourceUrl);
      if (!url || merged.has(url)) continue;
      merged.set(url, item);
    }
    collections.push({ id: entry.id, title: entry.title, count: parsed.length });
  }
  if (merged.size === 0) {
    throw new Error('所有书源合集下载失败');
  }

  // 保留既有失效标记，但只对内容未变的源：合集作者改过规则的源视为已修复，摘掉标记复活
  const disabledRows = (await s`
    SELECT source_url, last_error, source FROM shuyuan_sources WHERE disabled_at IS NOT NULL`) as {
    source_url: string;
    last_error: string;
    source: Record<string, unknown>;
  }[];
  const disabled = new Map(disabledRows.map((r) => [r.source_url, r]));
  const stillDead = new Set<string>();
  for (const [url, row] of disabled) {
    const fresh = merged.get(url);
    if (fresh && JSON.stringify(fresh) === JSON.stringify(row.source)) {
      stillDead.add(url); // 内容没变，继续失效
    }
  }
  await reviveProbes([...stillDead], stillDead);

  await s`DELETE FROM shuyuan_sources`;
  const rows = [...merged.entries()].map(([url, item]) => {
    const dead = stillDead.has(url);
    return {
      url,
      name: typeof item.bookSourceName === 'string' ? item.bookSourceName : '',
      grp: typeof item.bookSourceGroup === 'string' ? item.bookSourceGroup : '',
      source: item,
      dead,
      err: dead ? (disabled.get(url)?.last_error ?? '') : '',
    };
  });
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    await s`
      INSERT INTO shuyuan_sources (source_url, name, group_name, source, disabled_at, last_error)
      SELECT url, name, grp, source, CASE WHEN dead THEN now() END, err
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
      AS t(url text, name text, grp text, source jsonb, dead boolean, err text)`;
  }
  await s`
    UPDATE shuyuan_meta
    SET collections = ${JSON.stringify(collections)}::jsonb, refreshed_at = now()
    WHERE id = 1`;
  return getShuyuanStats();
}

// 并发探活：只探主站可达性（弱信号，但足够做复活判断）；探活的从失效集合里移除
async function reviveProbes(urls: string[], dead: Set<string>) {
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next];
      next += 1;
      try {
        await fetchText(url, PROBE_TIMEOUT_MS);
        dead.delete(url);
      } catch {
        // 仍然死了，保留标记
      }
    }
  }
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
}
