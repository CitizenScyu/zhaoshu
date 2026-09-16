import type { NextRequest } from 'next/server';
import { authAccountsEnabled, principalFromSessionRecord, verifyOwnerHeader } from '@/lib/auth';
import { findSessionByToken, getSessionTokenFromRequest } from '@/lib/auth-session';
import { getSql } from '@/lib/db';
import { authError, authJson } from '@/lib/auth-http';

function ownerUser() {
  return {
    id: 1,
    username: 'owner',
    role: 'owner' as const,
    canFind: true,
    canRead: true,
    canDownload: true,
    authMethod: 'owner-header' as const,
  };
}

// 匿名或当前凭据：无 Cookie 时 200 {user:null}；有效时只返回最小用户信息，
// 绝不返回 token / hash；过期凭据 401，库故障 503，均 no-store。
// accountsEnabled 是前端选择登录流程所需的部署开关，不是秘密（试登录接口即可探测）。
export async function GET(req: NextRequest) {
  if (!authAccountsEnabled()) {
    // 旧模式不触碰数据库，也不把任何凭据当作已登录。
    return authJson({ user: null, accountsEnabled: false });
  }

  const hasAuthHeaders = req.headers.get('authorization') !== null
    || req.headers.get('x-owner-token') !== null;
  const cookieToken = getSessionTokenFromRequest(req);

  if (!hasAuthHeaders && !cookieToken) {
    return authJson({ user: null, accountsEnabled: true });
  }

  if (hasAuthHeaders) {
    const result = await verifyOwnerHeader(req);
    if (!result.ok) return result.response;
    return authJson({ user: ownerUser(), accountsEnabled: true });
  }

  let record;
  try {
    record = await findSessionByToken(getSql(), cookieToken as string);
  } catch {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }
  const result = principalFromSessionRecord(record);
  if (!result.ok) return result.response;
  return authJson({
    accountsEnabled: true,
    user: {
      id: result.principal.userId,
      username: record?.username,
      role: result.principal.role,
      canFind: result.principal.canFind,
      canRead: result.principal.canRead,
      canDownload: result.principal.canDownload,
      authMethod: result.principal.authMethod,
    },
  });
}
