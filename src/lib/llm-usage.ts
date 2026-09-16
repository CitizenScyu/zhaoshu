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

export interface LlmCallUsage {
  model: string;
  requestId: string | null;
  createdAt: string;
  usage: LlmUsage;
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
