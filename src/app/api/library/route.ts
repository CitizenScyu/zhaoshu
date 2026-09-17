import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { hasPermission } from '@/lib/permissions';
import { ensureSchema, getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';
import { boundedPositiveInteger } from '@/lib/http';

// 书库：读取批量打标入库的书（labeled_books），支持分类/流派/基调/完结筛选与排序
export const maxDuration = 60;

const PAGE_SIZE = 30;
const MAX_PAGE = 10_000;

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
  read_task_id: number | null;
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
  const auth = await requirePermission(req, 'find');
  if (!auth.ok) return withAuthHeaders(auth.response);
  // 书库是共享元数据：找书组即可看。完成 TXT 的定位只在有 read 权限时返回，
  // 与 recommendationsForUserQuery 的 read_task_id 门控同源。
  const canRead = hasPermission(auth.principal, 'read');
  const { searchParams } = new URL(req.url);
  const pageParam = searchParams.get('page');
  const page = pageParam === null ? 1 : boundedPositiveInteger(pageParam, MAX_PAGE);
  if (page === null) {
    return authJson({ error: `page must be an integer from 1 to ${MAX_PAGE}`, code: 'INVALID_PAGE' }, { status: 400 });
  }
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
    // 四条查询合成一次事务往返（task-70 T55-3）。Neon HTTP 下每条独立 await 都是一次串行
    // RTT，本页原先要付 4 次。四条同属一个 try/catch，原本任何一条失败就整体返回 500，
    // 合批不改变错误路径；只读事务里每条语句仍取各自的 read-committed 快照，行/列/排序
    // 与片段拼装逐字不变。facets 只与全库聚合有关，本可以长期缓存，但改协议面太大，见回报。
    const [rows, countRows, catRows, finishRows] = (await s.transaction((tx) => {
      // 动态条件拼装（neon 库的 tagged template 每个分支都要是完整 SQL 片段）
      const conds = [];
      if (query) {
        const like = `%${query.toLowerCase()}%`;
        conds.push(tx`(lower(title) LIKE ${like} OR lower(author) LIKE ${like} OR lower(labels::text) LIKE ${like})`);
      }
      if (category) conds.push(tx`(COALESCE(NULLIF(primary_genre, ''), category) = ${category})`);
      if (tag) {
        const tagLike = `%${tag.toLowerCase()}%`;
        // 括号必须包住整个 OR 组：AND 优先级更高，裸拼会让 tag 分支绕过其他筛选
        conds.push(tx`(lower(labels->>'genre') LIKE ${tagLike} OR lower(labels->>'style') LIKE ${tagLike} OR lower(labels->>'tone') LIKE ${tagLike})`);
      }
      if (finish) conds.push(tx`finish_status = ${finish}`);
      // 动态条件拼装（neon tagged template 不支持 sql.join，用 AND 手动归并）
      let where = tx``;
      if (conds.length === 1) {
        where = tx`WHERE ${conds[0]}`;
      } else if (conds.length > 1) {
        let merged = conds[0];
        for (let i = 1; i < conds.length; i++) {
          merged = tx`${merged} AND ${conds[i]}`;
        }
        where = tx`WHERE ${merged}`;
      }
      // 质量优先：分数降序，未评分的沉底（按打标时间近的在前）
      const orderBy =
        sort === 'oldest' ? tx`labeled_at ASC`
        : sort === 'title' ? tx`title ASC`
        : sort === 'recent' ? tx`labeled_at DESC`
        : tx`quality DESC NULLS LAST, labeled_at DESC`;

      // 无 read 权限时直接取 NULL，连定位子查询都不发。
      const readTask = canRead ? tx`(SELECT dt.id FROM download_tasks dt
                WHERE dt.book_id = labeled_books.id AND dt.status = 'done'
                ORDER BY dt.id DESC LIMIT 1)` : tx`NULL::integer`;
      return [
        tx`
        SELECT id, title, author, category, primary_genre, quality, finish_status,
               chars_labeled, labels, labeled_at::text AS labeled_at,
               ${readTask} AS read_task_id
        FROM labeled_books ${where}
        ORDER BY ${orderBy}
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        tx`
        SELECT count(*)::int AS total FROM labeled_books ${where}`,
        // 聚合可选筛选值（规范化主分类、完结状态）——给前端筛选条用
        tx`
        SELECT COALESCE(NULLIF(primary_genre, ''), category, '其他') AS category,
               count(*)::int AS n
        FROM labeled_books
        GROUP BY 1 ORDER BY n DESC LIMIT 20`,
        tx`
        SELECT finish_status, count(*)::int AS n FROM labeled_books
        WHERE finish_status <> '' GROUP BY finish_status ORDER BY n DESC LIMIT 10`,
      ];
    }, { readOnly: true })) as unknown as [
      LabeledBook[], { total: number }[], { category: string; n: number }[], { finish_status: string; n: number }[],
    ];

    return authJson({
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
        readTaskId: r.read_task_id ?? null,
        // 列表直出的简介级字段
        genre: labelText(r.labels, 'genre', 100),
        intro: labelText(r.labels, 'worldbuilding', 300) || labelText(r.labels, 'plot_stage', 300),
      })),
      total: countRows[0]?.total ?? 0,
      page,
      pageSize: PAGE_SIZE,
      maxPage: MAX_PAGE,
      facets: {
        categories: catRows.map((r) => ({ name: r.category, count: r.n })),
        finishStates: finishRows.map((r) => ({ name: r.finish_status, count: r.n })),
      },
    });
  } catch {
    return authJson({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
  }
}
