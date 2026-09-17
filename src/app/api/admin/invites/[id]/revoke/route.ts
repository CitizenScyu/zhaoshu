import type { NextRequest } from 'next/server';
import { guardOwnerWrite } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { getSql } from '@/lib/db';
import { boundedPositiveInteger } from '@/lib/http';
import { revokeInviteCode } from '@/lib/invite-codes';

const UNAVAILABLE = '邀请码服务暂时不可用，请稍后重试。';

// 作废邀请码：幂等。已使用的码不影响已注册账户，返回 409 让界面说清楚原因，
// 而不是假装作废成功（设计 §4.3：作废只写 revoked_at，不硬删记录）。
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardOwnerWrite(req);
  if (!guard.ok) return guard.response;

  const id = boundedPositiveInteger((await params).id);
  if (id === null) return authError(400, 'INVALID_ID', '邀请码 id 无效');

  let result: Awaited<ReturnType<typeof revokeInviteCode>>;
  try {
    result = await revokeInviteCode(getSql(), id);
  } catch {
    return authError(503, 'INVITES_UNAVAILABLE', UNAVAILABLE);
  }
  if (result === 'not_found') return authError(404, 'INVITE_NOT_FOUND', '邀请码不存在');
  if (result === 'used') return authError(409, 'INVITE_ALREADY_USED', '邀请码已被使用，无法作废；已注册账户不受影响');
  return authJson({ id, status: result });
}
