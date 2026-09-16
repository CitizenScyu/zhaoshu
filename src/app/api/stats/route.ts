import { NextRequest, NextResponse } from 'next/server';
import { withFindAccess } from '@/lib/personal-request';
import { hasPermission } from '@/lib/permissions';
import { downloadStatsForUserQuery, findStatsForUserQuery, shelfStatsForUserQuery } from '@/lib/user-data';
import { ensureSchema, getLlmUsageStats, getSql } from '@/lib/db';
import type { TokenStats } from '@/lib/llm-usage';
import { getShuyuanCounts, type ShuyuanCounts } from '@/lib/shuyuan';

// 项目统计：聚合各表数据做「账本/战果」展示。全部用 SQL 聚合，不拉全表。
// 每组独立容错：真实空数据为 0，查询失败的整个分区为 null。
export const maxDuration = 60;

export type StatsSection = 'library' | 'download' | 'find' | 'shelf' | 'shuyuan' | 'tokens';

export interface StatsResponse {
  subject: { userId: number };
  allowedSections: StatsSection[];
  sectionStates: Record<StatsSection, 'ok' | 'forbidden' | 'not_ready' | 'unavailable'>;
  sectionScopes: Record<StatsSection, 'personal' | 'shared' | 'shared-owner'>;
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
  shuyuan: ShuyuanCounts | null;
  tokens: TokenStats | null;
  availability: Record<StatsSection, boolean>;
  error?: string;
  code?: 'STATS_PARTIAL' | 'STATS_UNAVAILABLE';
}

export async function GET(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
  const { userId } = access.principal;
  const allowedSections: StatsSection[] = ['library', 'find', 'shelf'];
  if (hasPermission(access.principal, 'download')) allowedSections.push('download', 'shuyuan');
  if (access.principal.role === 'owner') allowedSections.push('tokens');

  const stats: StatsResponse = {
    subject: { userId }, allowedSections,
    sectionScopes: { library: 'shared', download: 'personal', find: 'personal', shelf: 'personal', shuyuan: 'shared', tokens: 'shared-owner' },
    sectionStates: { library: 'unavailable', download: allowedSections.includes('download') ? 'unavailable' : 'forbidden', find: 'unavailable', shelf: 'unavailable', shuyuan: allowedSections.includes('shuyuan') ? 'unavailable' : 'forbidden', tokens: allowedSections.includes('tokens') ? 'unavailable' : 'forbidden' },
    library: null,
    download: null,
    find: null,
    shelf: null,
    shuyuan: null,
    availability: { library: false, download: false, find: false, shelf: false, shuyuan: false, tokens: false },
    tokens: null,
  };

  let s: ReturnType<typeof getSql>;
  try {
    await access.run(ensureSchema);
    s = getSql();
  } catch {
    console.error('stats initialization failed');
    return NextResponse.json({ ...stats, error: '统计暂不可用，请稍后重试', code: 'STATS_UNAVAILABLE' }, { status: 503 });
  }

  try {
    const rows = (await access.run(async () => s`
      SELECT count(*)::int AS total,
             count(quality)::int AS with_quality,
             round(avg(quality)::numeric, 1)::float8 AS avg_quality,
             COALESCE(sum(chars_labeled), 0)::float8 AS chars_labeled
      FROM labeled_books`)) as {
      total: number;
      with_quality: number;
      avg_quality: number | null;
      chars_labeled: number;
    }[];
    if (!rows[0]) throw new Error('Missing library aggregate');
    const genreRows = (await access.run(async () => s`
      SELECT COALESCE(NULLIF(primary_genre, ''), category, '其他') AS genre,
             count(*)::int AS n
      FROM labeled_books
      GROUP BY 1 ORDER BY n DESC LIMIT 12`)) as { genre: string; n: number }[];
    stats.library = {
      total: rows[0].total,
      withQuality: rows[0].with_quality,
      avgQuality: rows[0].avg_quality,
      charsLabeled: rows[0].chars_labeled,
      genres: genreRows.map((r) => ({ name: r.genre, count: r.n })),
    };
    stats.availability.library = true;
    stats.sectionStates.library = 'ok';
  } catch {
    console.error('stats library aggregate failed');
  }

  // 下载任务自 auth schema v5 起有 NOT NULL 的 user_id，按当前用户统计；历史行归到用户 1。
  if (allowedSections.includes('download')) try {
    const rows = await access.run(async () => downloadStatsForUserQuery(s, userId)) as {
      total: number;
      done: number;
      chapters: number;
      chars: number;
    }[];
    if (!rows[0]) throw new Error('Missing download aggregate');
    stats.download = rows[0];
    stats.availability.download = true;
    stats.sectionStates.download = 'ok';
  } catch {
    console.error('stats download aggregate failed');
  }

  try {
    // 找书次数按去重口味描述计；书架添加产生的伪 query 不算
    const rows = await access.run(async () => findStatsForUserQuery(s, userId)) as {
      queries: number;
      recommendations: number;
    }[];
    if (!rows[0]) throw new Error('Missing find aggregate');
    stats.find = rows[0];
    stats.availability.find = true;
    stats.sectionStates.find = 'ok';
  } catch {
    console.error('stats find aggregate failed');
  }

  try {
    const rows = await access.run(async () => shelfStatsForUserQuery(s, userId)) as {
      name: string;
      count: number;
    }[];
    stats.shelf = { statuses: rows };
    stats.availability.shelf = true;
    stats.sectionStates.shelf = 'ok';
  } catch {
    console.error('stats shelf aggregate failed');
  }

  if (allowedSections.includes('shuyuan')) try {
    stats.shuyuan = await getShuyuanCounts();
    stats.availability.shuyuan = true;
    stats.sectionStates.shuyuan = 'ok';
  } catch {
    console.error('stats shuyuan aggregate failed');
  }

  if (allowedSections.includes('tokens')) try {
    stats.tokens = await access.run(getLlmUsageStats);
    stats.availability.tokens = true;
    stats.sectionStates.tokens = 'ok';
  } catch {
    console.error('stats tokens aggregate failed');
  }

  const available = allowedSections.map((section) => stats.availability[section]);
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
  });
}
