import { NextRequest } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { authError, authJson, withAuthHeaders } from '@/lib/auth-http';
import {
  clearModelSetting,
  isValidModelName,
  MAX_MODEL_NAME_LENGTH,
  modelSettingsPayload,
  readModelSetting,
  writeModelSetting,
} from '@/lib/app-settings';
import { verifySameOriginWrite } from '@/lib/csrf';
import { ensureSchema } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import { probeModel, resetModelCache } from '@/lib/llm';

// owner 切换 LLM 模型：GET 看当前值与来源，PATCH 保存（保存前先用新模型发一次极小请求验证）。
// 只处理模型名：LLM_BASE_URL / LLM_API_KEY 永远留在环境变量里，这里不读、不写、不返回。
// 探针最长 30s（MODEL_PROBE_TIMEOUT_MS）+ 读库/写库余量，60s 足够；改探针超时必须同步
// 检查这里的前台预算，探测失败被平台砍掉 60s 会让 owner 看到没有任何原因的失败。
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;
const SETTINGS_UNAVAILABLE = '模型设置暂时不可用，请稍后重试。';

export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if (!auth.ok) return withAuthHeaders(auth.response);
  try {
    await ensureSchema();
    // GET 不发探测请求（那是 PATCH 保存前验证的职责），所以这里不知道是不是推理模型。
    return authJson(modelSettingsPayload(await readModelSetting()));
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireOwner(req);
  if (!auth.ok) return withAuthHeaders(auth.response);
  // 浏览器写请求（会话身份，或带 Origin）额外要求固定 CSRF 头与同源 Origin；
  // 显式 owner 头的脚本通道保持既有的零 Cookie 语义（与 personal-request 一致）。
  if (auth.principal.authMethod === 'session' || req.headers.has('origin')) {
    const csrf = verifySameOriginWrite(req);
    if (csrf) return withAuthHeaders(csrf);
  }

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return authError(413, error.code, error.message);
    throw error;
  }
  const raw = body?.model;

  // 先确保表存在：验证通过后才发现写不进去，会白白花一次上游探测。
  try {
    await ensureSchema();
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }

  // 恢复默认：清空数据库覆盖值，回退到环境变量/缺省。这条路径不做保存前验证——
  // owner 必须总能回到已知可用的配置，恢复动作本身不能被一个坏模型挡住。
  if (raw === null) {
    try {
      await clearModelSetting();
    } catch {
      return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
    }
    resetModelCache();
    return authJson(modelSettingsPayload({ model: null, updatedAt: null }));
  }

  if (!isValidModelName(raw)) {
    return authError(
      400,
      'INVALID_MODEL',
      `模型名必须是非空字符串、长度不超过 ${MAX_MODEL_NAME_LENGTH}，且只含字母数字与 . _ - /`,
    );
  }

  // 保存前验证：不通过就绝不写库，错误原因可读但不含上游正文。
  const probe = await probeModel(raw);
  if (!probe.ok) return authError(502, 'MODEL_PROBE_FAILED', probe.reason);

  let updatedAt: string | null;
  try {
    updatedAt = await writeModelSetting(raw);
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }
  resetModelCache();
  return authJson({
    ...modelSettingsPayload({ model: raw, updatedAt }, probe.reasoning),
    ...(probe.warning ? { warning: probe.warning } : {}),
  });
}
