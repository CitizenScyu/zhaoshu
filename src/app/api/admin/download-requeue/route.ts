import type { NextRequest } from 'next/server';
import { guardOwnerWrite } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { asImporterSql } from '@/lib/importer-enqueue';
import {
  isValidRequeueRevision, REQUEUE_MAX_LIMIT, REQUEUE_REASONS, requeueUnfinishedBooks,
} from '@/lib/download-requeue';
import { boundedPositiveInteger, readJsonBody, RequestBodyError } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

const MAX_BODY_BYTES = 2 * 1024;
const REASONS = new Set<string>([...REQUEUE_REASONS, 'other']);

// 终态未完成书的有界重排（requeue1104）：owner 专用；默认 dryRun 只看统计，
// 显式 dryRun:false 才插任务。缺章书仍不会发布，见 download-requeue.ts。
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
  const sourceRevision = body?.sourceRevision;
  if (!isValidRequeueRevision(sourceRevision)) {
    return authError(400, 'INVALID_REVISION', 'sourceRevision 须为 3-64 位小写字母数字与 . _ -');
  }
  const limit = body?.limit === undefined ? 100 : boundedPositiveInteger(body.limit, REQUEUE_MAX_LIMIT);
  if (limit === null) return authError(400, 'INVALID_LIMIT', `limit 须为 1-${REQUEUE_MAX_LIMIT} 的整数`);
  const reasons = body?.reasons ?? [];
  if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string' && REASONS.has(reason))) {
    return authError(400, 'INVALID_REASONS', `reasons 只能取 ${[...REASONS].join(', ')}`);
  }
  try {
    await ensureSchema();
    return authJson(await requeueUnfinishedBooks(asImporterSql(getSql()), {
      sourceRevision, limit, reasons,
      dryRun: body?.dryRun !== false,
      includePaywall: body?.includePaywall === true,
    }));
  } catch (error) {
    console.error('download requeue failed', error instanceof Error ? { message: error.message } : error);
    return authError(503, 'REQUEUE_UNAVAILABLE', '重排暂不可用，请稍后重试。');
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
