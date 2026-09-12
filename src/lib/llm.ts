// OpenAI 兼容的 LLM 客户端（流式），指向 NewAPI（Cloudflare Tunnel 公网入口）
//
// 三个实测教训（2026-09-12）：
// 1. CF 免费版 ~100s 掐"无响应"连接（524）——流式请求首字节一到就不受此限
// 2. 渠道偶发把中文请求搞成 mojibake，请求体统一 ASCII 转义消除这个变量
// 3. 公益渠道吞吐波动极大（同样任务 37s~180s+），所以加空闲超时 + 一次重试
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.cloud.us.kg/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'claude-opus-5-88';

export class LlmError extends Error {}

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
  opts: { temperature?: number; idleTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<string> {
  if (!API_KEY) {
    throw new LlmError('LLM_API_KEY is not set');
  }
  const idleMs = opts.idleTimeoutMs ?? 60_000; // 两个 chunk 之间超过 60s 视为卡死
  const totalMs =
    opts.totalTimeoutMs ?? parseInt(process.env.LLM_TOTAL_TIMEOUT_MS ?? '280000', 10);
  const totalDeadline = Date.now() + totalMs;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: asciiEscape(
      JSON.stringify({
        model: MODEL,
        temperature: opts.temperature ?? 0.7,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    ),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmError(`LLM ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new LlmError('LLM returned no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';

  try {
    for (;;) {
      if (Date.now() > totalDeadline) {
        throw new LlmError('LLM 总超时（280s）');
      }
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new LlmError('LLM 空闲超时（60s 无新 token）')), idleMs),
        ),
      ]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          content += j.choices?.[0]?.delta?.content ?? '';
        } catch {
          // 非完整 JSON 行，忽略（残留在 buf 里的会拼上）
        }
      }
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
  opts: { temperature?: number } = {},
): Promise<string> {
  try {
    return await chat(system, user, opts);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return chat(system, user, opts);
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
