import type { NextRequest } from 'next/server';
import { guardOwnerRead, guardOwnerWrite } from '@/lib/admin-http';
import { authError, authJson } from '@/lib/auth-http';
import {
  MAX_MODEL_NAME_LENGTH,
  clearLabelModelSetting,
  isValidModelName,
  readLabelModelSetting,
  writeLabelModelSetting,
} from '@/lib/app-settings';
import { readJsonBody, RequestBodyError } from '@/lib/http';

const MAX_BODY_BYTES = 2 * 1024;
const UNAVAILABLE = '打标模型设置暂时不可用，请稍后重试。';

// 打标模型：只存名字。labeler.py 跑在 phoenix 上、走的是另一条上游地址，Web 侧既无法
// 探测也不该知道密钥/地址，所以这里不做保存前验证，只做名字格式校验。留空 = 让打标机
// 用它自己的 .env（向后兼容的缺省路径）。
export async function GET(req: NextRequest) {
  const guard = await guardOwnerRead(req);
  if (!guard.ok) return guard.response;
  try {
    return authJson(await readLabelModelSetting());
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', UNAVAILABLE);
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await guardOwnerWrite(req);
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return authError(413, error.code, error.message);
    throw error;
  }
  const raw = body?.model;
  if (raw !== null && !isValidModelName(raw)) {
    return authError(
      400,
      'INVALID_MODEL',
      `模型名必须是非空字符串、长度不超过 ${MAX_MODEL_NAME_LENGTH}，且只含字母数字与 . _ - /`,
    );
  }

  try {
    if (raw === null) {
      await clearLabelModelSetting();
      return authJson({ model: null, updatedAt: null });
    }
    const updatedAt = await writeLabelModelSetting(raw);
    return authJson({ model: raw, updatedAt });
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', UNAVAILABLE);
  }
}
