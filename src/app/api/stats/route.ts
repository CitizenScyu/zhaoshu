import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';

// 项目统计：聚合各表数据做「账本/战果」展示。全部用 SQL 聚合，不拉全表。
// 每组独立容错：单表空/查询失败返回 0，不让整个接口 500。
export const maxDuration = 60;

// 书架路由添加书时写入的伪 query，不算真正的找书行为（见 api/shelf/route.ts）
const SHELF_PSEUDO_QUERY = '书库添加';

export interface StatsResponse {
  library: {
    total: number;
    withQuality: number;
    avgQuality: number | null;
    charsLabeled: number;
    genres: { name: string; count: number }[];
  };
  download: {
    total: number;
    done: number;
    chapters: number;
    chars: number;
  };
  find: {
    queries: number;
    recommendations: number;
  };
  shelf: {
    statuses: { name: string; count: number }[];
  };
  shuyuan: {
    total: number;
    active: number;
  };
  tokens: null;
}

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;

  await ensureSchema();
  const s = getSql();

  const stats: StatsResponse = {
    library: { total: 0, withQuality: 0, avgQuality: null, charsLabeled: 0, genres: [] },
    download: { total: 0, done: 0, chapters: 0, chars: 0 },
    find: { queries: 0, recommendations: 0 },
    shelf: { statuses: [] },
    shuyuan: { total: 0, active: 0 },
    tokens: null, // 占位：LLM token 用量第二期埋点后接入
  };

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
    if (rows[0]) {
      stats.library.total = rows[0].total;
      stats.library.withQuality = rows[0].with_quality;
      stats.library.avgQuality = rows[0].avg_quality;
      stats.library.charsLabeled = rows[0].chars_labeled;
    }
    const genreRows = (await s`
      SELECT COALESCE(NULLIF(primary_genre, ''), category, '其他') AS genre,
             count(*)::int AS n
      FROM labeled_books
      GROUP BY 1 ORDER BY n DESC LIMIT 12`) as { genre: string; n: number }[];
    stats.library.genres = genreRows.map((r) => ({ name: r.genre, count: r.n }));
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
    if (rows[0]) {
      stats.download.total = rows[0].total;
      stats.download.done = rows[0].done;
      stats.download.chapters = rows[0].chapters;
      stats.download.chars = rows[0].chars;
    }
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
    if (rows[0]) {
      stats.find.queries = rows[0].queries;
      stats.find.recommendations = rows[0].recommendations;
    }
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
    stats.shelf.statuses = rows;
  } catch (e) {
    console.error('stats shelf aggregate failed:', e);
  }

  try {
    const rows = (await s`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE disabled_at IS NULL)::int AS active
      FROM shuyuan_sources`) as { total: number; active: number }[];
    if (rows[0]) {
      stats.shuyuan.total = rows[0].total;
      stats.shuyuan.active = rows[0].active;
    }
  } catch (e) {
    console.error('stats shuyuan aggregate failed:', e);
  }

  return NextResponse.json(stats);
}
