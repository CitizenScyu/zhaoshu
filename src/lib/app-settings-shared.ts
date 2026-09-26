// 客户端与服务端共用的模型设置常量与纯类型（41-q402build）。
//
// 抽出的原因：app-settings.ts 里的读写函数要 import './db'，而 db.ts 经
// db-quota-guard.ts 链到 `node:async_hooks`（服务端专用）。前端组件（ModelSettingsTab）
// 只需要这里的错误码字面量和几个类型，不能因此把整条服务端链拖进客户端 bundle
// （否则 Turbopack 报 "chunking context does not support external modules: node:async_hooks"）。
// 本模块无副作用、不引入 db，客户端与服务端都可安全 import。

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
