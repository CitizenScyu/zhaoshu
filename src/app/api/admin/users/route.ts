import { toAdminUser, type UserRow } from './user-summary';
import type { NextRequest } from 'next/server';
import { guardOwnerRead } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { getSql } from '@/lib/db';
import { boundedPositiveInteger } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

const UNAVAILABLE = '用户列表暂时不可用，请稍后重试。';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

async function handleGET(req: NextRequest) {
  const guard = await guardOwnerRead(req);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const page = boundedPositiveInteger(url.searchParams.get('page')) ?? 1;
  const requestedSize = boundedPositiveInteger(url.searchParams.get('pageSize'));
  const pageSize = Math.min(requestedSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  try {
    const sql = getSql();
    // 两条独立只读查询同进同退，复用现有事务批次以省去一次 HTTP 往返。
    const [counts, rows] = await sql.transaction((tx) => [
      tx`SELECT count(*)::int AS total FROM users`,
      tx`
      SELECT u.id, u.username, u.role, u.can_find, u.can_read, u.can_download,
             u.disabled_at::text AS disabled_at, u.created_at::text AS created_at,
             i.code_hint AS invite_hint
      FROM users u
      LEFT JOIN registration_invites i ON i.id = u.created_via_invite_id
      ORDER BY u.id ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    ], { readOnly: true }) as [{ total: number }[], UserRow[]];
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

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
