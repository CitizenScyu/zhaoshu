import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { ensureSchema } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import { disableShuyuanSource, getShuyuanStats, refreshShuyuan } from '@/lib/shuyuan';

// 书源管理：GET 看统计（owner）或由 Vercel cron 触发刷新，POST 手动刷新/打失效标记
export const maxDuration = 295;

const MAX_BODY_BYTES = 4 * 1024;

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Vercel authenticates cron invocations with CRON_SECRET in the Bearer header.
// Do not require an undocumented x-vercel-cron marker.
function cronRequest(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // 密钥未配置时 fail closed：请求头本身不是身份凭据，不能因缺配置放行
  if (!expected) return false;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

export async function GET(req: NextRequest) {
  const cron = cronRequest(req);
  const auth = cron ? null : await requirePermission(req, 'download');
  if (auth && !auth.ok) return withAuthHeaders(auth.response);
  try {
    await ensureSchema();
    if (cron) {
      // cron 路径：直接刷新
      const stats = await refreshShuyuan(req.signal);
      return authJson(stats);
    }
    return authJson(await getShuyuanStats(req.signal));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'internal error';
    return authJson({ error: message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission(req, 'download');
  if (!auth.ok) return withAuthHeaders(auth.response);
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return authJson({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const action = typeof body?.action === 'string' ? body.action : 'refresh';

  try {
    await ensureSchema();
    if (action === 'disable') {
      const url = typeof body?.url === 'string' ? body.url : '';
      if (!url) {
        return authJson({ error: 'missing url' }, { status: 400 });
      }
      const error = typeof body?.error === 'string' ? body.error : '';
      const updated = await disableShuyuanSource(url, error);
      return authJson({ disabled: updated });
    }
    if (action !== 'refresh') {
      return authJson({ error: 'unknown action' }, { status: 400 });
    }
    const stats = await refreshShuyuan(req.signal);
    return authJson(stats);
  } catch (e) {
    const message = e instanceof Error ? e.message : '刷新失败';
    return authJson({ error: message }, { status: 502 });
  }
}
