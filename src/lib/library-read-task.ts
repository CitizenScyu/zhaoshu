import { getSql } from '@/lib/db';
import { normalizeBookAuthor, normalizeBookTitle } from '@/lib/book-identity';
import type { PersonalQuery } from '@/lib/personal-write';

// readerlocal42：书源阅读入口的书仓直读提示。
// /api/find/exact 与 /api/library 已按同身份口径暴露 sharedReadTaskId；/read/source 入口
// 此前不知道书仓里已有同书的 done 全文，用户从书源搜索进来时仍走活源逐章请求。
// 这里在目录建成后的响应里附带一次 done 任务查询，前端渲染提示条一键跳 /read/<id>。
// 只提示、不切换会话：正文交付路径零变化，旧前端忽略该字段。

/** 与 reader-server 共享阅读口径一致：done 的 legacy 文件可读；有注册指针的任务必须指向 published 产物。 */
function doneReadTaskQuery(
  sql: PersonalQuery, titleKey: string, authorKey: string, registryAvailable: boolean,
) {
  const readableArtifact = registryAvailable ? sql`(
    to_jsonb(dt)->>'artifact_id' IS NULL OR EXISTS (
      SELECT 1 FROM book_artifacts a JOIN storage_repositories r ON r.id = a.repository_id
      WHERE a.id = (to_jsonb(dt)->>'artifact_id')::bigint AND a.quality_status = 'published'
        AND a.labeled_book_id = dt.book_id
        AND a.canonical_path !~ ${'[\\\\\\x00-\\x1f\\x7f]'}
        AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(a.canonical_path, '/')) AS segment
          WHERE segment IN ('', '.', '..'))
    ))` : sql`to_jsonb(dt)->>'artifact_id' IS NULL`;
  // 嵌套片段只能在模板里内插（与 user-data.exactLibraryBooksForUserQuery 同范式），不能包一层再调用。
  return sql`SELECT dt.id FROM download_tasks dt
    WHERE lower(btrim(dt.title)) = ${titleKey}
      AND lower(COALESCE(NULLIF(btrim(dt.author), ''), '佚名')) = ${authorKey}
      AND dt.status = 'done' AND ${readableArtifact}
    ORDER BY dt.id DESC LIMIT 1`;
}

/**
 * 按规范化书名/作者身份键查同书最新的可读 done 任务。
 * canRead=false 或查询失败一律返回 null（提示是加分项，绝不拖垮目录交付）。
 * 身份匹配与 user-data.exactLibraryBooksForUserQuery 的 booksReadTask 同口径
 * （lower(btrim) + 佚名兜底），见本书 done 判据的既有注释。
 */
export async function findDoneReadTask(canRead: boolean, title: string, author: string): Promise<number | null> {
  if (!canRead) return null;
  try {
    const sql = getSql();
    // 注册表探测与 find/exact 同款：旧库（book_artifacts 未建）只认 legacy 无指针任务。
    const registry = await sql`
      SELECT to_regclass('book_artifacts') IS NOT NULL
        AND to_regclass('storage_repositories') IS NOT NULL AS available
    ` as { available: boolean }[];
    const rows = await doneReadTaskQuery(
      sql, normalizeBookTitle(title).toLowerCase(), normalizeBookAuthor(author).toLowerCase(),
      registry[0]?.available === true,
    ) as { id: number }[];
    const id = rows[0]?.id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
  } catch {
    return null;
  }
}
