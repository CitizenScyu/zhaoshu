import type { NextRequest } from 'next/server';
import { requireOwner } from './auth';
import { withAuthHeaders } from './auth-http';
import { verifySameOriginWrite } from './csrf';

export type OwnerGuard = { ok: true; principal: { userId: number; role: string; authMethod: 'owner-header' | 'session' } } | { ok: false; response: Response };

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
