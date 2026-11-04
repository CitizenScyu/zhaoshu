import type { NextRequest } from 'next/server';
import { guardOwnerWrite } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { asImporterSql } from '@/lib/importer-enqueue';
import { DEMOTE_MAX_IDS, demotePreviewTasks } from '@/lib/download-requeue';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

const MAX_BODY_BYTES = 16 * 1024;

// 试读本下架（demote1104）：owner 专用；默认 dryRun 只统计，显式 dryRun:false 才改状态。
// restore:true 反向恢复。语义见 download-requeue.ts demotePreviewTasks。
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
  const taskIds = body?.taskIds;
  if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > DEMOTE_MAX_IDS
    || !taskIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return authError(400, 'INVALID_TASK_IDS', `taskIds 须为 1-${DEMOTE_MAX_IDS} 个正整数`);
  }
  try {
    await ensureSchema();
    return authJson(await demotePreviewTasks(asImporterSql(getSql()), {
      taskIds: taskIds as number[],
      dryRun: body?.dryRun !== false,
      restore: body?.restore === true,
    }));
  } catch (error) {
    console.error('download demote failed', error instanceof Error ? { message: error.message } : error);
    return authError(503, 'DEMOTE_UNAVAILABLE', '下架暂不可用，请稍后重试。');
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
