import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';

// 书库：读取批量打标入库的书（labeled_books）
export const maxDuration = 60;

const PAGE_SIZE = 30;

interface LabeledBook {
  id: number;
  title: string;
  author: string;
  category: string;
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

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const query = (searchParams.get('q') || '').trim().slice(0, 100);
  try {
    await ensureSchema();
    const s = getSql();
    const like = query ? `%${query.toLowerCase()}%` : null;
    const where = like
      ? s`WHERE lower(title) LIKE ${like} OR lower(author) LIKE ${like}
          OR lower(labels::text) LIKE ${like}`
      : s``;
    const rows = (await s`
      SELECT id, title, author, category, finish_status, chars_labeled, labels,
             labeled_at::text AS labeled_at
      FROM labeled_books ${where}
      ORDER BY labeled_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`) as unknown as LabeledBook[];
    const countRows = (await s`
      SELECT count(*)::int AS total FROM labeled_books ${where}`) as { total: number }[];
    return NextResponse.json({
      books: rows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        category: r.category,
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
    });
  } catch {
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
