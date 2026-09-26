import type { NextRequest } from 'next/server';
import { guardOwnerRead } from '@/lib/admin-http';
import { authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { downloadObservation } from '@/lib/download-observation';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

async function handleGET(req: NextRequest) {
  const guard = await guardOwnerRead(req);
  if (!guard.ok) return guard.response;
  try {
    await ensureSchema();
    return authJson(await downloadObservation(getSql()));
  } catch {
    return authJson({ error: '下载队列统计暂不可用', code: 'STATS_UNAVAILABLE' }, { status: 503 });
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
