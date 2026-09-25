import type { NextRequest } from 'next/server';
import { guardOwnerRead, guardOwnerWrite } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { getSql } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import {
  DEFAULT_INVITE_TTL_DAYS,
  MAX_INVITE_BATCH,
  MAX_INVITE_TTL_DAYS,
  createInviteCodes,
  listInviteCodes,
} from '@/lib/invite-codes';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

const MAX_BODY_BYTES = 2 * 1024;
const UNAVAILABLE = '邀请码服务暂时不可用，请稍后重试。';

// owner 列出 / 生成邀请码。列表里永远没有原文，只有短提示与状态；原文只在 POST 的响应里
// 出现这一次（设计 §4.3：库中只存 SHA-256 摘要）。
async function handleGET(req: NextRequest) {
  const guard = await guardOwnerRead(req);
  if (!guard.ok) return guard.response;
  try {
    return authJson({ invites: await listInviteCodes(getSql()) });
  } catch {
    return authError(503, 'INVITES_UNAVAILABLE', UNAVAILABLE);
  }
}

async function handlePOST(req: NextRequest) {
  const guard = await guardOwnerWrite(req);
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return authError(413, error.code, error.message);
    throw error;
  }
  const count = body?.count ?? 1;
  // ttlDays 缺省 7 天；显式 null 表示不过期（设计 §4.3 的两种合法写法）。
  const ttlDays = body?.ttlDays === undefined ? DEFAULT_INVITE_TTL_DAYS : body.ttlDays;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_INVITE_BATCH) {
    return authError(400, 'INVALID_COUNT', `一次最多生成 ${MAX_INVITE_BATCH} 个邀请码`);
  }
  if (ttlDays !== null && (!Number.isInteger(ttlDays) || (ttlDays as number) < 1 || (ttlDays as number) > MAX_INVITE_TTL_DAYS)) {
    return authError(400, 'INVALID_TTL', `有效期只能是 1-${MAX_INVITE_TTL_DAYS} 天，或 null 表示不过期`);
  }

  try {
    const invites = await createInviteCodes(getSql(), count as number, ttlDays as number | null, guard.principal.userId);
    return authJson({
      invites,
      notice: '邀请码原文只显示这一次，请立即复制；库中只存摘要，遗失只能作废重建。',
    }, { status: 201 });
  } catch {
    return authError(503, 'INVITES_UNAVAILABLE', UNAVAILABLE);
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
export const POST = withDbQuotaGuard(handlePOST);
