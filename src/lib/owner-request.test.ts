import { describe, expect, it } from 'vitest';
import { createOwnerRequest } from './owner-request';

const ORIGIN = 'https://books.example';

describe('createOwnerRequest', () => {
  it.each([
    '/api', '/api/library?page=2', `${ORIGIN}/api/profile`,
    new URL('/api/shelf', ORIGIN), new Request(`${ORIGIN}/api/stats`),
  ])('attaches the token to allowed input %s', (input) => {
    const req = createOwnerRequest(input, {}, 'owner-test', ORIGIN);
    expect(new URL(req.url).origin).toBe(ORIGIN);
    expect(req.headers.get('Authorization')).toBe('Bearer owner-test');
  });

  it.each([
    'https://outside.example/api/profile',
    '//outside.example/api/profile', `//books.example/api/profile`,
    '/profile', '/api-other', '/api/../profile', '/api/%2e%2e/profile',
    'http://books.example/api/profile', 'https://books.example:444/api/profile',
    'https://books.example.outside.example/api/profile',
    'https://user:password@books.example/api/profile',
    '\\\\outside.example\\api\\profile', '/\\outside.example/api/profile',
    ' /\n/outside.example/api/profile', 'data:text/plain,hello',
    new URL('https://outside.example/api/profile'),
    new URL('/profile', ORIGIN),
    new Request('https://outside.example/api/profile'),
    new Request(`${ORIGIN}/profile`),
  ])('rejects unsafe input %s before constructing an authenticated request', (input) => {
    expect(() => createOwnerRequest(input, {}, 'owner-test', ORIGIN)).toThrow(TypeError);
  });

  it('preserves a Request body, method, headers and cancellation', async () => {
    const controller = new AbortController();
    const input = new Request(`${ORIGIN}/api/shelf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'test' },
      body: JSON.stringify({ labeledBookId: 7 }),
      signal: controller.signal,
    });
    const req = createOwnerRequest(input, {}, 'owner-test', ORIGIN);
    expect(req.method).toBe('POST');
    expect(req.headers.get('Content-Type')).toBe('application/json');
    expect(req.headers.get('X-Trace')).toBe('test');
    expect(await req.json()).toEqual({ labeledBookId: 7 });
    controller.abort();
    expect(req.signal.aborted).toBe(true);
  });

  it('honors RequestInit overrides while forcing the safe fetch policy', () => {
    const input = new Request(`${ORIGIN}/api/profile`, {
      headers: { Authorization: 'Bearer old', 'X-Trace': 'original' },
    });
    const req = createOwnerRequest(input, {
      method: 'PUT',
      headers: { 'X-Trace': 'override', 'x-owner-token': 'stale' },
      redirect: 'follow', credentials: 'include', mode: 'cors', cache: 'no-store',
    }, 'new-owner', ORIGIN);
    expect(req.method).toBe('PUT');
    expect(req.headers.get('X-Trace')).toBe('override');
    expect(req.headers.get('Authorization')).toBe('Bearer new-owner');
    expect(req.headers.has('x-owner-token')).toBe(false);
    expect(req.redirect).toBe('error');
    expect(req.credentials).toBe('same-origin');
    expect(req.mode).toBe('same-origin');
    expect(req.cache).toBe('no-store');
  });

  it('removes inherited credentials after logout', () => {
    const input = new Request(`${ORIGIN}/api/profile`, {
      headers: { Authorization: 'Bearer old', 'x-owner-token': 'old' },
    });
    const req = createOwnerRequest(input, {}, '', ORIGIN);
    expect(req.headers.has('Authorization')).toBe(false);
    expect(req.headers.has('x-owner-token')).toBe(false);
  });
});
