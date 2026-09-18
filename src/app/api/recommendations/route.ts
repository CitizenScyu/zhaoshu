import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess } from '@/lib/personal-request';
import { hasPermission } from '@/lib/permissions';
import { recommendationsForUserQuery } from '@/lib/user-data';

export const maxDuration = 60;

// 分页上限与 shelf-view 的 SHELF_ROW_LIMIT 一致（默认 300）。offset 允许 0。
const MAX_SHELF_LIMIT = 300;
const MAX_SHELF_OFFSET = 1_000_000;

// 只接受 10 进制整数字面量：'1.0' / '0x10' / '' / 'Infinity' 都判非法（与 boundedPositiveInteger 同风格）。
function boundedIntegerParam(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export async function GET(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    const { userId } = access.principal;
    // F06：搜索移服务端（?q= 过滤 title/author），并支持分页（?limit=&offset=）。
    // 缺省保持既有行为：本用户最新 300 本。
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get('q') || '').trim().slice(0, 100);
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');
    const limit = limitParam === null ? undefined : boundedIntegerParam(limitParam, 1, MAX_SHELF_LIMIT);
    const offset = offsetParam === null ? undefined : boundedIntegerParam(offsetParam, 0, MAX_SHELF_OFFSET);
    if (limitParam !== null && limit === null) {
      return NextResponse.json({ error: `limit must be an integer from 1 to ${MAX_SHELF_LIMIT}`, code: 'INVALID_LIMIT' }, { status: 400 });
    }
    if (offsetParam !== null && offset === null) {
      return NextResponse.json({ error: 'offset must be an integer >= 0', code: 'INVALID_OFFSET' }, { status: 400 });
    }
    await access.run(ensureSchema);
    const sql = getSql();
    const rows = await access.run(async () => recommendationsForUserQuery(
      sql, userId, hasPermission(access.principal, 'read'),
      { q, ...(limit !== undefined && limit !== null ? { limit } : {}), ...(offset !== undefined && offset !== null ? { offset } : {}) },
    )) as Record<string, unknown>[];
    const recommendations = [...rows].sort((a, b) =>
      new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
    return NextResponse.json({ recommendations });
  });
}
