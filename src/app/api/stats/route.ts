import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';

// 项目统计：聚合各表数据做「账本/战果」展示。全部用 SQL 聚合，不拉全表。
// 每组独立容错：真实空数据为 0，查询失败的整个分区为 null。
export const maxDuration = 60;

// 书架路由添加书时写入的伪 query，不算真正的找书行为（见 api/shelf/route.ts）
const SHELF_PSEUDO_QUERY = '书库添加';
type StatsSection = 'library' | 'download' | 'find' | 'shelf' | 'shuyuan';

export interface StatsResponse {
  library: {
    total: number;
    withQuality: number;
    avgQuality: number | null;
    charsLabeled: number;
    genres: { name: string; count: number }[];
  } | null;
  download: {
    total: number;
    done: number;
    chapters: number;
    chars: number;
  } | null;
  find: {
    queries: number;
    recommendations: number;
  } | null;
  shelf: {
    statuses: { name: string; count: number }[];
  } | null;
  shuyuan: {
    total: number;
    active: number;
  } | null;
  tokens: null;
  availability: Record<StatsSection, boolean>;
  error?: string;
  code?: 'STATS_PARTIAL' | 'STATS_UNAVAILABLE';
}

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;

  const stats: StatsResponse = {
    library: null,
    download: null,
    find: null,
    shelf: null,
    shuyuan: null,
    availability: { library: false, download: false, find: false, shelf: false, shuyuan: false },
    tokens: null, // 占位：LLM token 用量第二期埋点后接入
  };

  let s: ReturnType<typeof getSql>;
  try {
    await ensureSchema();
    s = getSql();
  } catch (error) {
    console.error('stats initialization failed:', error);
    return NextResponse.json({ ...stats, error: '统计暂不可用，请稍后重试', code: 'STATS_UNAVAILABLE' }, { status: 503 });
  }

  try {
    const rows = (await s`
      SELECT count(*)::int AS total,
             count(quality)::int AS with_quality,
             round(avg(quality)::numeric, 1)::float8 AS avg_quality,
             COALESCE(sum(chars_labeled), 0)::float8 AS chars_labeled
      FROM labeled_books`) as {
      total: number;
      with_quality: number;
      avg_quality: number | null;
      chars_labeled: number;
    }[];
    if (!rows[0]) throw new Error('Missing library aggregate');
    const genreRows = (await s`
      SELECT COALESCE(NULLIF(primary_genre, ''), category, '其他') AS genre,
             count(*)::int AS n
      FROM labeled_books
      GROUP BY 1 ORDER BY n DESC LIMIT 12`) as { genre: string; n: number }[];
    stats.library = {
      total: rows[0].total,
      withQuality: rows[0].with_quality,
      avgQuality: rows[0].avg_quality,
      charsLabeled: rows[0].chars_labeled,
      genres: genreRows.map((r) => ({ name: r.genre, count: r.n })),
    };
    stats.availability.library = true;
  } catch (e) {
    console.error('stats library aggregate failed:', e);
  }

  try {
    const rows = (await s`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'done')::int AS done,
             COALESCE(sum(chapters_total) FILTER (WHERE status = 'done'), 0)::float8 AS chapters,
             COALESCE(sum(chars_total) FILTER (WHERE status = 'done'), 0)::float8 AS chars
      FROM download_tasks`) as {
      total: number;
      done: number;
      chapters: number;
      chars: number;
    }[];
    if (!rows[0]) throw new Error('Missing download aggregate');
    stats.download = rows[0];
    stats.availability.download = true;
  } catch (e) {
    console.error('stats download aggregate failed:', e);
  }

  try {
    // 找书次数按去重口味描述计；书架添加产生的伪 query 不算
    const rows = (await s`
      SELECT count(DISTINCT query)::int AS queries, count(*)::int AS recommendations
      FROM recommendations WHERE query <> ${SHELF_PSEUDO_QUERY}`) as {
      queries: number;
      recommendations: number;
    }[];
    if (!rows[0]) throw new Error('Missing find aggregate');
    stats.find = rows[0];
    stats.availability.find = true;
  } catch (e) {
    console.error('stats find aggregate failed:', e);
  }

  try {
    const rows = (await s`
      SELECT status AS name, count(*)::int AS count
      FROM recommendations GROUP BY status ORDER BY count DESC`) as {
      name: string;
      count: number;
    }[];
    stats.shelf = { statuses: rows };
    stats.availability.shelf = true;
  } catch (e) {
    console.error('stats shelf aggregate failed:', e);
  }

  try {
    const rows = (await s`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE disabled_at IS NULL)::int AS active
      FROM shuyuan_sources`) as { total: number; active: number }[];
    if (!rows[0]) throw new Error('Missing shuyuan aggregate');
    stats.shuyuan = rows[0];
    stats.availability.shuyuan = true;
  } catch (e) {
    console.error('stats shuyuan aggregate failed:', e);
  }

  const available = Object.values(stats.availability);
  if (available.some((value) => !value)) {
    stats.error = '部分统计暂不可用，请稍后重试';
    stats.code = 'STATS_PARTIAL';
  }
  if (available.every((value) => !value)) {
    stats.error = '统计暂不可用，请稍后重试';
    stats.code = 'STATS_UNAVAILABLE';
    return NextResponse.json(stats, { status: 503 });
  }
  return NextResponse.json(stats);
}
