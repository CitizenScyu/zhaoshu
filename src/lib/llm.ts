// OpenAI 兼容的 LLM 客户端（流式），指向 NewAPI（Cloudflare Tunnel 公网入口）
//
// 三个实测教训（2026-09-12）：
// 1. 上游 SSE 只用于持续产生响应字节、避免 CF 约 100s 的无响应 524；Route Handler
//    仍会聚合完整结果后一次性回给浏览器，并不是浏览器端流式输出。
// 2. 渠道偶发把中文请求搞成 mojibake，请求体统一 ASCII 转义消除这个变量
// 3. 公益渠道吞吐波动极大（同样任务 37s~180s+），所以加空闲超时 + 一次重试
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.cloud.us.kg/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'claude-opus-5-88';
const DEFAULT_TOTAL_TIMEOUT_MS = 280_000;
const MAX_ROBUST_BUDGET_MS = 285_000;
const DEFAULT_MAX_TOKENS = 3_000;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'LlmError';
  }
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

// 流式调用：首字节不受 CF 100s 限制；只要 token 还在流动就一直读
export async function chat(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
    maxTokens?: number;
  } = {},
): Promise<string> {
  if (!API_KEY) {
    throw new LlmError('LLM_API_KEY is not set', false);
  }
  const idleMs = opts.idleTimeoutMs ?? 60_000; // 两个 chunk 之间超过 60s 视为卡死
  const totalMs = opts.totalTimeoutMs ?? configuredTotalTimeoutMs();
  const controller = new AbortController();
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

    return await readSseContent(res.body, idleMs, controller);
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (controller.signal.aborted) {
      throw new LlmError(`LLM 总超时（${Math.ceil(totalMs / 1000)}s）`);
    }
    throw new LlmError(e instanceof Error ? `LLM 请求失败：${e.message}` : 'LLM 请求失败');
  } finally {
    clearTimeout(totalTimer);
  }
}

// 纯解析:吃一个已解码缓冲区,吐出完整行的 token 增量、剩余半行、以及是否见到 [DONE]。
// flush=true 表示流已结束(调用方刚把 decoder 尾巴并进来),此时没有"半行"可留。
export function consumeSseChunk(
  buf: string,
  flush: boolean,
): { content: string; rest: string; done: boolean } {
  const lines = buf.split('\n');
  const rest = flush ? '' : (lines.pop() ?? '');
  let content = '';
  let done = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      break;
    }
    try {
      const j = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[];
      };
      content += j.choices?.[0]?.delta?.content ?? '';
    } catch {
      // malformed SSE events are ignored; complete events are line-delimited
    }
  }
  return { content, rest, done };
}

async function readSseContent(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  controller: AbortController,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let sawDone = false;

  try {
    while (!sawDone) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            controller.abort();
            reject(new LlmError(`LLM 空闲超时（${Math.ceil(idleMs / 1000)}s 无新 token）`));
          }, idleMs);
        }),
      ]).finally(() => clearTimeout(idleTimer));
      if (done) {
        buf += decoder.decode();
        sawDone = true;
      } else {
        buf += decoder.decode(value, { stream: true });
      }

      const parsed = consumeSseChunk(buf, sawDone);
      content += parsed.content;
      buf = parsed.rest;
      if (parsed.done) sawDone = true;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content.trim()) {
    throw new LlmError('LLM returned empty content');
  }
  return content;
}

// 带一次重试的调用：渠道抖动（524/超时/空回复）时自动再试一次
export async function chatRobust(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const startedAt = Date.now();
  const budgetMs = Math.min(configuredTotalTimeoutMs(), MAX_ROBUST_BUDGET_MS);
  try {
    return await chat(system, user, { ...opts, totalTimeoutMs: budgetMs });
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    if (!e.retryable) throw e;
    const retryDelayMs = 1_500;
    const remainingMs = budgetMs - (Date.now() - startedAt) - retryDelayMs;
    if (remainingMs <= 0) throw e;
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return chat(system, user, { ...opts, totalTimeoutMs: remainingMs });
  }
}

// 从 LLM 回复里稳健地抠出 JSON（容忍 ```json 围栏、前后废话）
export function parseJson<T>(text: string): T {
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
  return JSON.parse(t) as T;
}
