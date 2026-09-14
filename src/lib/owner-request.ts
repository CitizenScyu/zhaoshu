// Construct the request before attaching the owner token. Redirects must not
// turn an allowed API request into a request to another origin or page.
export function createOwnerRequest(
  input: RequestInfo | URL,
  init: RequestInit,
  token: string,
  origin: string,
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
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return new Request(request, {
    headers,
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
  });
}
