import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
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

// Vercel cron 每天调用一次：带 x-vercel-cron 头，配置了 CRON_SECRET 时附 Bearer
function cronRequest(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') !== '1') return false;
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized && !cronRequest(req)) return unauthorized;
  try {
    await ensureSchema();
    if (unauthorized) {
      // cron 路径：直接刷新
      const stats = await refreshShuyuan();
      return NextResponse.json(stats);
    }
    return NextResponse.json(await getShuyuanStats());
  } catch (e) {
    const message = e instanceof Error ? e.message : 'internal error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message }, { status: 413 });
    }
    throw e;
  }
  const action = typeof body?.action === 'string' ? body.action : 'refresh';

  try {
    await ensureSchema();
    if (action === 'disable') {
      const url = typeof body?.url === 'string' ? body.url : '';
      if (!url) {
        return NextResponse.json({ error: 'missing url' }, { status: 400 });
      }
      const error = typeof body?.error === 'string' ? body.error : '';
      const updated = await disableShuyuanSource(url, error);
      return NextResponse.json({ disabled: updated });
    }
    if (action !== 'refresh') {
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
    const stats = await refreshShuyuan();
    return NextResponse.json(stats);
  } catch (e) {
    const message = e instanceof Error ? e.message : '刷新失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
