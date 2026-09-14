import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';

// 书库：读取批量打标入库的书（labeled_books），支持分类/流派/基调/完结筛选与排序
export const maxDuration = 60;

const PAGE_SIZE = 30;

interface LabeledBook {
  id: number;
  title: string;
  author: string;
  category: string;
  primary_genre: string | null;
  quality: number | null;
  finish_status: string;
  chars_labeled: number;
  labels: Record<string, unknown>;
  labeled_at: string;
}

// 标签字段的安全提取（labels 来自离线脚本，字段宽松）
export function labelText(labels: unknown, key: string, maxLength = 600): string {
  if (!isRecord(labels)) return '';
  const v = labels[key];
  if (typeof v === 'string') return v.slice(0, maxLength);
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').slice(0, 6).join('；').slice(0, maxLength);
  }
  return '';
}

const SORTS = new Set(['quality', 'recent', 'oldest', 'title']);

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const query = (searchParams.get('q') || '').trim().slice(0, 100);
  const category = (searchParams.get('category') || '').trim().slice(0, 30);
  const tag = (searchParams.get('tag') || '').trim().slice(0, 30);
  const finish = (searchParams.get('finish') || '').trim().slice(0, 10);
  const sort = SORTS.has(searchParams.get('sort') || '')
    ? (searchParams.get('sort') as string)
    : 'quality'; // 默认质量优先
  try {
    await ensureSchema();
    const s = getSql();
    // 动态条件拼装（neon 库的 tagged template 每个分支都要是完整 SQL 片段）
    const conds = [];
    if (query) {
      const like = `%${query.toLowerCase()}%`;
      conds.push(s`(lower(title) LIKE ${like} OR lower(author) LIKE ${like} OR lower(labels::text) LIKE ${like})`);
    }
    if (category) conds.push(s`(COALESCE(NULLIF(primary_genre, ''), category) = ${category})`);
    if (tag) {
      const tagLike = `%${tag.toLowerCase()}%`;
      // 括号必须包住整个 OR 组：AND 优先级更高，裸拼会让 tag 分支绕过其他筛选
      conds.push(s`(lower(labels->>'genre') LIKE ${tagLike} OR lower(labels->>'style') LIKE ${tagLike} OR lower(labels->>'tone') LIKE ${tagLike})`);
    }
    if (finish) conds.push(s`finish_status = ${finish}`);
    // 动态条件拼装（neon tagged template 不支持 sql.join，用 AND 手动归并）
    let where = s``;
    if (conds.length === 1) {
      where = s`WHERE ${conds[0]}`;
    } else if (conds.length > 1) {
      let merged = conds[0];
      for (let i = 1; i < conds.length; i++) {
        merged = s`${merged} AND ${conds[i]}`;
      }
      where = s`WHERE ${merged}`;
    }
    // 质量优先：分数降序，未评分的沉底（按打标时间近的在前）
    const orderBy =
      sort === 'oldest' ? s`labeled_at ASC`
      : sort === 'title' ? s`title ASC`
      : sort === 'recent' ? s`labeled_at DESC`
      : s`quality DESC NULLS LAST, labeled_at DESC`;

    const rows = (await s`
      SELECT id, title, author, category, primary_genre, quality, finish_status,
             chars_labeled, labels, labeled_at::text AS labeled_at
      FROM labeled_books ${where}
      ORDER BY ${orderBy}
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`) as unknown as LabeledBook[];
    const countRows = (await s`
      SELECT count(*)::int AS total FROM labeled_books ${where}`) as { total: number }[];

    // 聚合可选筛选值（规范化主分类、完结状态）——给前端筛选条用
    const catRows = (await s`
      SELECT COALESCE(NULLIF(primary_genre, ''), category, '其他') AS category,
             count(*)::int AS n
      FROM labeled_books
      GROUP BY 1 ORDER BY n DESC LIMIT 20`) as { category: string; n: number }[];
    const finishRows = (await s`
      SELECT finish_status, count(*)::int AS n FROM labeled_books
      WHERE finish_status <> '' GROUP BY finish_status ORDER BY n DESC LIMIT 10`) as { finish_status: string; n: number }[];

    return NextResponse.json({
      books: rows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        category: r.category,
        primaryGenre: r.primary_genre || r.category,
        quality: typeof r.quality === 'number' ? r.quality : null,
        finishStatus: r.finish_status,
        charsLabeled: r.chars_labeled,
        labels: isRecord(r.labels) ? r.labels : {},
        labeledAt: r.labeled_at,
        // 列表直出的简介级字段
        genre: labelText(r.labels, 'genre', 100),
        intro: labelText(r.labels, 'worldbuilding', 300) || labelText(r.labels, 'plot_stage', 300),
      })),
      total: countRows[0]?.total ?? 0,
      page,
      pageSize: PAGE_SIZE,
      facets: {
        categories: catRows.map((r) => ({ name: r.category, count: r.n })),
        finishStates: finishRows.map((r) => ({ name: r.finish_status, count: r.n })),
      },
    });
  } catch {
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
