import { NextRequest } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { authError, authJson, withAuthHeaders } from '@/lib/auth-http';
import {
  clearDefaultModelSetting,
  clearModelSetting,
  isValidModelName,
  MAX_MODEL_NAME_LENGTH,
  modelSettingsPayload,
  readModelSetting,
  REASONING_CONFIRMATION_CODE,
  writeDefaultModelSetting,
  writeModelSetting,
} from '@/lib/app-settings';
import type { LlmModelSettings, StoredModelSetting } from '@/lib/app-settings';
import { verifySameOriginWrite } from '@/lib/csrf';
import { ensureSchema } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';
import { probeModel, resetModelCache } from '@/lib/llm';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// owner 切换 LLM 模型：GET 看当前值与来源，PATCH 保存（保存前先用新模型发一次极小请求验证）。
//
// PATCH 有两个互斥的目标字段（一次只改一个，语义见下面 PATCH 里的说明）：
//   - model：当前生效的覆盖值。null = 清除覆盖，回退到默认值。**既有调用形态，语义不变。**
//   - defaultModel：默认值本身（llm_model 没有覆盖值时用的那个）。null = 清除，回退到环境变量。
// 只处理模型名：LLM_BASE_URL / LLM_API_KEY 永远留在环境变量里，这里不读、不写、不返回。
// 探针最长 30s（MODEL_PROBE_TIMEOUT_MS），冷连接重试也在同一个 30s 截止时间内，不会翻倍；
// 加上读库/写库余量，60s 足够。改探针超时必须同步检查这里的前台预算，探测失败被平台砍掉
// 60s 会让 owner 看到没有任何原因的失败。
// ⚠️ 正因为预算是 60s，两个目标**不能**在同一个请求里各探测一次（30+30 会顶破 maxDuration），
// 所以同时带上 model 与 defaultModel 时直接 400，而不是挑一个执行。
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;
const SETTINGS_UNAVAILABLE = '模型设置暂时不可用，请稍后重试。';

// 判为推理模型时**不直接写库**，要求请求体显式带上确认标志。理由：推理模型本身是可接受的
// （现役 claude-opus-5-88 就是，本轮把 LLM_MAX_TOKENS 提到 16000 也是为了让它能用），
// 真正的危害是 owner 在不知道后果的情况下保存它——思维链与正文共享 max_tokens，找书会明显
// 变慢、预算不足时正文会空，正是 2026-09-16 那次故障的形态。要消除的是「静默」，不是模型。
// 这条只在探测真的观测到思维链（reasoning === 'yes'）时才拦；观测不到不拦，也不假装知道。
// 错误码本身定义在 app-settings（前端要用同一个字面量），这里只放文案。
const REASONING_CONFIRMATION_MESSAGE =
  '该模型会输出思维链（推理模型）：思维链与正文共享 max_tokens，会让每次找书显著变慢，'
  + '预算不足时正文还会为空。确认要切换到它，请在同一请求体里带 acknowledgeReasoning: true 重试；'
  + '「恢复默认」不受此限制。';

async function handleGET(req: NextRequest) {
  const auth = await requireOwner(req);
  if (!auth.ok) return withAuthHeaders(auth.response);
  try {
    await ensureSchema();
    // GET 不发探测请求，所以「是不是推理模型」只能报上次保存时落库的那条判定；
    // 从没保存过（或判定在写入前就丢了）时为 null，表示未知，不是「不是」。
    return authJson(modelSettingsPayload(await readModelSetting()));
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }
}

async function handlePATCH(req: NextRequest) {
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
  // 只接受真正的布尔；写成字符串 "true" 会被当成没确认，而那看起来像「我明明带了标志」。
  const acknowledgeReasoning = body?.acknowledgeReasoning;
  if (acknowledgeReasoning !== undefined && typeof acknowledgeReasoning !== 'boolean') {
    return authError(400, 'INVALID_CONFIRMATION', 'acknowledgeReasoning 只能是布尔值 true。');
  }

  // 用 hasOwnProperty 而不是 `=== undefined`：{ model: undefined } 与 {} 都算「没带这个字段」，
  // 而 JSON 里显式的 null 必须被读到（它就是「清除覆盖」这个动作本身）。
  const hasModel = hasOwn(body, 'model');
  const hasDefaultModel = hasOwn(body, 'defaultModel');
  if (hasModel && hasDefaultModel) {
    return authError(400, 'AMBIGUOUS_TARGET', '一次只能改一个：请求体里不要同时带 model 与 defaultModel。');
  }
  if (!hasModel && !hasDefaultModel) {
    return authError(400, 'INVALID_MODEL', MODEL_NAME_REQUIREMENT);
  }

  // 纯格式校验放在碰数据库之前：非法名字不该读库、更不该发探测（与加 defaultModel 之前一致）。
  // null 是「清除」动作，没有名字可校验，直接放行到下面的清除分支。
  const candidate = hasDefaultModel ? body?.defaultModel : body?.model;
  if (candidate !== null && !isValidModelName(candidate)) {
    return authError(400, 'INVALID_MODEL', MODEL_NAME_REQUIREMENT);
  }
  const name = candidate as string | null;

  // 写之前先读一次：写成功后的响应体要如实反映**另一列**的现状（改默认值不能把当前生效模型
  // 说成默认值，反之亦然）。先读再写也保证读失败时一个字节都没写——不会出现「写成功了却报 503」。
  let stored: StoredModelSetting;
  try {
    await ensureSchema();
    stored = await readModelSetting();
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }

  return hasDefaultModel
    ? saveDefaultModel(name, acknowledgeReasoning, stored)
    : saveModel(name, acknowledgeReasoning, stored);
}

function hasOwn(body: Record<string, unknown> | null, key: string): boolean {
  return body !== null && Object.prototype.hasOwnProperty.call(body, key);
}

const MODEL_NAME_REQUIREMENT =
  `模型名必须是非空字符串、长度不超过 ${MAX_MODEL_NAME_LENGTH}，且只含字母数字与 . _ - /`;

// 保存「当前模型」覆盖值（既有路径，语义与加 defaultModel 之前逐字一致）。
async function saveModel(
  name: string | null,
  acknowledgeReasoning: unknown,
  stored: StoredModelSetting,
) {
  // 恢复默认：清空 llm_model 覆盖值，回退到库内默认值/环境变量/缺省。这条路径不做保存前验证——
  // owner 必须总能回到已知可用的配置，恢复动作本身不能被一个坏模型挡住。
  if (name === null) {
    try {
      await clearModelSetting();
    } catch {
      return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
    }
    resetModelCache();
    return authJson(modelSettingsPayload({ ...stored, model: null, updatedAt: null, reasoning: null }));
  }

  // 保存前验证：不通过就绝不写库，错误原因可读但不含上游正文。
  const probe = await probeModel(name);
  if (!probe.ok) return authError(502, 'MODEL_PROBE_FAILED', probe.reason);

  // 判为推理模型时要显式确认（见上面 REASONING_CONFIRMATION_* 的说明）。确认分支不发上游
  // 请求，所以不额外吃 maxDuration；owner 带上标志重试时才会再探测一次。
  if (probe.reasoning === 'yes' && acknowledgeReasoning !== true) {
    return authError(409, REASONING_CONFIRMATION_CODE, REASONING_CONFIRMATION_MESSAGE);
  }

  let updatedAt: string | null;
  try {
    updatedAt = await writeModelSetting(name, probe.reasoning);
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }
  resetModelCache();
  return authJson(withWarning(
    modelSettingsPayload({ ...stored, model: name, updatedAt, reasoning: probe.reasoning }),
    probe.warning,
  ));
}

// 保存「默认值」（llm_model 没有覆盖值时用的那个模型）。与 saveModel 是同一套护栏：
// 探测在前、确认在后、写库最后——默认值一旦生效就是真正在跑的模型，没有理由比当前模型少一道验证。
async function saveDefaultModel(
  name: string | null,
  acknowledgeReasoning: unknown,
  stored: StoredModelSetting,
) {
  // 清除库内默认值 → 回退到环境变量/硬编码缺省。与「恢复默认」同理：不做探测，
  // owner 必须总能退回到一个不依赖这个库的值。
  if (name === null) {
    try {
      await clearDefaultModelSetting();
    } catch {
      return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
    }
    resetModelCache();
    return authJson(modelSettingsPayload({
      ...stored, defaultModel: null, defaultModelUpdatedAt: null, defaultReasoning: null,
    }));
  }

  const probe = await probeModel(name);
  if (!probe.ok) return authError(502, 'MODEL_PROBE_FAILED', probe.reason);
  if (probe.reasoning === 'yes' && acknowledgeReasoning !== true) {
    return authError(409, REASONING_CONFIRMATION_CODE, REASONING_CONFIRMATION_MESSAGE);
  }

  let updatedAt: string | null;
  try {
    updatedAt = await writeDefaultModelSetting(name, probe.reasoning);
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', SETTINGS_UNAVAILABLE);
  }
  resetModelCache();
  return authJson(withWarning(
    modelSettingsPayload({
      ...stored, defaultModel: name, defaultModelUpdatedAt: updatedAt, defaultReasoning: probe.reasoning,
    }),
    probe.warning,
  ));
}

function withWarning(payload: LlmModelSettings, warning: string): LlmModelSettings & { warning?: string } {
  return warning ? { ...payload, warning } : payload;
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
export const PATCH = withDbQuotaGuard(handlePATCH);
