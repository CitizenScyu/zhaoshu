export class RequestBodyError extends Error {
  readonly code = 'BODY_TOO_LARGE';
}

// Business IDs use PostgreSQL serial/int columns, not arbitrary JS numbers.
export const MAX_BUSINESS_ID = 2_147_483_647;

export function boundedPositiveInteger(value: unknown, max = MAX_BUSINESS_ID): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : null;
}

export async function readJsonBody(
  req: Request,
  maxBytes: number,
  signal: AbortSignal = req.signal,
): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void req.body?.cancel().catch(() => {});
    throw new RequestBodyError('request body too large');
  }

  if (!req.body) return null;
  const reader = req.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Do not wait for a possibly stalled sender/cancel handler after the cap.
        void reader.cancel().catch(() => {});
        throw new RequestBodyError('request body too large');
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean.length <= maxLength ? clean : null;
}
