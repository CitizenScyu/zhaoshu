import { NextResponse } from 'next/server';

// 认证响应（包括错误）一律 private, no-store；涉及身份变化的响应补 Vary。
export const AUTH_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, X-Owner-Token',
} as const;

export function authJson(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { ...init, headers: { ...AUTH_NO_STORE_HEADERS, ...init?.headers } });
}

export function authError(
  status: number,
  code: string,
  error: string,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: { ...AUTH_NO_STORE_HEADERS, ...headers } });
}
