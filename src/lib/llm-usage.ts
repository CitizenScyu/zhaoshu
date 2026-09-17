import { isRecord } from './sanitize';

export const LLM_USAGE_PHASES = ['find_recall', 'find_rerank', 'profile', 'feedback'] as const;
export type LlmUsagePhase = typeof LLM_USAGE_PHASES[number];

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // 缓存命中是输入 token 的子集，不再加到 totalTokens。
  cacheTokens: number;
  usageMissing: boolean;
  // 保留上游的 total 和各类缓存细分，包括缓存写入量。
  rawUsage: Record<string, unknown> | null;
}

// 一次上游调用的**尝试上下文**：由 chatRobust 在发起前给出，chat 原样带进 usage 回调。
// firstByteTimeouts 记的是「**此前**已经发生过的」首字节超时次数，chat 会把自己这一次也算上
// （见 llm.ts 的 observationFor），所以每一行的值都是「截止本行」的累计数。
export interface LlmAttemptContext {
  /** 这是本次 chatRobust 内的第几次上游调用（从 1 开始）。 */
  attempts: number;
  /** 本次 chatRobust 内到此为止的首字节超时次数。 */
  firstByteTimeouts: number;
  /** 首次尝试失败后原地重发过主模型。 */
  retried: boolean;
  /** 本行是降级到兜底模型的那次调用。 */
  fallbackUsed: boolean;
}

// 落进 llm_usage.usage_details 的观测字段（2026-09-17）。
//
// 为什么需要：失败行的 usage_details 原本恒为 {}，线上分不清失败族，也看不出
// 「首字节超时后原地重发有没有发生、有没有成功」——那正是重试修复赖以验证的东西。
// 🔴 零迁移：usage_details 本来就是 jsonb（见 db.ts 的 DDL），这里只是往里加键，
// **不改表结构、不加列**。所以每个字段都必须能容忍缺失（老行没有它们）。
//
// 前四个来自 LlmAttemptContext：由 chatRobust 驱动时一定齐全（chat 会原样带上）。
// 这里写成可选是因为 chat 也可以被直接调用（如模型探测），那时它们没有意义、不该编造。
export interface LlmCallObservation extends Partial<LlmAttemptContext> {
  /** 仅成功时：从发起 fetch 到拿到响应头（毫秒）。拿不到就不写，不编。 */
  ttfbMs?: number;
  /**
   * 响应头里的 cf-ray（`<ray id>-<colo>`）。**成功与失败都写**，只要响应头里有——
   * 2026-09-17 起才这样：此前只在成功时写，于是 HTTP 状态类失败（524/429/5xx，这些
   * 响应**带着** cf-ray）的 colo 信息被白白丢掉，线上「成片失败是不是同一个 colo」
   * 无从回答。拿不到就不写这个键，不编。
   */
  cfRay?: string;
  /** 失败时：LlmError.code（如 UPSTREAM_FIRST_BYTE_TIMEOUT / UPSTREAM_UNREACHABLE）。 */
  errorCode?: string;
  /**
   * 仅「传输层失败、且连响应头都没拿到」时：目标主机名（BASE_URL 的 host）。
   * 与 resolvedIps 成对出现——那时既没有 cf-ray 也没有状态码，这是唯一还能判定的上游身份。
   */
  upstreamHost?: string;
  /**
   * 同上那种行：**观测时刻**对该主机的 DNS 解析结果（去重）。只是代理指标，不是那一次
   * 连接真正用的对端地址（undici 不暴露 socket 对端，Cloudflare 又是 anycast），
   * 详见 llm.ts 的注释。取不到就不写，不编。
   */
  resolvedIps?: string[];
}

export interface LlmCallUsage {
  model: string;
  requestId: string | null;
  createdAt: string;
  usage: LlmUsage;
  // 观测字段（可选）：chat 直接调用时只有它自己观测到的部分；chatRobust 还会补上
  // 尝试上下文。任何字段都拿不到时整个对象不挂上，避免写入无意义的结构。
  observation?: LlmCallObservation;
}

export interface LlmUsageRecord extends LlmCallUsage {
  phase: LlmUsagePhase;
}

export interface TokenTotals {
  prompt: number;
  completion: number;
  total: number;
  cache: number;
  calls: number;
  missingUsageCalls: number;
}

export interface TokenStats {
  total: TokenTotals;
  last24h: TokenTotals;
  byPhase: (TokenTotals & { phase: LlmUsagePhase })[];
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// 网关对思维链 token 的独立计数（OpenAI 系的 completion_tokens_details.reasoning_tokens，
// 也有网关放在 output_tokens_details 下）。只作为「确实是推理模型」的旁证：
// 注意 completion_tokens 是思维链+正文的合计，不是正文长度。字段缺失或为 0 都不能反过来
// 证明「不是推理模型」，所以这里读不到就返回 0。
export function reasoningTokenCount(usage: LlmUsage): number {
  const raw = usage.rawUsage;
  if (!raw) return 0;
  const details = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details
    : isRecord(raw.output_tokens_details) ? raw.output_tokens_details : null;
  return tokenCount(details?.reasoning_tokens) ?? 0;
}

export function parseLlmUsage(value: unknown): LlmUsage {
  const raw = isRecord(value) ? value : null;
  const prompt = tokenCount(raw?.prompt_tokens);
  const completion = tokenCount(raw?.completion_tokens);
  const promptDetails = isRecord(raw?.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const inputDetails = isRecord(raw?.input_tokens_details) ? raw.input_tokens_details : {};
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    // 只相加已知计数，不根据文本长度估算。
    totalTokens: tokenCount(raw?.total_tokens) ?? ((prompt ?? 0) + (completion ?? 0)),
    cacheTokens: tokenCount(promptDetails.cached_tokens) ?? tokenCount(inputDetails.cached_tokens)
      ?? tokenCount(raw?.prompt_cache_hit_tokens) ?? tokenCount(raw?.cache_read_input_tokens)
      ?? tokenCount(raw?.cached_tokens) ?? tokenCount(raw?.cache_tokens) ?? 0,
    usageMissing: prompt === undefined || completion === undefined,
    rawUsage: raw,
  };
}
