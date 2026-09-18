import type { NextRequest } from 'next/server';
import { requireOwner, requirePermission } from './auth';
import type { Permission, Principal } from './auth-types';
import { authError, withAuthHeaders } from './auth-http';
import { isJsonContentType, verifySameOriginWrite } from './csrf';

export type OwnerGuard = { ok: true; principal: { userId: number; role: string; authMethod: 'owner-header' | 'session' } } | { ok: false; response: Response };
export type PermissionGuard = { ok: true; principal: Principal } | { ok: false; response: Response };

// owner 管理接口的统一入口。读请求只鉴权；写请求再套 CSRF，判定与 /api/admin/llm 逐字一致：
// 浏览器（会话身份，或带 Origin）必须带固定头且严格同源；显式 owner 头的脚本通道没有 Cookie，
// 保持零 Cookie 语义。把这段复制到每个新路由里迟早会漏一处，所以集中在类型化函数里。
export async function guardOwnerRead(req: NextRequest): Promise<OwnerGuard> {
  const auth = await requireOwner(req);
  if (!auth.ok) return { ok: false, response: withAuthHeaders(auth.response) };
  return { ok: true, principal: auth.principal };
}

export async function guardOwnerWrite(req: NextRequest): Promise<OwnerGuard> {
  const auth = await requireOwner(req);
  if (!auth.ok) return { ok: false, response: withAuthHeaders(auth.response) };
  if (auth.principal.authMethod === 'session' || req.headers.has('origin')) {
    const csrf = verifySameOriginWrite(req);
    if (csrf) return { ok: false, response: withAuthHeaders(csrf) };
  }
  return { ok: true, principal: auth.principal };
}

// 普通（非流式）业务写路由的统一入口，落点：/api/download（POST/DELETE）、/api/shuyuan（POST）。
// 校验段与 PersonalRequest.authorize()（src/lib/personal-request.ts）逐字一致：先用能力位鉴权，
// 再对「session 身份或带 Origin 的浏览器请求」要求同源固定头，POST/PUT/PATCH 还要求 application/json。
// 两处并存的原因：PersonalRequest 服务于需要预算/流式响应的个人路由（find/feedback/profile/shelf），
// 本函数服务于直接使用 requirePermission、无流式预算的普通写路由；二者共享 csrf.ts 同一套原语。
// owner 头脚本通道（无 Cookie、无 Origin）authMethod 为 'owner-header' 且无 Origin，按设计不受影响。
export async function guardPermissionWrite(req: NextRequest, permission: Permission): Promise<PermissionGuard> {
  const auth = await requirePermission(req, permission);
  if (!auth.ok) return { ok: false, response: withAuthHeaders(auth.response) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const browserWrite = auth.principal.authMethod === 'session' || req.headers.has('origin');
    if (browserWrite) {
      const csrf = verifySameOriginWrite(req);
      if (csrf) return { ok: false, response: withAuthHeaders(csrf) };
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !isJsonContentType(req)) {
        return { ok: false, response: withAuthHeaders(authError(415, 'JSON_REQUIRED', 'application/json is required')) };
      }
    }
  }
  return { ok: true, principal: auth.principal };
}
