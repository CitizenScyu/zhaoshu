import { NextRequest, NextResponse } from 'next/server';
import { authAccountsEnabled, requireApiOwner, verifyOwnerHeader } from '@/lib/auth';
import { AUTH_NO_STORE_HEADERS } from '@/lib/auth-http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

export const maxDuration = 60;

// Validate a draft token without reading business data or initializing the DB.
// 账号模式下旧口令入口进入共享失败预算（先查冷却再验证，错误才计数，
// 库故障 503）；仍只认显式口令，绝不借有效 Cookie 验证错误草稿。
async function handleGET(req: NextRequest) {
  if (authAccountsEnabled()) {
    const result = await verifyOwnerHeader(req);
    if (!result.ok) return result.response;
    return NextResponse.json({ ok: true }, { headers: AUTH_NO_STORE_HEADERS });
  }

  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  return NextResponse.json({ ok: true }, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, X-Owner-Token' },
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
