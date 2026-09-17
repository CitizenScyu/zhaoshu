import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { ensureSchema } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import { disableShuyuanSource, enableShuyuanSource, getShuyuanStats, refreshShuyuan } from '@/lib/shuyuan';
import { parseSourceFilter, parseSourcePage } from '@/lib/shuyuan-view';

// 书源管理：GET 看统计/分页明细（owner）或由 Vercel cron 触发刷新，
// POST 手动刷新 / 打失效标记 / 重新启用。
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
    // 不带 filter 的请求保持旧形状（只统计 + 默认明细），分页元信息只在显式筛选时附上。
    const filter = req.nextUrl.searchParams.get('filter');
    if (filter === null) return authJson(await getShuyuanStats(req.signal));
    return authJson(await getShuyuanStats(req.signal, {
      filter: parseSourceFilter(filter),
      page: parseSourcePage(req.nextUrl.searchParams.get('page')),
    }));
  } catch (e) {
    // 对外文案固定，不回 e.message：shuyuan.ts 的 fetch 失败消息含上游 URL，
    // 原样返回会把源站地址泄给浏览器（audit P2-5）。错误详情进日志。
    console.error('shuyuan stats failed', e instanceof Error ? { message: e.message } : e);
    return authJson({ error: '书源统计暂不可用，请稍后重试' }, { status: 502 });
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
    if (action === 'enable') {
      const url = typeof body?.url === 'string' ? body.url : '';
      if (!url) {
        return authJson({ error: 'missing url' }, { status: 400 });
      }
      // 与 disable 同权限、同入参形状；URL 不在库里返回 enabled:false 而不是 404，
      // 避免把「这个源还在不在合集里」变成一个可探测的信号。
      const updated = await enableShuyuanSource(url);
      return authJson({ enabled: updated });
    }
    if (action !== 'refresh') {
      return authJson({ error: 'unknown action' }, { status: 400 });
    }
    const stats = await refreshShuyuan(req.signal);
    return authJson(stats);
  } catch (e) {
    // 同 GET：对外固定文案（POST 的失败消息同样可能含上游 URL），详情进日志。
    console.error('shuyuan refresh failed', e instanceof Error ? { message: e.message } : e);
    return authJson({ error: '刷新失败' }, { status: 502 });
  }
}
