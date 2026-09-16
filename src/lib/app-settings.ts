import { getSql } from './db';

// 应用级配置表（app_settings，单行 id=1），由 business-schema 的运行时 DDL 建立。
// 模型配置是应用配置、不是认证数据：这里绝不参与 auth-store 的 AUTH_SCHEMA_VERSION
// 版本闸门（闸门不匹配会全站 503），也不需要迁移脚本。

export const DEFAULT_LLM_MODEL = 'claude-opus-5-88';
export const MAX_MODEL_NAME_LENGTH = 200;
// 保守字符集：字母数字与 . _ - /（渠道常见形如 vendor/model、claude-opus-5-88）。
// 空白、控制字符或其他标点一律拒绝，避免把任意内容带进上游请求体。
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export type LlmModelSource = 'database' | 'environment' | 'default';

// 「是不是推理模型」的判定值。**必须是三态**：一次小探测能证明「是」（真的观测到思维链），
// 却证明不了「不是」（短提示词本来就不一定触发思维链，2026-09-17 实测旧判据对
// claude-opus-5-88 报过 false）。'no' 只在将来有「这次探测确实有能力区分」的论证时才可以用，
// 当前没有任何生产者会返回它；探测结果只能是 'yes' 或 'unknown'。
export type ReasoningVerdict = 'yes' | 'no' | 'unknown';

// PATCH 在「判为推理模型、但请求体没带确认标志」时用的错误码。放在这里是因为接口与前端
// 必须用同一个字面量：写在两边各一份，改一处就会让确认块静默失效、退回成普通报错。
export const REASONING_CONFIRMATION_CODE = 'REASONING_MODEL_REQUIRES_CONFIRMATION';

export interface LlmModelSettings {
  model: string;
  /** 「恢复默认」会回到的模型（环境变量或硬编码缺省）。 */
  defaultModel: string;
  source: LlmModelSource;
  /** 数据库覆盖值的写入时间；没有覆盖时为 null。 */
  updatedAt: string | null;
  /** 保存前验证的推理判定；GET 不做探测，固定为 null（未知）。见 ReasoningVerdict。 */
  reasoning: ReasoningVerdict | null;
}

export function isValidModelName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_MODEL_NAME_LENGTH
    && MODEL_NAME_PATTERN.test(value);
}

// 环境变量是既有的运维配置通道，语义保持原样（非空即用），不在运行时解析里改变它的判定；
// 数据库覆盖值则必须通过校验，避免脏值绕过接口层的检查。
export function environmentModel(): { model: string; source: 'environment' | 'default' } {
  const fromEnv = process.env.LLM_MODEL;
  return fromEnv ? { model: fromEnv, source: 'environment' } : { model: DEFAULT_LLM_MODEL, source: 'default' };
}

export interface StoredModelSetting {
  model: string | null;
  updatedAt: string | null;
  /** 上次保存前验证观测到的推理结论；GET 与刷新后的页面靠它显示告警。 */
  reasoning: ReasoningVerdict | null;
}

// timestamptz 实际取值可能是字符串或 Date，两种都收敛成 ISO 字符串。
function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// 库里的判定值只可能是 PATCH 写入的这三种字面量；脏值一律当「未知」，
// 不能让一个手写进库的字符串直达前端（前端按 ReasoningVerdict 渲染）。
function storedVerdict(value: unknown): ReasoningVerdict | null {
  return value === 'yes' || value === 'no' || value === 'unknown' ? value : null;
}

export async function readModelSetting(): Promise<StoredModelSetting> {
  const sql = getSql();
  const rows = await sql`
    SELECT llm_model, llm_reasoning, updated_at FROM app_settings WHERE id = 1
  ` as { llm_model: string | null; llm_reasoning: string | null; updated_at: unknown }[];
  const row = rows[0];
  // 库里的值只可能由 PATCH 写入；不合法就当没有覆盖，回退到环境变量/缺省。
  // 判定值随之一起作废：它描述的是那个被忽略的模型名，留着就是张冠李戴。
  if (!row || !isValidModelName(row.llm_model)) return { model: null, updatedAt: null, reasoning: null };
  return {
    model: row.llm_model,
    updatedAt: isoTimestamp(row.updated_at),
    reasoning: storedVerdict(row.llm_reasoning),
  };
}

export async function writeModelSetting(
  model: string,
  reasoning: ReasoningVerdict | null,
): Promise<string | null> {
  if (!isValidModelName(model)) throw new Error('invalid model name');
  const sql = getSql();
  const rows = await sql`
    INSERT INTO app_settings (id, llm_model, llm_reasoning, updated_at) VALUES (1, ${model}, ${reasoning}, now())
    ON CONFLICT (id) DO UPDATE SET llm_model = EXCLUDED.llm_model,
      llm_reasoning = EXCLUDED.llm_reasoning, updated_at = now()
    RETURNING updated_at` as { updated_at: unknown }[];
  return isoTimestamp(rows[0]?.updated_at);
}

/** 恢复默认：清空数据库覆盖值，运行时解析回退到环境变量/缺省。 */
export async function clearModelSetting(): Promise<void> {
  const sql = getSql();
  await sql`UPDATE app_settings SET llm_model = NULL, llm_reasoning = NULL, updated_at = now() WHERE id = 1`;
}

/** GET 的响应体：数据库覆盖值优先，否则报告环境变量/缺省来源。 */
export function modelSettingsPayload(stored: StoredModelSetting): LlmModelSettings {
  const fallback = environmentModel();
  if (stored.model) {
    return {
      model: stored.model,
      defaultModel: fallback.model,
      source: 'database',
      updatedAt: stored.updatedAt,
      reasoning: stored.reasoning,
    };
  }
  return {
    model: fallback.model,
    defaultModel: fallback.model,
    source: fallback.source,
    updatedAt: null,
    // 没有覆盖值时，库里残留的判定（正常情况下已被 clearModelSetting 清掉）不属于当前模型，
    // 不能拿它给环境变量里的模型下结论。
    reasoning: null,
  };
}
