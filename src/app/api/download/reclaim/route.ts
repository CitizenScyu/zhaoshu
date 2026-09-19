import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { reclaimStaleTasks } from '@/lib/download-task-reclaim';

// F16：每日回收过期下载租约；主要恢复路径仍是 POST 与前端受控重试。
// R1：反馈吸收由独立 cron /api/profile/absorb/drain 执行，使用自己的 295s 时限。
export const maxDuration = 30;

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 与 /api/shuyuan 的 cron 路径同款：只认 CRON_SECRET 的 Bearer 头，未配置则 fail closed。
function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return authJson({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    await ensureSchema();
    await reclaimStaleTasks(getSql());
    return authJson({ ok: true });
  } catch (e) {
    console.error('download reclaim failed', e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}
