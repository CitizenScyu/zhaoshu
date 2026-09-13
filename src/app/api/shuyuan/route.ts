import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import { disableShuyuanSource, getShuyuanStats, refreshShuyuan } from '@/lib/shuyuan';

// 书源管理：GET 看统计，POST 刷新合集或给失效源打标记
export const maxDuration = 295;

const MAX_BODY_BYTES = 4 * 1024;

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  try {
    await ensureSchema();
    return NextResponse.json(await getShuyuanStats());
  } catch {
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
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
