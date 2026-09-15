import type { NextRequest } from 'next/server';
import { authAccountsEnabled } from '@/lib/auth';
import {
  clearedSessionCookieOptions,
  ensureAuthSchema,
  getSessionCookieName,
  getSessionTokenFromRequest,
  revokeSession,
} from '@/lib/auth-session';
import { verifySameOriginWrite } from '@/lib/csrf';
import { getSql } from '@/lib/db';
import { authError, authJson } from '@/lib/auth-http';

// 幂等退出：删除服务端行并清 Cookie；无 Cookie 或未知会话同样返回成功。
// 数据库删除失败时不清 Cookie，返回“退出尚未完成”，允许重试。
export async function POST(req: NextRequest) {
  if (!authAccountsEnabled()) {
    return authError(503, 'ACCOUNTS_DISABLED', 'account features are not enabled');
  }
  const csrfFailure = verifySameOriginWrite(req);
  if (csrfFailure) return csrfFailure;

  const token = getSessionTokenFromRequest(req);
  if (token !== null) {
    try {
      await ensureAuthSchema();
      await revokeSession(getSql(), token);
    } catch {
      return authError(503, 'LOGOUT_INCOMPLETE', 'logout has not completed; retry');
    }
  }

  const response = authJson({ ok: true });
  response.cookies.set(getSessionCookieName(), '', clearedSessionCookieOptions());
  return response;
}
