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
  /**
   * 「恢复默认」会回到的模型，也就是 llm_model 没有覆盖值时的生效值。
   * 解析顺序：库内 default_model → 环境变量 LLM_MODEL → 硬编码 DEFAULT_LLM_MODEL。
   */
  defaultModel: string;
  /** 当前生效模型（model）的来源。数据库覆盖 → 库内默认值 → 环境变量 → 硬编码缺省。 */
  source: LlmModelSource;
  /** 默认值（defaultModel）自己的来源，与 source 相互独立（见 resolveDefaultModel）。 */
  defaultSource: LlmModelSource;
  /** llm_model 覆盖值的写入时间；没有覆盖时为 null。 */
  updatedAt: string | null;
  /** default_model 覆盖值的写入时间；没有覆盖时为 null。 */
  defaultUpdatedAt: string | null;
  /** 当前生效模型的推理判定；来源不是数据库时为 null（环境变量里的模型从没探测过）。 */
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
  /** llm_model 覆盖值：当前模型的覆盖。 */
  model: string | null;
  updatedAt: string | null;
  /** 上次保存 llm_model 前验证观测到的推理结论。 */
  reasoning: ReasoningVerdict | null;
  /** default_model 覆盖值：llm_model 没有覆盖值时用的那个模型。 */
  defaultModel: string | null;
  defaultModelUpdatedAt: string | null;
  /** 上次保存 default_model 前验证观测到的推理结论（默认值真的生效时才会被报告）。 */
  defaultReasoning: ReasoningVerdict | null;
}

/** 一行都没读到时的空设置：全部回落到环境变量/硬编码缺省。 */
export function emptyModelSetting(): StoredModelSetting {
  return {
    model: null, updatedAt: null, reasoning: null,
    defaultModel: null, defaultModelUpdatedAt: null, defaultReasoning: null,
  };
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
    SELECT llm_model, llm_reasoning, updated_at,
      default_model, default_model_reasoning, default_model_updated_at
    FROM app_settings WHERE id = 1
  ` as {
    llm_model: string | null; llm_reasoning: string | null; updated_at: unknown;
    default_model: string | null; default_model_reasoning: string | null; default_model_updated_at: unknown;
  }[];
  const row = rows[0];
  if (!row) return emptyModelSetting();
  // 库里的值只可能由 PATCH 写入；不合法就当没有覆盖，回退到下一层。
  // 判定值与时间戳随之一起作废：它们描述的是那个被忽略的模型名，留着就是张冠李戴。
  // 两组（llm_model / default_model）各自独立判定：一组脏了不影响另一组。
  const current = isValidModelName(row.llm_model)
    ? {
      model: row.llm_model,
      updatedAt: isoTimestamp(row.updated_at),
      reasoning: storedVerdict(row.llm_reasoning),
    }
    : { model: null, updatedAt: null, reasoning: null };
  const fallback = isValidModelName(row.default_model)
    ? {
      defaultModel: row.default_model,
      defaultModelUpdatedAt: isoTimestamp(row.default_model_updated_at),
      defaultReasoning: storedVerdict(row.default_model_reasoning),
    }
    : { defaultModel: null, defaultModelUpdatedAt: null, defaultReasoning: null };
  return { ...current, ...fallback };
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

/**
 * 「恢复默认」：清空 llm_model 覆盖值，运行时解析回退到 default_model →
 * 环境变量/硬编码缺省。**只动 llm_model 那三列**——库内默认值是另一件事，不能被这一步顺带清掉。
 */
export async function clearModelSetting(): Promise<void> {
  const sql = getSql();
  await sql`UPDATE app_settings SET llm_model = NULL, llm_reasoning = NULL, updated_at = now() WHERE id = 1`;
}

// ---- 默认模型（llm_model 没有覆盖值时用的那个）----
// 语义：model（当前覆盖）→ default_model（库内默认）→ 环境变量 LLM_MODEL → 硬编码缺省。
// 独立三列，避免改默认值弄脏 llm_model 的「当前值 / 判定 / 更新时间」。
export async function writeDefaultModelSetting(
  model: string,
  reasoning: ReasoningVerdict | null,
): Promise<string | null> {
  if (!isValidModelName(model)) throw new Error('invalid model name');
  const sql = getSql();
  const rows = await sql`
    INSERT INTO app_settings (id, default_model, default_model_reasoning, default_model_updated_at)
    VALUES (1, ${model}, ${reasoning}, now())
    ON CONFLICT (id) DO UPDATE SET default_model = EXCLUDED.default_model,
      default_model_reasoning = EXCLUDED.default_model_reasoning,
      default_model_updated_at = now()
    RETURNING default_model_updated_at` as { default_model_updated_at: unknown }[];
  return isoTimestamp(rows[0]?.default_model_updated_at);
}

/**
 * 清除库内默认值，运行时解析回退到环境变量/硬编码缺省。
 * 时间戳一并置 NULL（照 label_model 的模式）：清除之后「没有覆盖值」这件事本身
 * 不该带着一个看起来像写入时间的残留值。**不碰 llm_model 那三列。**
 */
export async function clearDefaultModelSetting(): Promise<void> {
  const sql = getSql();
  await sql`UPDATE app_settings SET default_model = NULL, default_model_reasoning = NULL, default_model_updated_at = NULL WHERE id = 1`;
}

export interface ResolvedDefaultModel {
  model: string;
  source: LlmModelSource;
  /** 库内覆盖的写入时间；来源不是数据库时为 null。 */
  updatedAt: string | null;
}

/**
 * 默认值解析链：库内 default_model → 环境变量 LLM_MODEL → 硬编码 DEFAULT_LLM_MODEL。
 * 抽成独立函数（而不是散在 payload 里）是因为它同时决定「默认值是什么」和「默认值从哪来」，
 * 两个答案必须来自同一次判定，否则会出现「值来自库、来源写着环境变量」这种自相矛盾的响应。
 */
export function resolveDefaultModel(stored: StoredModelSetting): ResolvedDefaultModel {
  if (stored.defaultModel) {
    return { model: stored.defaultModel, source: 'database', updatedAt: stored.defaultModelUpdatedAt };
  }
  const fallback = environmentModel();
  return { model: fallback.model, source: fallback.source, updatedAt: null };
}

// ---- 打标模型（labeler.py 离线跑在 phoenix 上，Web 只存名字）----
// 打标机用的是另一个上游地址（labeler.py 里的 LLM_URL），Web 侧无法探测，因此这里
// 只做名字格式校验，不做保存前验证，也不读、不返回任何密钥或地址。留空表示「由打标机
// 自己的 .env 决定」，这是缺省且向后兼容的路径。
export interface LabelModelSetting {
  /** 数据库覆盖值；null 表示未设置，打标机回落到它的 .env。 */
  model: string | null;
  updatedAt: string | null;
}

export async function readLabelModelSetting(): Promise<LabelModelSetting> {
  const sql = getSql();
  const rows = await sql`
    SELECT label_model, label_model_updated_at FROM app_settings WHERE id = 1
  ` as { label_model: string | null; label_model_updated_at: unknown }[];
  const row = rows[0];
  if (!row || !isValidModelName(row.label_model)) return { model: null, updatedAt: null };
  return { model: row.label_model, updatedAt: isoTimestamp(row.label_model_updated_at) };
}

export async function writeLabelModelSetting(model: string): Promise<string | null> {
  if (!isValidModelName(model)) throw new Error('invalid model name');
  const sql = getSql();
  const rows = await sql`
    INSERT INTO app_settings (id, label_model, label_model_updated_at) VALUES (1, ${model}, now())
    ON CONFLICT (id) DO UPDATE SET label_model = EXCLUDED.label_model,
      label_model_updated_at = now()
    RETURNING label_model_updated_at` as { label_model_updated_at: unknown }[];
  return isoTimestamp(rows[0]?.label_model_updated_at);
}

export async function clearLabelModelSetting(): Promise<void> {
  const sql = getSql();
  await sql`UPDATE app_settings SET label_model = NULL, label_model_updated_at = NULL WHERE id = 1`;
}

/**
 * GET/PATCH 的响应体。解析顺序：llm_model 覆盖 → default_model（库内默认）→ 环境变量 → 硬编码缺省。
 *
 * source 与 defaultSource 是**两件事**，别混：
 *   - source：当前生效模型（model）的来源。库内覆盖存在时是 'database'；否则等于
 *     defaultSource——没有覆盖值时，「当前值」就是那个默认值，来源自然也是默认值的来源。
 *   - defaultSource：默认值（defaultModel）自己的来源。
 * 所以 source === 'database' 有两种成因（有 llm_model 覆盖 / 默认值来自库），
 * 需要区分时看 updatedAt 是否为 null（只有 llm_model 覆盖才会写它，见 readModelSetting）。
 *
 * reasoning 描述的是**当前生效模型**：覆盖值用 llm_model 的判定，默认值生效时用默认值的判定，
 * 环境变量里的模型从没探测过 → null。绝不能拿一个不生效的判定给另一个模型下结论。
 */
export function modelSettingsPayload(stored: StoredModelSetting): LlmModelSettings {
  const fallback = resolveDefaultModel(stored);
  const override = stored.model;
  // 只有「库内默认值真的生效」时，default_model 的判定才配得上当前模型。
  const reasoning = override !== null
    ? stored.reasoning
    : (fallback.source === 'database' ? stored.defaultReasoning : null);
  return {
    model: override ?? fallback.model,
    defaultModel: fallback.model,
    source: override !== null ? 'database' : fallback.source,
    defaultSource: fallback.source,
    updatedAt: override !== null ? stored.updatedAt : null,
    defaultUpdatedAt: fallback.updatedAt,
    reasoning,
  };
}
