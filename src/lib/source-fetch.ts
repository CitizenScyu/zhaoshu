// TypeScript port of zhaoshu-books/lib/source-fetch.mjs (batch 10).
// Keep redirects, body limits and the single request/body timeout in sync.
import { alternateSourceHost, SourcePolicyError, validateSourceUrl } from './source-policy';

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

async function responseText(response: Response, signal: AbortSignal, maxBytes: number) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    cancelBody(response);
    throw new SourcePolicyError('书源响应体积超限');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
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

export async function fetchSourceText(input: string, {
  signal: parentSignal, timeoutMs = SOURCE_TIMEOUT_MS, connectTimeoutMs = SOURCE_CONNECT_TIMEOUT_MS,
  maxRedirects = MAX_SOURCE_REDIRECTS, maxBytes = MAX_SOURCE_BYTES,
  beforeRequest,
}: {
  signal: AbortSignal;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
}) {
  parentSignal.throwIfAborted();
  const initial = validateSourceUrl(input);
  const swapped = swapHost(initial);
  try {
    return await attemptOnce(initial, {
      signal: parentSignal, timeoutMs, connectTimeoutMs, maxRedirects, maxBytes, beforeRequest,
    });
  } catch (error) {
    // 4xx/5xx/策略拒绝：源站行为或响应侧判定，换 host 不改变结果，原样上抛；
    // 网络层失败且确有备用 host 时，退避后换 host 整体重试一次（同一次逻辑请求，见下）。
    parentSignal.throwIfAborted();
    if (!isTransportError(error) || !swapped) throw error;
    await sourceHostSwapDelay(parentSignal);
    parentSignal.throwIfAborted();
    return await attemptOnce(swapped, {
      signal: parentSignal, timeoutMs, connectTimeoutMs, maxRedirects, maxBytes, beforeRequest,
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
  signal: parentSignal, timeoutMs, connectTimeoutMs, maxRedirects, maxBytes, beforeRequest,
  skipFirstBeforeRequest = false,
}: {
  signal: AbortSignal;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
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
      const pending = fetch(current, {
        redirect: 'manual', cache: 'no-store', signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; novel-finder-reader/1.0)' },
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
      if (!response.ok) throw new SourceHttpError(response.status);
      const text = await responseText(response, signal, maxBytes);
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
  constructor(readonly status: number) { super('书源 HTTP ' + status); }
}
