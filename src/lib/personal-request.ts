import type { NextRequest } from 'next/server';
import type { Principal } from './auth-types';
import { requirePermission, revalidatePermission } from './auth';
import { AUTH_NO_STORE_HEADERS, authError } from './auth-http';
import { getSessionTokenFromRequest, getAuthSecuritySecret, hashSessionToken, ownerCredentialTag } from './auth-session';
import { isJsonContentType, verifySameOriginWrite } from './csrf';
import { createDeadline, DeadlineExceededError } from './deadline';
import { RequestBodyError } from './http';
import { getSql } from './db';
import { authorizedTransaction, AuthorizationRevokedError, type PersonalWriter, type WriteAuthorization } from './personal-write';

class AuthResponseError extends Error {
  constructor(readonly response: Response) { super('authorization failed'); }
}

export function personalError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof DeadlineExceededError || (error && typeof error === 'object' && 'code' in error && error.code === '57014')) {
    return { status: 504, code: 'DEADLINE_EXCEEDED', message: '请求预算已耗尽，请稍后重试。' };
  }
  if (error instanceof AuthResponseError) return { status: error.response.status, code: 'AUTHORIZATION_CHANGED', message: '授权已改变，请重新验证身份。' };
  if (error instanceof AuthorizationRevokedError) return { status: 403, code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'AbortError') return { status: 499, code: 'REQUEST_CANCELLED', message: '请求已取消。' };
  if (error instanceof RequestBodyError) return { status: 413, code: error.code, message: error.message };
  return { status: 500, code: 'INTERNAL', message: 'internal error' };
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(AUTH_NO_STORE_HEADERS)) headers.set(key, value);
  if (headers.get('content-type')?.includes('text/event-stream')) headers.set('Cache-Control', 'private, no-store, no-transform');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export class PersonalRequest {
  readonly deadline;
  readonly signal: AbortSignal;
  private readonly cancellation = new AbortController();
  private streaming = false;
  private originalToken: string | null = null;
  principal!: Readonly<Principal>;

  constructor(readonly request: NextRequest, budgetMs: number) {
    this.deadline = createDeadline(budgetMs);
    this.signal = AbortSignal.any([request.signal, this.deadline.signal, this.cancellation.signal]);
  }
  assertActive = () => { this.deadline.assert(); this.signal.throwIfAborted(); };
  run = async <T>(task: () => Promise<T>): Promise<T> => {
    this.assertActive();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => { this.signal.removeEventListener('abort', aborted); reject(this.signal.reason); };
      this.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { this.assertActive(); return task(); }).then(
        (value) => { this.signal.removeEventListener('abort', aborted); try { this.assertActive(); resolve(value); } catch (error) { reject(error); } },
        (error) => { this.signal.removeEventListener('abort', aborted); reject(error); },
      );
    });
  };
  async authorize(): Promise<Response | null> {
    const auth = await this.run(() => requirePermission(this.request, 'find', this.signal));
    if (!auth.ok) return auth.response;
    this.principal = Object.freeze({ ...auth.principal });
    this.originalToken = getSessionTokenFromRequest(this.request);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(this.request.method)) {
      if (this.principal.authMethod === 'session' || this.request.headers.has('origin')) {
        const csrf = verifySameOriginWrite(this.request);
        if (csrf) return csrf;
      }
      if ((this.principal.authMethod === 'session' || this.request.headers.has('origin')) &&
          ['POST', 'PUT', 'PATCH'].includes(this.request.method) && !isJsonContentType(this.request)) {
        return authError(415, 'JSON_REQUIRED', 'application/json is required');
      }
    }
    return null;
  }
  async commit<T>(operation: (write: PersonalWriter) => Promise<T>): Promise<T> {
    this.assertActive();
    if (getSessionTokenFromRequest(this.request) !== this.originalToken) throw new AuthorizationRevokedError();
    const auth = await this.run(() => revalidatePermission(this.request, this.principal, 'find', this.signal));
    if (!auth.ok) throw new AuthResponseError(auth.response);
    this.assertActive();
    const { userId, role, authMethod } = this.principal;
    const authorization: WriteAuthorization = {
      userId, role, method: authMethod,
      tokenHash: authMethod === 'session' && this.originalToken ? hashSessionToken(this.originalToken) : null,
      ownerTag: role === 'owner' && authMethod === 'session'
        ? ownerCredentialTag(getAuthSecuritySecret()!, process.env.APP_OWNER_TOKEN!) : null,
      expiresAt: new Date(this.deadline.startedAt + this.deadline.budgetMs).toISOString(),
    };
    const write: PersonalWriter = (batch) => {
      this.assertActive();
      return authorizedTransaction(getSql(), authorization, batch, this.signal);
    };
    return this.run(() => operation(write));
  }
  sse(work: (emit: (event: unknown) => void) => Promise<void>, mapError = personalError): Response {
    this.streaming = true;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const emit = (event: unknown) => { this.assertActive(); controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
        try { await work(emit); }
        catch (error) {
          if (!this.cancellation.signal.aborted) {
            const mapped = mapError(error);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', code: mapped.code, message: mapped.message })}\n\n`));
          }
        } finally {
          this.deadline.dispose();
          try { controller.close(); } catch { /* 客户端可能已经关闭流。 */ }
        }
      },
      cancel: () => { this.cancellation.abort(new DOMException('stream cancelled', 'AbortError')); this.deadline.dispose(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' } });
  }
  finish() { if (!this.streaming) this.deadline.dispose(); }
}

// 每个个人路由方法的入口先开始预算，再验证身份/能力；流结束前预算保持有效。
export async function withFindAccess(req: NextRequest, budgetMs: number, handler: (access: PersonalRequest) => Promise<Response>): Promise<Response> {
  const access = new PersonalRequest(req, budgetMs);
  try {
    const rejected = await access.authorize();
    return privateResponse(rejected ?? await handler(access));
  } catch (error) {
    if (error instanceof AuthResponseError) return privateResponse(error.response);
    const mapped = personalError(error);
    return authError(mapped.status, mapped.code, mapped.message);
  } finally { access.finish(); }
}
