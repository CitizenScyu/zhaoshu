/**
 * 凭据运输方式（设计 §6.2/§6.3）：
 * - `owner-header`：旧模式，把本机保存的口令放进 Authorization。
 * - `cookie`：账号模式，不附任何显式凭据，只由浏览器携带同源 Cookie。
 */
export type AuthTransport = 'owner-header' | 'cookie';

// Construct the request before attaching the owner token. Redirects must not
// turn an allowed API request into a request to another origin or page.
export function createOwnerRequest(
  input: RequestInfo | URL,
  init: RequestInit,
  token: string,
  origin: string,
  transport: AuthTransport = 'owner-header',
): Request {
  const raw = input instanceof Request ? input.url : String(input);
  if (raw.trimStart().startsWith('//') || /[\\\x00-\x1f\x7f]/.test(raw)) {
    throw new TypeError('Owner requests require a same-origin /api URL');
  }

  const base = new URL(origin);
  const url = new URL(raw, base.origin);
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.origin !== base.origin
    || url.username || url.password
    || (url.pathname !== '/api' && !url.pathname.startsWith('/api/'))
  ) {
    throw new TypeError('Owner requests require a same-origin /api URL');
  }

  const request = new Request(input instanceof Request ? input : url, init);
  const headers = new Headers(request.headers);
  headers.delete('x-owner-token');
  headers.delete('Authorization');
  // Cookie 模式显式不带显式凭据；旧模式才附 owner 头。
  if (transport === 'owner-header' && token) headers.set('Authorization', `Bearer ${token}`);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) headers.set('X-NF-CSRF', '1');

  return new Request(request, {
    headers,
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
  });
}
