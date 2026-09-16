// TypeScript port of zhaoshu-books/lib/source-fetch.mjs (batch 10).
// Keep redirects, body limits and the single request/body timeout in sync.
import { SourcePolicyError, validateSourceUrl } from './source-policy';

export const MAX_SOURCE_REDIRECTS = 3;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const SOURCE_TIMEOUT_MS = 8_000;

function cancelBody(response: Response, reason?: unknown) {
  if (response.body && !response.body.locked) void response.body.cancel(reason).catch(() => {});
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
  signal: parentSignal, timeoutMs = SOURCE_TIMEOUT_MS,
  maxRedirects = MAX_SOURCE_REDIRECTS, maxBytes = MAX_SOURCE_BYTES,
  beforeRequest,
}: {
  signal: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
}) {
  parentSignal.throwIfAborted();
  let current = validateSourceUrl(input).href;
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
      await beforeRequest?.(signal);
      signal.throwIfAborted();
      const pending = fetch(current, {
        redirect: 'manual', cache: 'no-store', signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; novel-finder-reader/1.0)' },
      });
      void pending.then((late) => { if (signal.aborted) cancelBody(late, signal.reason); }, () => {});
      response = await sourceAbortable(pending, signal);
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
