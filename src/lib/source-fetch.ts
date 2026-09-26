// TypeScript port of zhaoshu-books/lib/source-fetch.mjs (batch 10).
// Keep redirects, body limits and the single request/body timeout in sync.
import { alternateSourceHost, SourcePolicyError, validateSourceUrl } from './source-policy';
import { recordHostFailure, recordHostSuccess, type HostFailureKind } from './source-host-health';
import { charsetFromContentType, encodeToBytes, type SourceCharset } from './source-charset';

export const MAX_SOURCE_REDIRECTS = 3;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const SOURCE_TIMEOUT_MS = 8_000;
// 连接段（近似为 fetch settle，即 connect+响应头到达）独立上限：成功样本 connect ≤0.51s、
// TTFB ≤2.11s，3s 是紧但有余量的合并段（调研 §4）；卡在连接/TTFB 的请求等满总 8s 纯浪费预算。
export const SOURCE_CONNECT_TIMEOUT_MS = 3_000;
// 换 host 重试前的退避：抖动是秒级簇，0ms 连打另一 host 只是撞同一簇；复用 source-reader
// 的节流槽宽（350ms）。导出供调用方共享同一常量语义，避免两处漂移。
export const SOURCE_HOST_SWAP_DELAY_MS = 350;

function cancelBody(response: Response, reason?: unknown) {
  if (response.body && !response.body.locked) void response.body.cancel(reason).catch(() => {});
}

// 换 host 重试只对网络/传输层失败生效；HTTP 状态码与策略拒绝是拿到响应后的判定，
// 换 host 不改变结果（任务书与调研 §1.2 口径）。三类排除：
// - beforeRequest 钩子的失败（预算耗尽/节流中止）：调用方的停止指令，与路径无关；
//   标记而非 instanceof 是为了不引入 source-reader 的循环依赖。
// - 解码/解析类错误（TextDecoder fatal、JSON 解析）：内容侧问题，另一 host 同样内容。
// - abort（AbortError）：调用方主动取消。
interface BeforeRequestFailure { fromBeforeRequest?: boolean }

function isTransportError(error: unknown): boolean {
  if ((error as BeforeRequestFailure).fromBeforeRequest) return false;
  if (error instanceof SourcePolicyError || error instanceof SourceHttpError) return false;
  if (error instanceof DOMException) return error.name === 'TimeoutError' || error.name === 'ConnectTimeoutError';
  // 只认传输特征：undici 网络错误固定为 TypeError 且 message 前缀 fetch failed（含 cause
  // 链上的 ECONNRESET/ENOTFOUND 等）。TextDecoder 的 TypeError（非法 UTF-8）等其余 Error
  // 一律不换 host——4 次注定失败的物理请求比 1 次更糟（www-review-2 P2-2）。
  return error instanceof TypeError && /^fetch failed/i.test(error.message);
}

export function sourceAbortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

async function responseText(response: Response, signal: AbortSignal, maxBytes: number, charset: SourceCharset = 'utf-8') {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    cancelBody(response);
    throw new SourcePolicyError('书源响应体积超限');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  // utf-8 保持 fatal:true（改前语义，非法字节抛错、不换 host）；GBK 类 fatal:false 容忍杂散字节。
  const decoder = charset === 'utf-8'
    ? new TextDecoder('utf-8', { fatal: true })
    : new TextDecoder(charset, { fatal: false });
  let bytes = 0;
  let text = '';
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await sourceAbortable(reader.read(), signal);
      if (done) { complete = true; return text + decoder.decode(); }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new SourcePolicyError('书源响应体积超限');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!complete) void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  }
}

// 41-M1.3：算不算 host 的「传输层硬失败」。在换 host 的口径（isTransportError：连接/请求超时、fetch failed）
// 之外再加 HTTP 5xx（含 Cloudflare 522）：5xx 换 host 不改变结果所以不换，但它正是「这个站现在不行」的信号。
// 4xx、策略拒绝、解码错误、beforeRequest 的预算/节流中止都不算——那是内容侧或调用方的判定。
function hostFailureKind(error: unknown): HostFailureKind | null {
  if (typeof error !== 'object' || error === null) return null;
  if (error instanceof SourceHttpError) return error.status >= 500 ? 'http_5xx' : null;
  if (!isTransportError(error)) return null;
  return error instanceof DOMException ? 'timeout' : 'network';
}

/**
 * 引擎 POST 搜索（41-postsearch）的请求覆写：method/body/白名单头 + 请求体字符集。
 * 仅 ENGINE_POST_SEARCH 开时由 buildSourceSearchRequest 产出并传入；缺省 = 现有 GET/utf-8 路径。
 * body 只发在首跳；重定向一律降级为无 body 的 GET（避免跨 host 重放 POST body，且合乎浏览器 303 语义）。
 */
export interface SourcePageRequest {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  charset: SourceCharset;
}

interface FetchSourceOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
  /** POST/body/头覆写；缺省纯 GET。 */
  request?: SourcePageRequest;
  /** 响应解码字符集：显式字符集、或 'auto'（按 Content-Type，回退 utf-8）；缺省 utf-8（改前语义）。 */
  responseCharset?: SourceCharset | 'auto';
}

// 41-M1.3：主机级健康记忆（source-host-health.ts）的唯一记录点——builtin 与引擎两条腿的每次逻辑请求都经过这里。
// 换 host 兜底算同一次逻辑请求：任一 host 拿到正文即记成功；失败只按传输层硬失败计数（hostFailureKind），
// 记在初始 URL 的 host 上（apex 与 www 在健康记忆里是同一个站）。父 signal 已中止（调用方取消、切片到点）不计：
// 那是调用方的时间决定，不是 host 的健康信号。
export async function fetchSourceText(input: string, options: FetchSourceOptions) {
  options.signal.throwIfAborted();
  const initial = validateSourceUrl(input);
  try {
    const page = await fetchWithHostSwap(initial, options);
    recordHostSuccess(initial.hostname);
    return page;
  } catch (error) {
    const kind = options.signal.aborted ? null : hostFailureKind(error);
    if (kind) recordHostFailure(initial.hostname, kind);
    throw error;
  }
}

async function fetchWithHostSwap(initial: URL, {
  signal: parentSignal, timeoutMs = SOURCE_TIMEOUT_MS, connectTimeoutMs = SOURCE_CONNECT_TIMEOUT_MS,
  maxRedirects = MAX_SOURCE_REDIRECTS, maxBytes = MAX_SOURCE_BYTES,
  beforeRequest, request, responseCharset,
}: FetchSourceOptions) {
  const swapped = swapHost(initial);
  try {
    return await attemptOnce(initial, {
      signal: parentSignal, timeoutMs, connectTimeoutMs, maxRedirects, maxBytes, beforeRequest, request, responseCharset,
    });
  } catch (error) {
    // 4xx/5xx/策略拒绝：源站行为或响应侧判定，换 host 不改变结果，原样上抛；
    // 网络层失败且确有备用 host 时，退避后换 host 整体重试一次（同一次逻辑请求，见下）。
    parentSignal.throwIfAborted();
    if (!isTransportError(error) || !swapped) throw error;
    await sourceHostSwapDelay(parentSignal);
    parentSignal.throwIfAborted();
    return await attemptOnce(swapped, {
      signal: parentSignal, timeoutMs, connectTimeoutMs, maxRedirects, maxBytes, beforeRequest, request, responseCharset,
      skipFirstBeforeRequest: true,
    });
  }
}

// 抖动是秒级簇，换 host 前 0ms 连打只会撞同一簇；退避一拍再换路。
// 不与 page() 的节流叠加：那里 nextRequestAt 已罩住常规请求间隔，这里是失败重试的额外一拍。
function sourceHostSwapDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, SOURCE_HOST_SWAP_DELAY_MS);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function swapHost(url: URL): URL | null {
  const alternate = alternateSourceHost(url.hostname);
  if (!alternate) return null;
  const next = new URL(url.href);
  next.hostname = alternate;
  return next;
}

async function attemptOnce(start: URL, {
  signal: parentSignal, timeoutMs, connectTimeoutMs, maxRedirects, maxBytes, beforeRequest, request, responseCharset,
  skipFirstBeforeRequest = false,
}: {
  signal: AbortSignal;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
  request?: SourcePageRequest;
  responseCharset?: SourceCharset | 'auto';
  /** 换 host 重试的首次请求：与失败的那次是同一逻辑请求，预算/节流不重复扣。 */
  skipFirstBeforeRequest?: boolean;
}) {
  let current = start.href;
  const visited = new Set([current]);
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('书源请求及正文读取超时', 'TimeoutError')), timeoutMs);
  const signal = controller.signal;
  // POST/body/头只用于首个 HTTP 跳；重定向后一律降级为无 body 的 GET。
  const bodyBytes = request?.body !== undefined ? encodeToBytes(request.body, request.charset) : undefined;
  let response: Response | undefined;
  try {
    for (let redirects = 0; ; redirects += 1) {
      signal.throwIfAborted();
      if (redirects > 0 || !skipFirstBeforeRequest) {
        try { await beforeRequest?.(signal); }
        catch (error) { (error as BeforeRequestFailure).fromBeforeRequest = true; throw error; }
      }
      signal.throwIfAborted();
      const connectTimer = setTimeout(() => {
        controller.abort(new DOMException('书源连接超时', 'ConnectTimeoutError'));
      }, connectTimeoutMs);
      const firstHop = redirects === 0;
      const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (compatible; novel-finder-reader/1.0)' };
      if (firstHop && request?.headers) Object.assign(headers, request.headers);
      const pending = fetch(current, {
        redirect: 'manual', cache: 'no-store', signal, headers,
        method: firstHop ? request?.method ?? 'GET' : 'GET',
        body: (firstHop && request?.method === 'POST' ? bodyBytes : undefined) as BodyInit | undefined,
      });
      void pending.then((late) => { if (signal.aborted) cancelBody(late, signal.reason); }, () => {});
      try {
        response = await sourceAbortable(pending, signal);
      } finally {
        clearTimeout(connectTimer);
      }
      if (response.redirected) throw new SourcePolicyError('书源响应发生未受控跳转');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        cancelBody(response);
        if (!location) throw new SourcePolicyError('书源跳转缺少 Location');
        if (redirects >= maxRedirects) throw new SourcePolicyError('书源跳转次数超限');
        const next = validateSourceUrl(location, current).href;
        if (visited.has(next)) throw new SourcePolicyError('书源跳转形成循环');
        visited.add(next);
        current = next;
        continue;
      }
      if (!response.ok) throw new SourceHttpError(response.status, parseRetryAfterMs(response.headers.get('retry-after')));
      // 解码字符集：显式字符集优先；'auto' 按 Content-Type 嗅探（回退 utf-8）；缺省 utf-8（改前语义）。
      const charset: SourceCharset = responseCharset && responseCharset !== 'auto'
        ? responseCharset
        : responseCharset === 'auto'
          ? charsetFromContentType(response.headers.get('content-type')) ?? 'utf-8'
          : 'utf-8';
      const text = await responseText(response, signal, maxBytes, charset);
      signal.throwIfAborted();
      return { url: current, text };
    }
  } finally {
    if (response) cancelBody(response, signal.reason);
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onAbort);
  }
}

export class SourceHttpError extends Error {
  // retryAfterMs：源站 Retry-After 头（429/503 等）解析成的毫秒退避；缺省/不可解析为 undefined。
  // 只保留状态与退避量，绝不透传响应体（可能含服务端回显）。
  constructor(readonly status: number, readonly retryAfterMs?: number) { super('书源 HTTP ' + status); }
}

/**
 * 解析 HTTP Retry-After 头 → 毫秒。支持两种形态（RFC 7231 §7.1.3）：
 * 纯秒（`Retry-After: 120`）与 HTTP-date（`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`）。
 * 无值/非法/负值 → undefined（由调用方决定不带退避）。
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? delta : 0;
}
