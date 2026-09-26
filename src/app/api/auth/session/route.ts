import { NextResponse, type NextRequest } from 'next/server';
import { authAccountsEnabled, principalFromSessionRecord, verifyOwnerHeader } from '@/lib/auth';
import {
  clearedSessionCookieOptions,
  findSessionByToken,
  getSessionCookieName,
  getSessionTokenFromRequest,
} from '@/lib/auth-session';
import { getSql } from '@/lib/db';
import { authError, authJson, withAuthHeaders } from '@/lib/auth-http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

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

// 失效 Cookie 的 401：状态码与正文原样保留（前端靠 401 判定账号模式），补 no-store，
// 并按登出同一套属性过期 Cookie，免得浏览器每个页面都带着它再撞一次 401。
function expireSessionCookie(response: Response): NextResponse {
  const wrapped = withAuthHeaders(response);
  const cleared = new NextResponse(wrapped.body, { status: wrapped.status, headers: wrapped.headers });
  cleared.cookies.set(getSessionCookieName(), '', clearedSessionCookieOptions());
  return cleared;
}

// 匿名或当前凭据：无 Cookie 时 200 {user:null}；有效时只返回最小用户信息，
// 绝不返回 token / hash；过期凭据 401（并过期该 Cookie），库故障 503，均 no-store。
// 旧口令模式恒 200：前端 auth-client 把本接口的 401 当作「必然是账号模式」，改这里须同步那边。
// accountsEnabled 是前端选择登录流程所需的部署开关，不是秘密（试登录接口即可探测）。
async function handleGET(req: NextRequest) {
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
  if (!result.ok) {
    // 只清 401（会话无效/过期/代际不符）；403 是成员闸门关闭，会话本身仍有效。
    return result.response.status === 401 ? expireSessionCookie(result.response) : result.response;
  }
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

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
