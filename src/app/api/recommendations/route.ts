import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess } from '@/lib/personal-request';
import { hasPermission } from '@/lib/permissions';
import { recommendationsForUserQuery } from '@/lib/user-data';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    const { userId } = access.principal;
    await access.run(ensureSchema);
    const sql = getSql();
    const rows = await access.run(async () => recommendationsForUserQuery(sql, userId, hasPermission(access.principal, 'read'))) as Record<string, unknown>[];
    const recommendations = [...rows].sort((a, b) =>
      new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
    return NextResponse.json({ recommendations });
  });
}
