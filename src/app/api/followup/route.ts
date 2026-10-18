import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authJson } from '@/lib/auth-http';
import { runFollowupRound } from '@/lib/followup';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// zhuigeng42：追更轮。由 phoenix 侧 systemd timer 定期 curl 打（与准入轮同款节奏）；
// Vercel Hobby 每路由每日只 1 次 cron，扛不住追更需要的小时级节奏。
export const maxDuration = 60;

// 只认 CRON_SECRET 的 Bearer 头，未配置则 fail closed（同 /api/shuyuan/admission）。
function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

async function handlePOST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return authJson({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    const round = await runFollowupRound(req.signal);
    return authJson(round);
  } catch (error) {
    // 对外文案固定，不回 e.message（可能含上游源 URL）；详情进日志。
    console.error('followup round failed', error instanceof Error ? { message: error.message } : error);
    return authJson({ error: '追更轮失败', code: 'FOLLOWUP_FAILED' }, { status: 502 });
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
