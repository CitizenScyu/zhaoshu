import type { NextRequest } from 'next/server';
import { guardOwnerRead } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { getSql } from '@/lib/db';
import { boundedPositiveInteger } from '@/lib/http';

const UNAVAILABLE = '用户列表暂时不可用，请稍后重试。';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface AdminUserSummary {
  id: number;
  username: string;
  role: string;
  canFind: boolean;
  canRead: boolean;
  canDownload: boolean;
  disabled: boolean;
  createdAt: string;
  inviteHint: string | null;
}

type UserRow = {
  id: number;
  username: string;
  role: string;
  can_find: boolean;
  can_read: boolean;
  can_download: boolean;
  disabled_at: string | null;
  created_at: string;
  invite_hint: string | null;
};

// 不返回 password_hash、会话 token 或邀请码原文；邀请来源只给短提示。
export function toAdminUser(row: UserRow): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    canFind: row.can_find,
    canRead: row.can_read,
    canDownload: row.can_download,
    disabled: row.disabled_at !== null,
    createdAt: row.created_at,
    inviteHint: row.invite_hint,
  };
}

export async function GET(req: NextRequest) {
  const guard = await guardOwnerRead(req);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const page = boundedPositiveInteger(url.searchParams.get('page')) ?? 1;
  const requestedSize = boundedPositiveInteger(url.searchParams.get('pageSize'));
  const pageSize = Math.min(requestedSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  try {
    const sql = getSql();
    const counts = await sql`SELECT count(*)::int AS total FROM users` as { total: number }[];
    const rows = await sql`
      SELECT u.id, u.username, u.role, u.can_find, u.can_read, u.can_download,
             u.disabled_at::text AS disabled_at, u.created_at::text AS created_at,
             i.code_hint AS invite_hint
      FROM users u
      LEFT JOIN registration_invites i ON i.id = u.created_via_invite_id
      ORDER BY u.id ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` as UserRow[];
    return authJson({
      users: rows.map(toAdminUser),
      page,
      pageSize,
      total: counts[0]?.total ?? 0,
    });
  } catch {
    return authError(503, 'USERS_UNAVAILABLE', UNAVAILABLE);
  }
}
