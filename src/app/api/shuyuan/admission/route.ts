import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authJson } from '@/lib/auth-http';
import { ensureSchema } from '@/lib/db';
import { admissionOwnCronEnabled, runAdmissionRound } from '@/lib/shuyuan';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// 42-admbudget：独立准入轮。准入不再只能吃 /api/shuyuan 刷新剩下的预算——本路由自带 295s 时限，
// runAdmissionRound 内用整份 ADMISSION_ROUND_BUDGET_MS。与刷新尾部的准入经 cron_health 租约互斥。
// 开关 ADMISSION_OWN_CRON 默认关：cron 照常打进来，但鉴权后直接返回、不碰库。
export const maxDuration = 295;

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 与 /api/shuyuan 的 cron 路径同款：只认 CRON_SECRET 的 Bearer 头，未配置则 fail closed。
// 只有 cron 身份，没有 owner 手动入口：手动跑准入仍走 POST /api/shuyuan 刷新（尾部带准入）。
function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

async function handleGET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return authJson({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  if (!admissionOwnCronEnabled()) return authJson({ skipped: 'disabled' });
  try {
    await ensureSchema();
    return authJson(await runAdmissionRound(req.signal));
  } catch (e) {
    // 对外文案固定，不回 e.message（可能含上游源 URL，同 /api/shuyuan）；详情进日志。
    console.error('shuyuan admission round failed', e instanceof Error ? { message: e.message } : e);
    return authJson({ error: '准入轮失败', code: 'ADMISSION_FAILED' }, { status: 502 });
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
