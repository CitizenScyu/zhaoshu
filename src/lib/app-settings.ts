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

export interface LlmModelSettings {
  model: string;
  /** 「恢复默认」会回到的模型（环境变量或硬编码缺省）。 */
  defaultModel: string;
  source: LlmModelSource;
  /** 数据库覆盖值的写入时间；没有覆盖时为 null。 */
  updatedAt: string | null;
  /** 是否推理模型：只有 PATCH 的保存前验证能给出答案，GET 不做探测（null 表示未知）。 */
  reasoning: boolean | null;
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
}

// timestamptz 实际取值可能是字符串或 Date，两种都收敛成 ISO 字符串。
function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function readModelSetting(): Promise<StoredModelSetting> {
  const sql = getSql();
  const rows = await sql`
    SELECT llm_model, updated_at FROM app_settings WHERE id = 1
  ` as { llm_model: string | null; updated_at: unknown }[];
  const row = rows[0];
  // 库里的值只可能由 PATCH 写入；不合法就当没有覆盖，回退到环境变量/缺省。
  if (!row || !isValidModelName(row.llm_model)) return { model: null, updatedAt: null };
  return { model: row.llm_model, updatedAt: isoTimestamp(row.updated_at) };
}

export async function writeModelSetting(model: string): Promise<string | null> {
  if (!isValidModelName(model)) throw new Error('invalid model name');
  const sql = getSql();
  const rows = await sql`
    INSERT INTO app_settings (id, llm_model, updated_at) VALUES (1, ${model}, now())
    ON CONFLICT (id) DO UPDATE SET llm_model = EXCLUDED.llm_model, updated_at = now()
    RETURNING updated_at` as { updated_at: unknown }[];
  return isoTimestamp(rows[0]?.updated_at);
}

/** 恢复默认：清空数据库覆盖值，运行时解析回退到环境变量/缺省。 */
export async function clearModelSetting(): Promise<void> {
  const sql = getSql();
  await sql`UPDATE app_settings SET llm_model = NULL, updated_at = now() WHERE id = 1`;
}

/** GET 的响应体：数据库覆盖值优先，否则报告环境变量/缺省来源。 */
export function modelSettingsPayload(
  stored: StoredModelSetting,
  reasoning: boolean | null = null,
): LlmModelSettings {
  const fallback = environmentModel();
  if (stored.model) {
    return {
      model: stored.model,
      defaultModel: fallback.model,
      source: 'database',
      updatedAt: stored.updatedAt,
      reasoning,
    };
  }
  return {
    model: fallback.model,
    defaultModel: fallback.model,
    source: fallback.source,
    updatedAt: null,
    reasoning,
  };
}
