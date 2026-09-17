import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { clearNewShelfForUserQuery } from '@/lib/user-data';

// 书架「未处理」堆的批量清理。独立成端点而不是挂在 DELETE /api/shelf?id= 上：
// 那条按 id 删单条，语义与授权面都很窄；同一个方法上再开一条「按状态批量删」会
// 让"这次调用到底删了什么"取决于查询参数，权限与审计都说不清（task-65）。
// 鉴权链路与 /api/shelf 完全一致：withFindAccess + 从 principal 取 userId，
// CSRF 由 PersonalRequest.authorize 对非 GET/HEAD/OPTIONS 统一校验。
export const maxDuration = 60;

export async function DELETE(req: NextRequest) {
  return withFindAccess(req, 55_000, async (access) => {
    const { userId } = access.principal;
    try {
      await access.run(ensureSchema);
      // 只删行，不动 books 与 feedback：被清掉的行是 find 自动落库、用户尚未处理的
      // 推荐；一本书若还有非 new 行（用户已表态过），它的书架卡仍在，只是回到真实分组。
      const rows = await access.commit((write) => write((sql) => [clearNewShelfForUserQuery(sql, userId)]));
      // 没有可清理的行时返回 200 与 cleared=0，而不是 404：这是幂等清理，
      // 两个用户同时点、或用户点了两次，第二次不该被当成错误。
      return NextResponse.json({ ok: true, cleared: rows[0].length });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}
