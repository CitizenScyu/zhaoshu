import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 设计 §2.4：所有浏览器写请求要求固定自定义头 + Origin 严格同源校验。
// 固定头依赖浏览器同源与预检机制，不是秘密 token；不实现同步 CSRF token。
export const CSRF_HEADER = 'x-nf-csrf';
export const CSRF_HEADER_VALUE = '1';

function csrfFailure(code: string): NextResponse {
  return NextResponse.json({ error: 'request rejected by CSRF protection', code }, {
    status: 403,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function isTrustedOrigin(req: NextRequest, origin: string): boolean {
  // 显式配置的可信应用 origin 优先；配置来源不能直接信任任意 Host / X-Forwarded-Host。
  const configured = process.env.AUTH_TRUSTED_ORIGIN;
  if (configured && origin === configured) return true;
  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

// 浏览器写请求（登录、owner 兑换、登出等）统一入口：缺固定头、缺 Origin、
// Origin: null 与跨源 Origin 一律拒绝；无 Origin 的旧脚本只能走显式 owner 头通道。
export function verifySameOriginWrite(req: NextRequest): NextResponse | null {
  if (req.headers.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return csrfFailure('CSRF_HEADER_REQUIRED');
  }
  const origin = req.headers.get('origin');
  if (origin === null) return csrfFailure('ORIGIN_REQUIRED');
  if (origin === 'null') return csrfFailure('ORIGIN_NULL');
  if (!isTrustedOrigin(req, origin)) return csrfFailure('ORIGIN_MISMATCH');
  return null;
}

// 有 JSON 正文的端点仅接受 application/json；拒绝普通表单类型与文本正文。
export function isJsonContentType(req: NextRequest): boolean {
  const contentType = req.headers.get('content-type');
  return contentType !== null && contentType.toLowerCase().startsWith('application/json');
}
