import { NextRequest, NextResponse } from 'next/server';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { hasPermission } from '@/lib/permissions';
import { personalExportQueries } from '@/lib/user-data';
import { ensureSchema, getSql } from '@/lib/db';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

export const maxDuration = 60;

async function handleGET(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
  const { userId } = access.principal;

  try {
    await access.run(ensureSchema);
    const sql = getSql();
    // 同一份只读快照保留 books 外键关联；书库只导出元数据，避免 labels 撑大文件。
    const [profiles, books, recommendations, feedback, labeledBooks] = await access.run(() => sql.transaction(
      personalExportQueries(sql, userId),
      { isolationLevel: 'RepeatableRead', readOnly: true, arrayMode: false, fullResults: false, fetchOptions: { signal: access.signal } },
    ));
    const exportedAt = new Date().toISOString();
    const profile = profiles[0] ?? null;

    return new NextResponse(JSON.stringify({
      formatVersion: 2,
      subject: { userId },
      sections: { personal: ['profile', 'seeds', 'books', 'recommendations', 'feedback'], shared: ['labeled_books'] },
      download: null,
      downloadState: hasPermission(access.principal, 'download') ? 'not_ready' : 'forbidden',
      exportedAt,
      profile,
      seeds: profile?.seeds ?? [],
      books,
      recommendations,
      feedback,
      labeled_books: labeledBooks,
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="shujing-data-${exportedAt.slice(0, 10)}.json"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    if (personalError(e).status !== 500) throw e;
    console.error('data export failed');
    return NextResponse.json({ error: '数据导出失败，请稍后重试' }, { status: 500 });
  }
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
