import { labelText } from './label-text';
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { hasPermission } from '@/lib/permissions';
import { ensureSchema, getSql } from '@/lib/db';
import { isRecord } from '@/lib/sanitize';
import { boundedPositiveInteger } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

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
  shared_read_task_id: number | null;
  my_download_task_id: number | null;
}

const SORTS = new Set(['quality', 'recent', 'oldest', 'title']);

// LIKE 通配符转义（P2-2）：q/tag 来自用户输入，未转义的 %/_ 会变成通配符——
// 既造成误匹配（搜 "100%" 命中一切含 100 的行），也放大扫描成本。反斜杠本身
// 是 PG LIKE 的默认转义符，必须最先转义，且显式 ESCAPE '\\' 固定语义。
// 转义只影响 LIKE 模式解释，不影响等值比较，中文书名不含这些字符时零变化。
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

async function handleGET(req: NextRequest) {
  const auth = await requirePermission(req, 'find');
  if (!auth.ok) return withAuthHeaders(auth.response);
  // 书库是共享元数据：找书组即可看。完成 TXT 的定位只在有 read 权限时返回，
  // 与 recommendationsForUserQuery 的 read_task_id 门控同源。
  const canRead = hasPermission(auth.principal, 'read');
  const canDownload = hasPermission(auth.principal, 'download');
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
      // 书库只列真实可用的书（usable1104）：至少有一个 done 下载任务（完整 TXT 已入库/发布）。
      // partial/failed 永不发布，只打了标却拿不到正文的书（如只有付费墙源）不进书库；
      // 列表、计数与两个 facet 用同一条件，筛选条计数与列表一致。
      const usable = tx`EXISTS (SELECT 1 FROM download_tasks ud
                WHERE ud.book_id = labeled_books.id AND ud.status = 'done')`;
      // 动态条件拼装（neon 库的 tagged template 每个分支都要是完整 SQL 片段）
      const conds = [usable];
      if (query) {
        const like = `%${escapeLike(query.toLowerCase())}%`;
        conds.push(tx`(lower(title) LIKE ${like} ESCAPE '\\' OR lower(author) LIKE ${like} ESCAPE '\\' OR lower(labels::text) LIKE ${like} ESCAPE '\\')`);
      }
      // 与下方分类聚合同一归一式（facet1102）：category 也会是空串，只 NULLIF primary_genre 会聚出无名分类
      // 「（1）」，且点「其他」筛不到这些行。
      if (category) conds.push(tx`(COALESCE(NULLIF(primary_genre, ''), NULLIF(category, ''), '其他') = ${category})`);
      if (tag) {
        const tagLike = `%${escapeLike(tag.toLowerCase())}%`;
        // 括号必须包住整个 OR 组：AND 优先级更高，裸拼会让 tag 分支绕过其他筛选
        conds.push(tx`(lower(labels->>'genre') LIKE ${tagLike} ESCAPE '\\' OR lower(labels->>'style') LIKE ${tagLike} ESCAPE '\\' OR lower(labels->>'tone') LIKE ${tagLike} ESCAPE '\\')`);
      }
      if (finish) conds.push(tx`finish_status = ${finish}`);
      // 动态条件拼装（neon tagged template 不支持 sql.join，用 AND 手动归并）
      let merged = conds[0];
      for (let i = 1; i < conds.length; i++) {
        merged = tx`${merged} AND ${conds[i]}`;
      }
      const where = tx`WHERE ${merged}`;
      // 质量优先：分数降序，未评分的沉底（按打标时间近的在前）
      const orderBy =
        sort === 'oldest' ? tx`labeled_at ASC`
        : sort === 'title' ? tx`title ASC`
        : sort === 'recent' ? tx`labeled_at DESC`
        : tx`quality DESC NULLS LAST, labeled_at DESC`;

      // 共享阅读是既有明确设计：任何有 read 权限的用户都可在线阅读任意用户的 done 文件。
      // 这里只暴露「共享可读定位」，绝不把它当成当前用户的私有下载任务 id 使用（F18）。
      const sharedReadTask = canRead ? tx`(SELECT dt.id FROM download_tasks dt
                WHERE dt.book_id = labeled_books.id AND dt.status = 'done'
                ORDER BY dt.id DESC LIMIT 1)` : tx`NULL::integer`;
      // 当前用户自己在这本书上的最新任务：下载 / 取消 / 取回都只走这个 id。
      // 与共享可读分开取，避免拿别人的完成任务去查强制 user_id 的 /api/download（F18）。
      const myDownloadTask = canDownload ? tx`(SELECT dt.id FROM download_tasks dt
                WHERE dt.requested_by = 'user' AND dt.user_id = ${auth.principal.userId} AND dt.book_id = labeled_books.id
                ORDER BY dt.created_at DESC, dt.id DESC LIMIT 1)` : tx`NULL::integer`;
      // 先分页、后取列（libpage1103）：两条相关子查询和 labels 原先对 OFFSET 跳过的行也要算，
      // 生产实测第 170 页 2.1s、随页号线性变慢。内层只按排序键取本页 id，外层只对这 30 行
      // 算子查询；外层按同一排序键 + id 重排，id 唯一，行与顺序逐字不变。
      return [
        tx`
        SELECT id, title, author, category, primary_genre, quality, finish_status,
               chars_labeled, labels, labeled_at::text AS labeled_at,
               ${sharedReadTask} AS shared_read_task_id,
               ${myDownloadTask} AS my_download_task_id
        FROM labeled_books
        JOIN (SELECT id AS page_id FROM labeled_books ${where}
              ORDER BY ${orderBy}, id DESC
              LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}) AS page_ids
          ON page_ids.page_id = labeled_books.id
        ORDER BY ${orderBy}, id DESC`,
        tx`
        SELECT count(*)::int AS total FROM labeled_books ${where}`,
        // 聚合可选筛选值（规范化主分类、完结状态）——给前端筛选条用
        tx`
        SELECT COALESCE(NULLIF(primary_genre, ''), NULLIF(category, ''), '其他') AS category,
               count(*)::int AS n
        FROM labeled_books WHERE ${usable}
        GROUP BY 1 ORDER BY n DESC LIMIT 20`,
        tx`
        SELECT finish_status, count(*)::int AS n FROM labeled_books
        WHERE ${usable} AND finish_status <> '' GROUP BY finish_status ORDER BY n DESC LIMIT 10`,
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
        // 共享可读：任意用户的 done 文件，供在线阅读。
        sharedReadTaskId: r.shared_read_task_id ?? null,
        // 私有：当前用户自己在这本书上的最新任务，供下载 / 取消 / 取回。
        myDownloadTaskId: r.my_download_task_id ?? null,
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
  } catch (e) {
    console.error('library query failed', e instanceof Error ? { message: e.message } : e);
    return authJson({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
