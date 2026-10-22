import { getSql } from '@/lib/db';
import { normalizeBookAuthor, normalizeBookTitle } from '@/lib/book-identity';
import type { PersonalQuery } from '@/lib/personal-write';

// readerlocal42：书源阅读入口的书仓直读提示。
// /api/find/exact 与 /api/library 已按同身份口径暴露 sharedReadTaskId；/read/source 入口
// 此前不知道书仓里已有同书的 done 全文，用户从书源搜索进来时仍走活源逐章请求。
// 这里在目录建成后的响应里附带一次 done 任务查询，前端渲染提示条一键跳 /read/<id>。
// 只提示、不切换会话：正文交付路径零变化，旧前端忽略该字段。

// readerlocal42 修订（2026-10-22）：两侧归一必须逐字等价，此前不对称——SQL 侧只做
// lower(btrim(dt.title))，JS 侧传 normalizeBookTitle（NFKC + 剥《》），《余生》vs 余生、
// 全角/兼容字符均恒不等；作者侧 JS 空值是 ''，SQL 却 COALESCE 成 '佚名'，恒不匹配 ⇒
// 提示条对这类行静默失效。修复：SQL 侧复刻 0002 迁移的权威键生成式（PG 内建
// normalize(x, NFKC)，生产实测可用），JS 侧对齐 user-data booksReadTask 的空作者口径。
// download_tasks 无 title_key 生成列（0002 只覆盖 books/labeled_books），所以这里内联
// 表达式而不是引用列。旧式能匹配的（裸标题、非空作者）在新表达式下结果不变，不削弱。
const TITLE_KEY_EXPR = `lower(btrim(regexp_replace(btrim(normalize(dt.title, NFKC)), '^《([^\\n]+)》$', '\\1')))`;
const AUTHOR_KEY_EXPR = `lower(btrim(normalize(dt.author, NFKC)))`;

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
    WHERE ${sql.unsafe(TITLE_KEY_EXPR)} = ${titleKey}
      AND COALESCE(NULLIF(${sql.unsafe(AUTHOR_KEY_EXPR)}, ''), '佚名') = ${authorKey}
      AND dt.status = 'done' AND ${readableArtifact}
    ORDER BY dt.id DESC LIMIT 1`;
}

// 表存在性单调（只建不删），once-true 可缓存：省掉目录响应里每次一发的 to_regclass 探测。
let registryAvailable: boolean | null = null;

/**
 * 按规范化书名/作者身份键查同书最新的可读 done 任务。
 * canRead=false 或查询失败一律返回 null（提示是加分项，绝不拖垮目录交付）。
 * 两侧同口径（2026-10-22 修订）：SQL 侧内联 0002 权威键生成式，JS 侧同一归一函数；
 * 空作者两侧都映射 '佚名'（与 user-data.exactLibraryBooksForUserQuery 的
 * booksReadTask COALESCE/NULLIF 兜底逐字一致）。
 */
export async function findDoneReadTask(canRead: boolean, title: string, author: string): Promise<number | null> {
  if (!canRead) return null;
  try {
    const sql = getSql();
    // 注册表探测与 find/exact 同款：旧库（book_artifacts 未建）只认 legacy 无指针任务。
    if (registryAvailable === null) {
      const registry = await sql`
        SELECT to_regclass('book_artifacts') IS NOT NULL
          AND to_regclass('storage_repositories') IS NOT NULL AS available
      ` as { available: boolean }[];
      registryAvailable = registry[0]?.available === true;
    }
    const authorKey = normalizeBookAuthor(author).toLowerCase();
    const rows = await doneReadTaskQuery(
      sql, normalizeBookTitle(title).toLowerCase(),
      authorKey === '' ? '佚名' : authorKey,
      registryAvailable,
    ) as { id: number }[];
    const id = rows[0]?.id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
  } catch {
    return null;
  }
}
