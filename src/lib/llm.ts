// OpenAI 兼容的 LLM 客户端（流式），指向 NewAPI（Cloudflare Tunnel 公网入口）
//
// 三个实测教训（2026-09-12）：
// 1. 上游 SSE 只用于持续产生响应字节、避免 CF 约 100s 的无响应 524；Route Handler
//    仍会聚合完整结果后一次性回给浏览器，并不是浏览器端流式输出。
// 2. 渠道偶发把中文请求搞成 mojibake，请求体统一 ASCII 转义消除这个变量
// 3. 公益渠道吞吐波动极大（同样任务 37s~180s+），所以加空闲超时 + 一次重试
import { cleanString, hasInvalidDatabaseCharacters, isRecord } from './sanitize';
import {
  parseLlmUsage, reasoningTokenCount,
  type LlmAttemptContext, type LlmCallObservation, type LlmCallUsage, type LlmUsage,
} from './llm-usage';
import { environmentModel, readModelSetting, type ReasoningVerdict } from './app-settings';

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.cloud.us.kg/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const DEFAULT_TOTAL_TIMEOUT_MS = 280_000;
const MAX_ROBUST_BUDGET_MS = 285_000;
// 上游 claude-opus-5-88 是推理模型：它先流式吐 delta.reasoning_content（思维链），
// 再吐 delta.content（正文），两者共享同一个 max_tokens 预算。预算太小（实测 3000）
// 会让思维链吃光额度，finish_reason=max_tokens 而正文为空。按非推理模型的用量定
// max_tokens 会稳定踩这个坑，所以缺省值按推理模型给足，并留出环境变量可调。
const DEFAULT_MAX_TOKENS = 16_000;
const MAX_SSE_BUFFER = 256 * 1024;
const MAX_CONTENT_LENGTH = 64 * 1024;

// 硬性安全上限（拒绝异常长/被污染的模型输出），不是提示词里那句"画像总长控制在
// 300 字内"。两者用途不同，不要为了"一致"把这里收紧到 300：线上已有 392 字符的
// 正常画像，收紧会让下一次反馈回写把现有画像判成非法。
export const MAX_PROFILE_LENGTH = 5_000;

export interface ChatResult {
  content: string;
  usage: LlmUsage;
  model: string;
  requestId: string | null;
}

interface ChatOptions {
  temperature?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  // 首字节上限（TTFB）：fetch 在拿到响应头之前就判死。有些失败连响应头都不给——
  // Cloudflare 的 524 要等源站超时才回，实测 ~126s——只靠 idleTimeoutMs 拦不住它，
  // 因为那时流还没建立、还没有「两个 chunk 之间」可言。不给则只受 totalTimeoutMs 约束。
  firstByteTimeoutMs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  stream?: boolean;
  // 显式指定模型（保存前验证用）；不给就按运行时优先级解析当前模型。
  model?: string;
  // 每次实际请求（含失败和重试）只通知一次；调用方负责在响应后落库。
  onUsage?: (call: LlmCallUsage) => void;
  // 本次调用在 chatRobust 里是第几次尝试（见 llm-usage.ts 的 LlmAttemptContext）。
  // 不给就只写 chat 自己能观测到的 ttfbMs / cfRay / errorCode。
  attemptContext?: LlmAttemptContext;
  // 流式增量回调：每解析出新正文就叫一次（不分批、不等待完整结果）。
  // 供 profile 生成把首字节尽早推给浏览器；调用方不得依赖该回调的调用次数。
  onToken?: (delta: string) => void;
  // 上游返回里出现思维链（reasoning_content / reasoning）时通知一次。
  onReasoning?: () => void;
}

interface ResponseMetadata {
  usage?: LlmUsage;
  model?: string;
  requestId?: string;
  reasoning?: boolean;
}

function reasoningText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

// 兼容两种出法：reasoning_content（NewAPI / DeepSeek 系）与 reasoning（部分网关）。
// 只作为推理模型的判据，不参与正文解析。
function hasReasoningDelta(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.choices) || value.choices.length === 0) return false;
  const choice = value.choices[0];
  if (!isRecord(choice)) return false;
  const carrier = isRecord(choice.delta) ? choice.delta
    : isRecord(choice.message) ? choice.message : null;
  return carrier !== null && (reasoningText(carrier.reasoning_content) || reasoningText(carrier.reasoning));
}

function responseMetadata(value: unknown): ResponseMetadata {
  if (!isRecord(value)) return {};
  const model = cleanString(value.model, 200);
  const requestId = cleanString(value.id, 200);
  return {
    ...(value.usage != null ? { usage: parseLlmUsage(value.usage) } : {}),
    ...(model ? { model } : {}),
    ...(requestId ? { requestId } : {}),
    ...(hasReasoningDelta(value) ? { reasoning: true } : {}),
  };
}

// 传输层失败分两族，处理方式完全不同（2026-09-17 实测）：
//
// - UPSTREAM_UNREACHABLE：**连不上**——fetch 自己抛错（undici 冷连接 10s connect timeout 的
//   指纹，实测本机 12 次 GET /v1/models 里 7 次失败，且跨 6 个以上模型路由命中）、没有响应体。
//   特征：~10s fail-fast、重试极便宜，而且**换模型也没用**（连接层问题对所有模型一视同仁）。
//   → 原地重试，不换模型。
// - UPSTREAM_STALLED：**连上了但没进展或没答复**——网关自己的超时状态码 408/524、
//   首字节上限到点、流内停滞、总超时。特征：昂贵（524 实测要 ~126s），一次就能吃光整步预算。
//   → 降级到兜底模型（换一条路由才治得住）。
//
// 2026-09-17 细分出第三种，因为「换成兜底模型」并不是这一族的最优解：
// - UPSTREAM_FIRST_BYTE_TIMEOUT：**响应头在单次上限内根本没到**（`expiredBy === 'first_byte'`）。
//   这是失败族里最大的那一个——线上 n=68 次失败中 86% 是它（request_id IS NULL + 相邻差恰好
//   45.000–45.003s = 单次上限）。探针实测（n=15 次超时事件）：**首字节超时后立刻重发，
//   8/15 = 53.3% 直接拿到正文、11/15 = 73.3% 至少拿到响应头**，而 abort 掉的停滞连接不会被
//   复用、普通重试天然就是新连接（T31 实测，所以不需要引入 undici 的 dispatcher）。
//   → 先**原地重发主模型一次**，仍失败才降级（见 chatRobust）。
// 刻意不去重试其余 STALLED 形态：408/524 是网关**已经回话**（内容与这次请求绑定），流内停滞与
// 总超时是「流已建立之后」的失败——探针对它们没有观测，重发价值未知且更费预算。
const UPSTREAM_UNREACHABLE = 'UPSTREAM_UNREACHABLE';
const UPSTREAM_STALLED = 'UPSTREAM_STALLED';
const UPSTREAM_FIRST_BYTE_TIMEOUT = 'UPSTREAM_FIRST_BYTE_TIMEOUT';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    // 供调用方区分可恢复的失败形态（「输出预算被思维链吃光」、以及上面那两族传输层失败）。
    readonly code?: string,
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

export function configuredTotalTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.LLM_TOTAL_TIMEOUT_MS ?? String(DEFAULT_TOTAL_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOTAL_TIMEOUT_MS;
}

// 缺省上限。调用方显式传的 maxTokens 只能往下压，不能突破它（见 chat 的 Math.min）。
export function configuredMaxTokens(): number {
  const parsed = Number.parseInt(
    process.env.LLM_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

// ---- 兜底模型（chatRobust 的传输层降级）----
// 2026-09-17：找书全链路换用快模型（`gemini-3.1-pro-ely`，实测 recall 中位 10.2s，
// 对比 claude-opus-5-88 的 115.8s），但那个路由有约 22% 的传输层失败率
// （`TypeError: fetch failed` @~11s，以及 HTTP 524 @~126s）。换模型换来的是速度，
// 不能同时换来「22% 的请求直接失败」，所以主模型连不上时按剩余预算降级回一个已知可用的模型。
//
// 兜底模型可配置（LLM_FALLBACK_MODEL），缺省回落到 claude-opus-5-88——换掉它不需要改代码。
export const DEFAULT_FALLBACK_MODEL = 'claude-opus-5-88';

export function configuredFallbackModel(): string {
  const fromEnv = process.env.LLM_FALLBACK_MODEL?.trim();
  return fromEnv || DEFAULT_FALLBACK_MODEL;
}

// 开一次兜底调用至少要留下的剩余预算。与 find 的 modelStep 用同一个约定
// （MIN_SECOND_ATTEMPT_MS）：低于这个数就干脆不发起——宁可直接失败，
// 也不要用一个注定超时的请求把截止时间耗光，那会让错误变成「总超时」而掩盖真实原因。
export const MODEL_FALLBACK_MIN_BUDGET_MS = 5_000;

// ---- 单次尝试上限（停滞与首字节）----
// 2026-09-17 实测：这个网关上的失败有两族，只有「降级」治不住其中一族。
//   - 连接层 `fetch failed`：~10s fail-fast，原地重试极便宜；
//   - HTTP 524：要吃满 ~126s 才回，**一次就能把整步 260s 预算啃掉一半**，兜底还没轮到就没预算了；
//   - 以及「流已建立后停滞」：HTTP 200 + text/event-stream 建流成功，TTFB 5.2–17.8s 之后
//     不再出正文——只加首字节上限拦不住它（首字节早就到了），必须同时有流内停滞上限。
// 所以单次尝试要有自己的上限，且**两种都要**：首字节（防 524 那种连响应头都不给）+
// 流内停滞（防建流后卡住）。两者都压到 45s 以内，524 就会在 ~45s 被截断，把剩余预算留给兜底。
//
// 45s 的取法（推断，非实测最优）：实测正常响应的中位 12.3s、慢尾 30.0s，45s 留出约 1.5 倍余量；
// 同时 45s < 260s/2，保证一次截断之后至少还剩一半预算给兜底。可用 LLM_ATTEMPT_TIMEOUT_MS 调。
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;

export function configuredAttemptTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.LLM_ATTEMPT_TIMEOUT_MS ?? String(DEFAULT_ATTEMPT_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

// ---- 运行时模型解析（数据库设置 → 环境变量 LLM_MODEL → 硬编码缺省）----
// 2026-09-16 的线上故障源于「换模型要改环境变量 + 重新部署」这条链路太长，
// 所以模型不再在模块加载期定死，而是每次调用解析。
//
// 进程内短 TTL 缓存：连续多次 LLM 调用只读一次库（找书的一次请求里 recall 与
// rerank 共享同一次读取）。PATCH 写库后调用 resetModelCache() 立即生效。
export const MODEL_CACHE_TTL_MS = 30_000;
// 设置读取的独立上限：读库慢或挂住不能拖长模型调用，超时即静默回退。
export const MODEL_SETTINGS_READ_TIMEOUT_MS = 2_000;

let modelCache: { model: string; expiresAt: number } | null = null;

export function resetModelCache(): void {
  modelCache = null;
}

// 只在成功读到设置时缓存（含"没有覆盖值"这一结论）；读失败不缓存，避免把一次
// 故障钉住整个 TTL。任何失败都静默回退——设置读不到绝不能让模型调用失败。
export async function resolveModel(): Promise<string> {
  const cached = modelCache;
  if (cached && cached.expiresAt > Date.now()) return cached.model;
  const stored = await readStoredModelSafely();
  const model = stored.model ?? environmentModel().model;
  if (stored.ok) modelCache = { model, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return model;
}

async function readStoredModelSafely(): Promise<{ ok: boolean; model: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('app settings read timed out')), MODEL_SETTINGS_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    const setting = await Promise.race([readModelSetting(), timeout]);
    return { ok: true, model: setting.model };
  } catch {
    return { ok: false, model: null };
  } finally {
    clearTimeout(timer);
  }
}

function asciiEscape(s: string): string {
  // 非 ASCII 转 \uXXXX：语义与 UTF-8 原文完全等价，但免疫链路上的编码损坏
  return s.replace(/[^\x00-\x7f]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

// 把一次尝试的失败归到失败族。拆出来只为让 chat 能在 finally 里拿到错误码写进观测
// （usage_details.errorCode）。**除「首字节超时」自成一族外，其余分支与拆分前逐字一致**：
// 调用方取消 → 已取消；已是 LlmError → 原样；controller 被 abort → 按 expiredBy 分首字节/总超时；
// 否则 fetch 自己抛了 → 连接层。
function classifyFailure(
  e: unknown,
  state: {
    // 调用方取消（signal），与下面「本次尝试自己的 controller 被 abort」是两回事。
    callerAborted: boolean;
    controllerAborted: boolean;
    expiredBy: 'total' | 'first_byte' | null;
    firstByteMs: number | null;
    totalMs: number;
  },
): LlmError {
  if (state.callerAborted) return cancelledError();
  if (e instanceof LlmError) return e;
  if (state.controllerAborted) {
    // 首字节到点：连响应头都没等到（524 就是这一族），报成「总超时」会把它误导成「模型太慢」。
    if (state.expiredBy === 'first_byte') {
      return new LlmError(
        `模型服务首字节超时（${Math.ceil((state.firstByteMs ?? state.totalMs) / 1000)}s 内未返回响应头）`,
        true, UPSTREAM_FIRST_BYTE_TIMEOUT,
      );
    }
    return new LlmError(`LLM 总超时（${Math.ceil(state.totalMs / 1000)}s）`, true, UPSTREAM_STALLED);
  }
  // 走到这里说明 fetch 自己抛了（连接失败）——便宜的那一族。
  return new LlmError(
    e instanceof Error ? `LLM 请求失败：${e.message}` : 'LLM 请求失败', true, UPSTREAM_UNREACHABLE,
  );
}

// 流式中转避免等待整段响应；持续出 token 仍受同一次调用的总时限约束。
export async function chat(
  system: string,
  user: string,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  if (!API_KEY) {
    throw new LlmError('LLM_API_KEY is not set', false);
  }
  if (opts.signal?.aborted) throw cancelledError();
  // 模型在每次调用时解析；解析有自己的短上限且失败即回退，耗时也不占下面的模型总预算。
  const model = opts.model ?? await resolveModel();
  const idleMs = opts.idleTimeoutMs ?? 60_000; // 两个 chunk 之间超过 60s 视为卡死
  const totalMs = opts.totalTimeoutMs ?? configuredTotalTimeoutMs();
  // 首字节上限只在调用方显式给出时才设：不给就与加这个选项之前完全一致（只受总时限约束）。
  const firstByteMs = opts.firstByteTimeoutMs != null
    ? Math.min(opts.firstByteTimeoutMs, totalMs) : null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  // 解析设置是新增的一次等待：信号若恰好在这段时间里被取消，开头的检查已经过去、
  // 监听又刚挂上，必须显式补一次中止。这样这次调用会立刻以「已取消」失败，
  // 已中止的信号不会真的打到上游（取消语义与解析之前完全一致）。
  if (opts.signal?.aborted) cancel();
  // 两个计时器都可能 abort 同一个 controller，靠这个标记区分是哪一个到点，
  // 否则 524 会被报成「总超时」，把「网关根本没回」误导成「模型太慢」。
  let expiredBy: 'total' | 'first_byte' | null = null;
  const totalTimer = setTimeout(() => {
    if (expiredBy === null) expiredBy = 'total';
    controller.abort();
  }, totalMs);
  const stream = opts.stream ?? true;
  const maxTokensCeiling = configuredMaxTokens();
  const call: LlmCallUsage = {
    model, requestId: null, createdAt: new Date().toISOString(), usage: parseLlmUsage(undefined),
  };
  // 观测（落进 usage_details，见 llm-usage.ts 的 LlmCallObservation）：只记真实观测到的值。
  // ttfbMs / cfRay 只在**这次调用成功**时写（题面要求「成功时」）：失败时它们说明不了什么，
  // 失败族由 errorCode 表达。拿不到就整个键不写，绝不编。
  let succeeded = false;
  let ttfbMs: number | undefined;
  let cfRay: string | undefined;
  let errorCode: string | undefined;
  // 尝试上下文由 chatRobust 给出；首字节超时是 chat 自己判定的，所以计数在这里累加
  // （chatRobust 只给「此前」的基数），这样本行记的就是「截止本行」的累计值。
  let firstByteTimeouts = opts.attemptContext?.firstByteTimeouts ?? 0;
  // 没有任何观测时不挂这个对象——不允许为了凑结构编造数值。
  const observationFor = (): LlmCallObservation | undefined => {
    const context = opts.attemptContext;
    const observed: LlmCallObservation = {
      ...(context ? {
        attempts: context.attempts,
        firstByteTimeouts,
        retried: context.retried,
        fallbackUsed: context.fallbackUsed,
      } : {}),
      ...(succeeded && ttfbMs != null ? { ttfbMs } : {}),
      ...(succeeded && cfRay ? { cfRay } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
    return Object.keys(observed).length > 0 ? observed : undefined;
  };
  const captureMetadata = (metadata: ResponseMetadata) => {
    if (metadata.usage) call.usage = metadata.usage;
    if (metadata.model) call.model = metadata.model;
    call.requestId ??= metadata.requestId ?? null;
    if (metadata.reasoning) {
      // 探测回调不得影响正文解析。
      try { opts.onReasoning?.(); } catch { /* ignore */ }
    }
  };

  let res: Response;
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (firstByteMs !== null) {
      firstByteTimer = setTimeout(() => {
        if (expiredBy === null) expiredBy = 'first_byte';
        controller.abort();
      }, firstByteMs);
    }
    const requestedAt = Date.now();
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
          model,
          temperature: opts.temperature ?? 0.7,
          max_tokens: Math.min(opts.maxTokens ?? maxTokensCeiling, maxTokensCeiling),
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      ),
    });
    // 响应头到手，首字节上限的使命结束；后面交给 idleMs 管「流内停滞」。
    clearTimeout(firstByteTimer);
    firstByteTimer = undefined;
    ttfbMs = Date.now() - requestedAt;
    cfRay = cleanString(res.headers.get('cf-ray'), 200);
    call.requestId = cleanString(res.headers.get('x-request-id'), 200)
      || cleanString(res.headers.get('request-id'), 200) || null;
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const challenged = res.headers.get('cf-mitigated') === 'challenge' ||
        /<title>\s*Just a moment|\/cdn-cgi\/challenge-platform/i.test(responseText);
      // Upstream bodies may contain HTML, credentials, or provider internals.
      console.error('LLM upstream request rejected', {
        status: res.status,
        challenged,
        ray: res.headers.get('cf-ray'),
        model,
      });
      let message = `模型服务暂时不可用（HTTP ${res.status}），请稍后重试。`;
      if (challenged) {
        message = '模型服务被 Cloudflare 安全验证拦截，请管理员检查模型接口的防火墙规则。';
      } else if (res.status === 401 || res.status === 403) {
        message = `模型服务拒绝访问（HTTP ${res.status}），请管理员检查接口密钥、模型权限及访问规则。`;
      } else if (res.status === 429) {
        message = '模型服务请求过于频繁或额度不足，请稍后重试或联系管理员。';
      }
      // 524（Cloudflare「源站没在时限内回应」）与 408 是**网关自己的超时**：上游一个字节都没答复，
      // 只是**昂贵**（524 实测要 ~126s，一次就能吃光整步预算），所以归到 STALLED 让调用方降级。
      // 其余状态码（含 503 model_not_found、429、500）是上游对这次请求给的**答复**——那是关于
      // 这个模型的语义结论，换模型重试同样会拿到它。被 CF 安全验证拦下的（challenged）也不在此列：
      // 那是防火墙在回话，不是没回话。
      const gatewayTimeout = !challenged && (res.status === 408 || res.status === 524);
      throw new LlmError(
        message,
        !challenged && (res.status === 408 || res.status === 429 || res.status >= 500),
        gatewayTimeout ? UPSTREAM_STALLED : undefined,
      );
    }
    if (!res.body) {
      throw new LlmError('LLM returned no body', true, UPSTREAM_UNREACHABLE);
    }

    // 某些兼容中转即使收到 stream=true，也会返回完整 JSON。
    const json = !stream || /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(res.headers.get('content-type') ?? '');
    const content = await readCompletionContent(res.body, idleMs, controller, json, captureMetadata, opts.onToken);
    if (opts.signal?.aborted) throw cancelledError();
    succeeded = true;
    return { content, usage: call.usage, model: call.model, requestId: call.requestId };
  } catch (e) {
    const error = classifyFailure(e, {
      callerAborted: opts.signal?.aborted === true,
      controllerAborted: controller.signal.aborted,
      expiredBy, firstByteMs, totalMs,
    });
    // 失败也要留下失败族（usage_details.errorCode）：不然线上分不清是哪一族挂的。
    errorCode = error.code;
    if (error.code === UPSTREAM_FIRST_BYTE_TIMEOUT) firstByteTimeouts += 1;
    throw error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(firstByteTimer);
    opts.signal?.removeEventListener('abort', cancel);
    const observation = observationFor();
    if (observation) call.observation = observation;
    try {
      opts.onUsage?.(call);
    } catch (error) {
      console.error('LLM usage callback failed:', error);
    }
  }
}

interface SseChunk extends ResponseMetadata {
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
  // OpenAI 兼容网关对「撞到 max_tokens 上限」既可能报 length（官方名），也可能直接
  // 回传 max_tokens。推理模型会把预算先花在思维链上，正文一个字都没产出——不是输入
  // 太长，所以文案不能说「请缩短输入」，那会把排查引到错误方向。
  if (reason === 'length' || reason === 'max_tokens') {
    throw new LlmError(
      '模型把输出预算用在了思考上（推理模型的思维链与正文共享额度），正文未产出。请重试，或改用非推理模型。',
      false,
      'OUTPUT_TRUNCATED',
    );
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
export function consumeSseChunk(
  buf: string,
  flush: boolean,
  onMetadata?: (metadata: ResponseMetadata) => void,
): SseChunk {
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
  let metadata: ResponseMetadata = {};

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
    const currentMetadata = responseMetadata(event);
    metadata = { ...metadata, ...currentMetadata };
    // 在正文校验前收集：长度截断或坏尾部也可能已经产生实际用量。
    onMetadata?.(currentMetadata);
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
    ...metadata,
  };
}

function decodeJsonCompletion(value: unknown): string {
  if (!isRecord(value)) throw invalidSse();
  if (value.error != null) throw new LlmError('模型服务返回了错误事件，请重试。');
  if (!Array.isArray(value.choices) || value.choices.length !== 1 || !isRecord(value.choices[0])) {
    throw new LlmError('模型返回了无效的 JSON 回复，请重试。');
  }
  const choice = value.choices[0];
  if (!isRecord(choice.message)) throw new LlmError('模型返回了无效的 JSON 回复，请重试。');
  // 非流式也保留相同的截断、过滤和工具调用保护。
  const parsed = decodeSseEvent({ choices: [{ ...choice, delta: choice.message }] });
  if (!parsed.finished) throw new LlmError('模型回复缺少完整结束标记，请重试。');
  return parsed.content;
}

async function readCompletionContent(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  controller: AbortController,
  json: boolean,
  onMetadata: (metadata: ResponseMetadata) => void,
  onToken?: (delta: string) => void,
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
            // 流已经建立、但两个 chunk 之间停滞：这正是 2026-09-17 实测到的那一族
            // （HTTP 200 + text/event-stream 已建立，TTFB 5.2–17.8s 之后不再出正文）。
            reject(new LlmError('LLM 空闲超时（' + Math.ceil(idleMs / 1000) + 's 无新 token）', true, UPSTREAM_STALLED));
            controller.abort();
          }, idleMs);
        }),
      ]).finally(() => clearTimeout(idleTimer));
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (json) {
        if (buf.length > MAX_SSE_BUFFER) throw new LlmError('模型输出过长，请重试。', false);
        if (!done) continue;
        let response: unknown;
        try {
          response = JSON.parse(buf);
        } catch {
          throw new LlmError('模型返回了无效的 JSON 回复，请重试。');
        }
        onMetadata(responseMetadata(response));
        content = decodeJsonCompletion(response);
        break;
      }
      const parsed = consumeSseChunk(buf, done, onMetadata);
      if (finished && parsed.content) throw invalidSse();
      content += parsed.content;
      if (onToken && parsed.content) onToken(parsed.content);
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

  if (content.length > MAX_CONTENT_LENGTH) throw new LlmError('模型输出过长，请重试。', false);
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

// 降级只在**昂贵**的那一族失败上触发：网关自己的超时（524/408）、单次尝试的首字节或停滞
// 上限到点、总超时——这些要么已经烧掉大段时间，要么说明这条路由卡住不动，只靠原地重试治不住。
//
// 连接失败（UPSTREAM_UNREACHABLE）刻意**不**降级：实测那族是**本机到网关的连接层**问题
// （12 次不含模型的 GET /v1/models 里 7 次失败，跨 6 个以上模型路由命中），~10s fail-fast、
// 重试极便宜，而且**换模型也一样**——它对所有模型一视同仁，所以原地重试才是对的解法。
//
// 上游答复的其它状态码（含 503 model_not_found、429、500）、空正文、截断、内容过滤都是关于
// **这个模型**的语义结论，换个模型只会拿到同一个答案——在那些错误上绝不降级。
//
// 注意它刻意不复用 LlmError.retryable：那个字段还包含 429/5xx 这类「同一个模型现在忙」的
// 判断，语义是「值得为同一个模型再花一次预算」，与「该换模型了」不是一回事。
//
// 首字节超时（UPSTREAM_FIRST_BYTE_TIMEOUT）也在这个集合里：chatRobust 会**先**原地重发主模型
// 一次，重发仍失败才走到这里降级——重试是这条路的前半段，不是它的替代品（见 chatRobust）。
function fallbackEligible(error: unknown): boolean {
  return error instanceof LlmError
    && (error.code === UPSTREAM_STALLED || error.code === UPSTREAM_FIRST_BYTE_TIMEOUT);
}

// 首次调用、等待和唯一一次重试共享截止时间，绝不重新获得完整预算。
// 调用方可传入 totalTimeoutMs 用请求级 deadline 派生的子预算来封顶本次调用的总时限；
// 未传则回退到配置值（如内部预算），保持向后兼容。onToken 增量原样透传到每次实际请求。
//
// fallbackModel（可选，缺省不开启）：主模型卡住时用它顶替原本的「重试」那一次机会。
// 之所以是**顶替**而不是叠加，是为了保住调用次数上界：find 的 modelStep 会调用本函数最多两次，
// 本函数内部最多两次上游请求，所以单步最多 4 次上游调用——与加兜底之前完全一致（不是 8 次）。
//
// 🔴 2026-09-17 起首字节超时是**唯一**的例外，上界因此变成 6（见 chatRobust 里首字节那条分支的注释）。
//
// idleTimeoutMs / firstByteTimeoutMs 是**单次尝试**的上限（停滞与首字节），只压主模型这一路：
// 它们的作用是「别让一个卡住的主模型吃光整步预算，以致兜底根本没机会跑」。兜底模型是最后机会，
// 只受共享截止时间约束——给它再套一个 45s 的停滞上限，会把「慢但确实在出字」的兜底一起误杀。
export async function chatRobust(
  system: string,
  user: string,
  opts: Pick<ChatOptions,
    'temperature' | 'maxTokens' | 'signal' | 'stream' | 'onUsage' | 'totalTimeoutMs' | 'onToken'
    | 'idleTimeoutMs' | 'firstByteTimeoutMs'> & {
    fallbackModel?: string;
  } = {},
): Promise<ChatResult> {
  const { fallbackModel, temperature, maxTokens, signal, stream, onUsage, onToken } = opts;
  const budgetMs = opts.totalTimeoutMs != null
    ? Math.min(opts.totalTimeoutMs, MAX_ROBUST_BUDGET_MS)
    : Math.min(configuredTotalTimeoutMs(), MAX_ROBUST_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const remainingMs = () => deadline - Date.now();
  // 观测上下文（usage_details 的键）：跨本函数内多次尝试共享，让线上能回答
  // 「首字节超时后重发有没有发生、有没有成功」。firstByteTimeouts 只给**基数**——
  // 本次尝试自己那一次由 chat 判定后加上（见 observationFor），所以不会重复计数。
  const observed = { attempts: 0, firstByteTimeouts: 0, retried: false, fallbackUsed: false };
  const attemptContext = (over: Partial<typeof observed> = {}) => {
    Object.assign(observed, over);
    observed.attempts += 1;
    return { ...observed };
  };
  const primary = {
    temperature, maxTokens, signal, stream, onUsage, onToken,
    idleTimeoutMs: opts.idleTimeoutMs,
    firstByteTimeoutMs: opts.firstByteTimeoutMs,
    totalTimeoutMs: budgetMs,
  };
  try {
    return await chat(system, user, { ...primary, attemptContext: attemptContext() });
  } catch (first) {
    if (opts.signal?.aborted) throw cancelledError();
    let error: unknown = first;
    // 首字节超时：**先用主模型原地重发一次，仍失败才降级**。
    //
    // 依据（2026-09-17 实测）：线上失败里 86% 是这一族（响应头 45s 内根本没到），而探针
    // n=15 次超时事件中**立刻重发有 8/15 = 53.3% 直接拿到正文、11/15 = 73.3% 至少拿到响应头**；
    // 对照无条件基线 70.8%。直接降级会白白丢掉这一半成功率，而换连接不需要任何额外依赖——
    // abort 掉的停滞连接不会被复用（T31 实测），普通重发天然就是新连接，所以**不引入 undici**。
    //
    // 🔴 代价与不变量：
    //   - 最坏上游调用数 4 → **6**：本函数 3 次（首发 + 首字节重发 + 兜底）× modelStep 2 次。
    //   - 重发**不新开预算**，拿的是共享 deadline 剩下的时间，且仍带着单次尝试上限
    //     （...primary 里的 firstByteTimeoutMs / idleTimeoutMs），所以它最多再烧一个 45s；
    //     兜底可用预算因此从 260−45 ≈ 215s 降到 260−45−45 ≈ **170s**，仍高于 opus 中位 115.8s。
    //   - 剩余预算不足就不发起（remainingMs() > 0，与下面原有的「重试」判定同一条约定）；
    //     重发本身再失败时，仍会走下面的兜底分支（那时兜底自己再看一次 MODEL_FALLBACK_MIN_BUDGET_MS）。
    //   - 这里**不等** retryDelay：探针的 53.3% 是在「立刻重发」的条件下测的，而且首发已经把
    //     45s 单次上限烧掉了，再等 1.5s 只是白花预算。
    if (first instanceof LlmError && first.code === UPSTREAM_FIRST_BYTE_TIMEOUT) {
      observed.firstByteTimeouts += 1;
      if (remainingMs() > 0) {
        const retryBudgetMs = remainingMs();
        try {
          return await chat(system, user, {
            ...primary, totalTimeoutMs: retryBudgetMs,
            attemptContext: attemptContext({ retried: true }),
          });
        } catch (retried) {
          if (opts.signal?.aborted) throw cancelledError();
          // 重发自己也首字节超时：同样计进累计值，否则兜底那一行会漏报一次。
          if (retried instanceof LlmError && retried.code === UPSTREAM_FIRST_BYTE_TIMEOUT) {
            observed.firstByteTimeouts += 1;
          }
          error = retried;
        }
      }
    }
    // 降级：主模型卡住时改用兜底模型，拿的是剩余预算，且不再套单次尝试上限（见上）。
    if (fallbackModel && fallbackEligible(error)) {
      const fallbackBudgetMs = remainingMs();
      if (fallbackBudgetMs <= MODEL_FALLBACK_MIN_BUDGET_MS) throw error;
      return chat(system, user, {
        temperature, maxTokens, signal, stream, onUsage, onToken,
        model: fallbackModel, totalTimeoutMs: fallbackBudgetMs,
        attemptContext: attemptContext({ fallbackUsed: true }),
      });
    }
    if (!(error instanceof LlmError) || !error.retryable) throw error;
    const delayMs = 1_500;
    if (remainingMs() <= delayMs) throw error;
    await retryDelay(delayMs, opts.signal);
    const retryBudgetMs = remainingMs();
    if (retryBudgetMs <= 0) throw error;
    return chat(system, user, {
      // 这条既有路径同样是「原地重发主模型」，所以 retried 一样置真（区分靠 errorCode）：
      // 线上就能一眼看出「这一行是某次重试」，不必去猜是哪条分支发的。
      ...primary, totalTimeoutMs: retryBudgetMs, attemptContext: attemptContext({ retried: true }),
    });
  }
}

// ---- 保存前验证（切换模型的护栏）----
// 2026-09-16 的找书故障就是「换成了一个不能用的模型」：验证要证明候选模型此刻真的能
// 出正文，而不是等 owner 保存完再让整个找书功能去试错。
// 独立短超时，不沿用路由的模型预算；失败只回可读原因，绝不回显上游正文。
//
// 2026-09-17 的修正（判据说谎）：旧探针用「只回一个词 / Say OK」+ 64 token 去问，模型
// 根本不需要思考，自然不吐 reasoning_content，于是把真推理模型（claude-opus-5-88）报成
// 「不是推理模型」——护栏在最需要它的场景下说谎。两处改动：
//   a) 探测问题改成需要分步计算的小题、预算提到 512：让模型**有机会**真的思考；
//   b) 判定改成三态：只有观测到思维链增量 / 网关自报 reasoning_tokens > 0 才说 'yes'，
//      观测不到只能说 'unknown'——一次小探测没有资格断言「不是推理模型」。
//
// 2026-09-17 的第二个修正（冷连接随机 502）：真实探测实测 5 次里有 3 次是**进程内第一个**
// 请求在 ~11s 被 undici 以 UND_ERR_CONNECT_TIMEOUT 掐掉（curl 与后续请求都正常，与 UA 无关），
// 于是模型明明能用，owner 点保存却拿到 502。下面在**同一个截止时间**内加一次重试：
// 两次尝试共享 MODEL_PROBE_TIMEOUT_MS，第二次拿到的是剩余预算而不是整份，所以探测墙钟
// 上限不变（仍是 MODEL_PROBE_TIMEOUT_MS）；重试只针对「上游一个字节都没答复」的传输层
// 失败，上游给出的 HTTP 状态、空正文、被截断都是关于这个模型的语义结论，不重试。
export const MODEL_PROBE_TIMEOUT_MS = 30_000;
export const MODEL_PROBE_MAX_TOKENS = 512;
// 重试前的等待；以及开第二次所需的最小剩余预算——只剩几百毫秒的请求只会把截止时间耗光。
export const MODEL_PROBE_RETRY_DELAY_MS = 500;
export const MODEL_PROBE_MIN_RETRY_MS = 3_000;
// 需要一两步推理的小题：非推理模型直接答，真推理模型会先出思维链。
export const MODEL_PROBE_SYSTEM = '你是模型连通性探测，只回答一个简单的分步计算题。';
export const MODEL_PROBE_USER =
  '一件商品单价 17 元，买 23 件；总价打 8 折后再减 5 元，最终应付多少元？先分步计算，最后一行只写数字。';

export interface ModelProbeResult {
  ok: boolean;
  /** 只有真的观测到思维链才是 'yes'；没观测到只能是 'unknown'（见 ReasoningVerdict）。 */
  reasoning: ReasoningVerdict;
  /** ok=false 时的可读原因；已脱敏，不含上游正文。 */
  reason: string;
  /** ok=true 时仍需提示 owner 的注意事项。 */
  warning: string;
}

const REASONING_PROBE_WARNING =
  '该模型是推理模型：思维链与正文共享 max_tokens，会把单次找书拖慢（2026-09-16 的找书故障就是这个征兆）。'
  + `探测预算（${MODEL_PROBE_MAX_TOKENS} token）已被思维链用尽，正式调用请确认 LLM_MAX_TOKENS 足够。`;

// 判据只接受「观测到的证据」：思维链增量，或网关自己报的 reasoning_tokens > 0。
// 两者都没有时返回 'unknown'，绝不返回 'no'——本次探测可能只是没触发思考。
function reasoningVerdict(observedDelta: boolean, observedReasoningTokens: number): ReasoningVerdict {
  return observedDelta || observedReasoningTokens > 0 ? 'yes' : 'unknown';
}

// 只重试「上游一个字节都没答复」：连接失败、读流超时、没有响应体（UPSTREAM_UNREACHABLE）。
// 上游答复了失败状态码（404/429/5xx…）或出了正文只是不合要求（空正文、被截断），都是关于
// 这个模型的语义结论，换一次请求只会拿到同一个答案，重试纯属拖时间——尤其是 429 与 5xx，
// LlmError.retryable 为真也不该在这里重试。
function probeRetryable(error: unknown): boolean {
  return error instanceof LlmError && error.code === UPSTREAM_UNREACHABLE;
}

export async function probeModel(model: string): Promise<ModelProbeResult> {
  // 两次尝试共享这一个截止时间，谁也拿不到整份预算。
  const deadline = Date.now() + MODEL_PROBE_TIMEOUT_MS;
  let observedDelta = false;
  let observedReasoningTokens = 0;
  let error: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      if (deadline - Date.now() <= MODEL_PROBE_RETRY_DELAY_MS + MODEL_PROBE_MIN_RETRY_MS) break;
      await retryDelay(MODEL_PROBE_RETRY_DELAY_MS);
    }
    // 第二次用的是「截止时间还剩多少」，不是又一份 MODEL_PROBE_TIMEOUT_MS。
    const budgetMs = Math.max(1, deadline - Date.now());
    try {
      // 与正式调用同一条流式路径，避免"非流式能过、流式不能用"的假阳性。
      await chat(MODEL_PROBE_SYSTEM, MODEL_PROBE_USER, {
        model,
        maxTokens: MODEL_PROBE_MAX_TOKENS,
        totalTimeoutMs: budgetMs,
        idleTimeoutMs: budgetMs,
        temperature: 0,
        onReasoning: () => { observedDelta = true; },
        // 旁证：部分网关只在 usage 里报思维链 token。onUsage 在 finally 里回调，
        // 所以「正文被思维链吃光」这条失败路径也拿得到 usage。
        onUsage: (call) => {
          observedReasoningTokens = Math.max(observedReasoningTokens, reasoningTokenCount(call.usage));
        },
      });
      return {
        ok: true, reasoning: reasoningVerdict(observedDelta, observedReasoningTokens), reason: '', warning: '',
      };
    } catch (e) {
      // 观测证据跨尝试保留：第一次看到过思维链，第二次没看到，结论仍是推理模型。
      error = e;
      if (!probeRetryable(e)) break;
    }
  }
  const reasoning = reasoningVerdict(observedDelta, observedReasoningTokens);
  // 推理模型仍可能把 512 token 的探测预算全花在思维链上：上游已经正常返回并出了 token，
  // 说明模型本身可用（今天挂掉的是"正文为空 + 预算被思维链吃光"的正式调用，
  // 那是 LLM_MAX_TOKENS 的问题，不是模型不可用），所以判可用但给出提示。
  if (reasoning === 'yes' && error instanceof LlmError && error.code === 'OUTPUT_TRUNCATED') {
    return { ok: true, reasoning, reason: '', warning: REASONING_PROBE_WARNING };
  }
  const message = error instanceof LlmError ? error.message : '模型验证请求失败，请稍后重试。';
  return { ok: false, reasoning, reason: `模型验证失败：${message}`, warning: '' };
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
    // retryable=false：解析失败不是上游瞬时故障。文案不再写「请重试」，避免与标志矛盾、
    // 也避免把排查引向「再点一次就好」。真正的恢复由调用方（find 的 modelStep）决定。
    throw new LlmError('模型返回的 JSON 无法解析。', false);
  }
}
