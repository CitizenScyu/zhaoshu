import type { NextRequest } from 'next/server';
import { guardOwnerWrite } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { getSql } from '@/lib/db';
import { boundedPositiveInteger, readJsonBody, RequestBodyError } from '@/lib/http';

const MAX_BODY_BYTES = 2 * 1024;
const UNAVAILABLE = '用户设置暂时不可用，请稍后重试。';

// owner 修改一个成员的三项能力或禁用状态。id=1 的 owner 行有 CHECK 约束钉死，
// 界面不提供入口、接口也直接拒绝——绝不在这里给 owner 降权或改名。
// 权限组合与表上的 CHECK 同一套语义，先在接口层给出可读错误，再让数据库兜底。
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardOwnerWrite(req);
  if (!guard.ok) return guard.response;

  const id = boundedPositiveInteger((await params).id);
  if (id === null) return authError(400, 'INVALID_ID', '用户 id 无效');
  if (id === 1) return authError(403, 'OWNER_ACCOUNT_FIXED', '不能修改 owner 账号');

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return authError(413, error.code, error.message);
    throw error;
  }
  if (!body) return authError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');

  const fields = ['canFind', 'canRead', 'canDownload'] as const;
  for (const field of fields) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      return authError(400, 'INVALID_BODY', `${field} 只能是布尔值`);
    }
  }
  if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
    return authError(400, 'INVALID_BODY', 'disabled 只能是布尔值');
  }
  if (fields.every((field) => body[field] === undefined) && body.disabled === undefined) {
    return authError(400, 'INVALID_BODY', '至少提供一项要修改的字段');
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT can_find, can_read, can_download FROM users
      WHERE id = ${id}::int AND role = 'member'` as { can_find: boolean; can_read: boolean; can_download: boolean }[];
    const current = rows[0];
    if (!current) return authError(404, 'USER_NOT_FOUND', '用户不存在');

    const canFind = typeof body.canFind === 'boolean' ? body.canFind : current.can_find;
    const canRead = typeof body.canRead === 'boolean' ? body.canRead : current.can_read;
    const canDownload = typeof body.canDownload === 'boolean' ? body.canDownload : current.can_download;
    if (!canFind && canRead) {
      return authError(400, 'INVALID_PERMISSIONS', '阅读权限依赖找书权限：开启阅读时必须同时开启找书');
    }
    if (!(canFind && canRead) && canDownload) {
      return authError(400, 'INVALID_PERMISSIONS', '下载权限依赖找书与阅读权限：开启下载时必须同时开启两者');
    }
    const disabled = body.disabled === true;

    // 禁用与撤销全部会话放在同一事务里：即使别处漏了 disabled_at 判定，也不留下可用会话。
    const results = (await sql.transaction((tx) => [
      tx`
        UPDATE users SET can_find = ${canFind}, can_read = ${canRead}, can_download = ${canDownload},
          disabled_at = CASE WHEN ${disabled}::boolean THEN now() ELSE NULL END, updated_at = now()
        WHERE id = ${id}::int AND role = 'member'
        RETURNING id, username, can_find, can_read, can_download, disabled_at::text AS disabled_at, created_at::text AS created_at`,
      tx`DELETE FROM sessions WHERE user_id = ${id}::int AND ${disabled}::boolean`,
    ])) as [{ id: number; username: string; can_find: boolean; can_read: boolean; can_download: boolean; disabled_at: string | null; created_at: string }[], unknown[]];
    const updated = results[0][0];
    if (!updated) return authError(404, 'USER_NOT_FOUND', '用户不存在');
    return authJson({
      user: {
        id: updated.id,
        username: updated.username,
        role: 'member',
        canFind: updated.can_find,
        canRead: updated.can_read,
        canDownload: updated.can_download,
        disabled: updated.disabled_at !== null,
        createdAt: updated.created_at,
      },
    });
  } catch {
    return authError(503, 'USERS_UNAVAILABLE', UNAVAILABLE);
  }
}
