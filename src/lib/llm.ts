// OpenAI 兼容的 LLM 客户端（流式），指向 NewAPI（Cloudflare Tunnel 公网入口）
//
// 三个实测教训（2026-09-12）：
// 1. 上游 SSE 只用于持续产生响应字节、避免 CF 约 100s 的无响应 524；Route Handler
//    仍会聚合完整结果后一次性回给浏览器，并不是浏览器端流式输出。
// 2. 渠道偶发把中文请求搞成 mojibake，请求体统一 ASCII 转义消除这个变量
// 3. 公益渠道吞吐波动极大（同样任务 37s~180s+），所以加空闲超时 + 一次重试
import { cleanString, hasInvalidDatabaseCharacters, isRecord } from './sanitize';

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.cloud.us.kg/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'claude-opus-5-88';
const DEFAULT_TOTAL_TIMEOUT_MS = 280_000;
const MAX_ROBUST_BUDGET_MS = 285_000;
const DEFAULT_MAX_TOKENS = 3_000;
const MAX_SSE_BUFFER = 256 * 1024;
const MAX_CONTENT_LENGTH = 64 * 1024;

export const MAX_PROFILE_LENGTH = 5_000;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function validateProfileContent(value: unknown): string {
  const content = cleanString(value, MAX_PROFILE_LENGTH);
  if (!content) {
    throw new LlmError('模型返回的画像为空、过长或含非法字符，请重试。', false);
  }
  return content;
}

function cancelledError(): LlmError {
  return new LlmError('模型调用已取消。', false);
}

function configuredTotalTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.LLM_TOTAL_TIMEOUT_MS ?? String(DEFAULT_TOTAL_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOTAL_TIMEOUT_MS;
}

function asciiEscape(s: string): string {
  // 非 ASCII 转 \uXXXX：语义与 UTF-8 原文完全等价，但免疫链路上的编码损坏
  return s.replace(/[^\x00-\x7f]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

// 流式中转避免等待整段响应；持续出 token 仍受同一次调用的总时限约束。
export async function chat(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  if (!API_KEY) {
    throw new LlmError('LLM_API_KEY is not set', false);
  }
  if (opts.signal?.aborted) throw cancelledError();
  const idleMs = opts.idleTimeoutMs ?? 60_000; // 两个 chunk 之间超过 60s 视为卡死
  const totalMs = opts.totalTimeoutMs ?? configuredTotalTimeoutMs();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), totalMs);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': 'claude-cli/2.1.241 (external, cli)',
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: asciiEscape(
        JSON.stringify({
          model: MODEL,
          temperature: opts.temperature ?? 0.7,
          max_tokens: Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      ),
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const challenged = res.headers.get('cf-mitigated') === 'challenge' ||
        /<title>\s*Just a moment|\/cdn-cgi\/challenge-platform/i.test(responseText);
      // Upstream bodies may contain HTML, credentials, or provider internals.
      console.error('LLM upstream request rejected', {
        status: res.status,
        challenged,
        ray: res.headers.get('cf-ray'),
      });
      let message = `模型服务暂时不可用（HTTP ${res.status}），请稍后重试。`;
      if (challenged) {
        message = '模型服务被 Cloudflare 安全验证拦截，请管理员检查模型接口的防火墙规则。';
      } else if (res.status === 401 || res.status === 403) {
        message = `模型服务拒绝访问（HTTP ${res.status}），请管理员检查接口密钥、模型权限及访问规则。`;
      } else if (res.status === 429) {
        message = '模型服务请求过于频繁或额度不足，请稍后重试或联系管理员。';
      }
      throw new LlmError(
        message,
        !challenged && (res.status === 408 || res.status === 429 || res.status >= 500),
      );
    }
    if (!res.body) {
      throw new LlmError('LLM returned no body');
    }

    const content = await readSseContent(res.body, idleMs, controller);
    if (opts.signal?.aborted) throw cancelledError();
    return content;
  } catch (e) {
    if (opts.signal?.aborted) throw cancelledError();
    if (e instanceof LlmError) throw e;
    if (controller.signal.aborted) {
      throw new LlmError(`LLM 总超时（${Math.ceil(totalMs / 1000)}s）`);
    }
    throw new LlmError(e instanceof Error ? `LLM 请求失败：${e.message}` : 'LLM 请求失败');
  } finally {
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener('abort', cancel);
  }
}

interface SseChunk {
  content: string;
  rest: string;
  done: boolean;
  finished: boolean;
}

function invalidSse(): LlmError {
  return new LlmError('模型流包含无效的 SSE 事件，请重试。');
}

function decodeSseEvent(event: unknown): { content: string; finished: boolean } {
  if (!isRecord(event)) throw invalidSse();
  if (event.error != null || event.type === 'error') {
    // 不把可能含凭据或渠道内部信息的上游 error 原样返回给浏览器。
    throw new LlmError('模型服务返回了错误事件，请重试。');
  }
  if (!Array.isArray(event.choices)) throw invalidSse();
  if (event.choices.length === 0) return { content: '', finished: false }; // usage 块
  if (event.choices.length !== 1 || !isRecord(event.choices[0])) throw invalidSse();
  const choice = event.choices[0];
  if (choice.error != null) throw new LlmError('模型服务返回了错误事件，请重试。');
  if (choice.index != null && choice.index !== 0) throw invalidSse();
  if (choice.delta != null && !isRecord(choice.delta)) throw invalidSse();
  const delta = isRecord(choice.delta) ? choice.delta : {};
  if (delta.content != null && typeof delta.content !== 'string') throw invalidSse();
  if (delta.function_call != null ||
      (delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0))) {
    throw new LlmError('模型返回了工具调用，未生成完整正文，请重试。', false);
  }

  const reason = choice.finish_reason;
  if (reason === 'length') {
    throw new LlmError('模型输出因长度限制被截断，请缩短输入后重试。', false);
  }
  if (reason === 'content_filter') {
    throw new LlmError('模型输出被上游内容过滤中断，请调整输入后重试。', false);
  }
  if (reason != null && reason !== 'stop') {
    throw new LlmError('模型未以完整正文结束，请重试。', false);
  }
  return { content: typeof delta.content === 'string' ? delta.content : '', finished: reason === 'stop' };
}

// 当前 NewAPI /chat/completions 的兼容规则：
// - [DONE]，或明确 finish_reason=stop 后的干净 EOF，均可完成。
// - role / reasoning / usage 等不含正文的合法增量不算结束。
// - 标准 SSE 的多行 data、LF/CRLF/CR，以及已有的逐行 JSON 中转格式均可读。
// 无效事件必须报错；不能丢掉坏行后把残缺正文作为完整结果。
export function consumeSseChunk(buf: string, flush: boolean): SseChunk {
  if (buf.length > MAX_SSE_BUFFER) throw invalidSse();
  const trailingCR = !flush && buf.endsWith('\r') ? '\r' : '';
  const normalized = (trailingCR ? buf.slice(0, -1) : buf).replace(/\r\n|\r/g, '\n');
  const lines = normalized.split('\n');
  const tail = flush ? '' : (lines.pop() ?? '') + trailingCR;
  let content = '';
  let done = false;
  let finished = false;
  let data: string[] = [];
  let pending: string[] = [];

  for (const line of lines) {
    if (line === '') {
      if (data.length > 0) throw invalidSse(); // 一个已结束但仍无法解析的事件
      pending = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      if (value.trim() === 'error') throw new LlmError('模型服务返回了错误事件，请重试。');
      pending.push(line);
      continue;
    }
    if (field !== 'data') continue;
    pending.push(line);
    data.push(value);
    const payload = data.join('\n').trim();
    if (payload === '[DONE]') {
      done = true;
      pending = [];
      data = [];
      break;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      // 可能是多行 data 的半个 JSON；保留到事件边界或 EOF 再判坏。
      continue;
    }
    const parsed = decodeSseEvent(event);
    if (finished && parsed.content) throw invalidSse();
    content += parsed.content;
    finished ||= parsed.finished;
    data = [];
    pending = [];
  }
  if (flush && data.length > 0) throw invalidSse();
  return {
    content,
    rest: done ? '' : pending.map((line) => line + '\n').join('') + tail,
    done,
    finished,
  };
}

async function readSseContent(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  controller: AbortController,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buf = '';
  let content = '';
  let finished = false;
  let onAbort: () => void = () => {};
  // 显式监听取消，连不响应 fetch signal 的上游 reader 也受总预算约束。
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        aborted,
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            reject(new LlmError('LLM 空闲超时（' + Math.ceil(idleMs / 1000) + 's 无新 token）'));
            controller.abort();
          }, idleMs);
        }),
      ]).finally(() => clearTimeout(idleTimer));
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const parsed = consumeSseChunk(buf, done);
      if (finished && parsed.content) throw invalidSse();
      content += parsed.content;
      if (content.length > MAX_CONTENT_LENGTH) {
        throw new LlmError('模型输出过长，请重试。', false);
      }
      buf = parsed.rest;
      finished ||= parsed.finished;
      if (parsed.done) break;
      if (done) {
        if (!finished) throw new LlmError('模型流在结束标记之前中断，请重试。');
        break;
      }
    }
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (!content.trim() || hasInvalidDatabaseCharacters(content)) {
    throw new LlmError('模型返回了空正文或非法字符，请重试。');
  }
  return content;
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// 首次调用、等待和唯一一次重试共享截止时间，绝不重新获得完整预算。
export async function chatRobust(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const budgetMs = Math.min(configuredTotalTimeoutMs(), MAX_ROBUST_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  try {
    return await chat(system, user, { ...opts, totalTimeoutMs: budgetMs });
  } catch (e) {
    if (!(e instanceof LlmError) || !e.retryable) throw e;
    if (opts.signal?.aborted) throw cancelledError();
    const delayMs = 1_500;
    if (deadline - Date.now() <= delayMs) throw e;
    await retryDelay(delayMs, opts.signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw e;
    return chat(system, user, { ...opts, totalTimeoutMs: remainingMs });
  }
}

// 从 LLM 回复里稳健地抠出 JSON（容忍 ```json 围栏、前后废话）
export function parseJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // 兜底：截取第一个 { 或 [ 到最后一个 } 或 ]
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const first = Math.min(
      ...[t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0),
    );
    const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (Number.isFinite(first) && last > first) {
      t = t.slice(first, last + 1);
    }
  }
  try {
    return JSON.parse(t) as unknown;
  } catch {
    throw new LlmError('模型返回了无效的 JSON，请重试。', false);
  }
}
