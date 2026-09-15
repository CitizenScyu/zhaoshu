import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CSRF_HEADER, isJsonContentType, verifySameOriginWrite } from './csrf';

function writeRequest(headers: Record<string, string | undefined>) {
  const merged: Record<string, string> = {
    'content-type': 'application/json',
    'x-nf-csrf': '1',
    origin: 'http://localhost',
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return new NextRequest('http://localhost/api/auth/login', { method: 'POST', headers: merged });
}

describe('same-origin write protection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts a same-origin JSON write with the fixed header', () => {
    expect(verifySameOriginWrite(writeRequest({}))).toBeNull();
  });

  it.each([
    ['missing header', { 'x-nf-csrf': undefined }],
    ['wrong header value', { 'x-nf-csrf': '0' }],
  ])('rejects the write when the header is %s', (_label, headers) => {
    const res = verifySameOriginWrite(writeRequest(headers));
    expect(res?.status).toBe(403);
    expect((res as Response).headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('rejects a missing Origin on cookie-capable writes', () => {
    const res = verifySameOriginWrite(writeRequest({ origin: undefined }));
    expect(res?.status).toBe(403);
  });

  it('rejects Origin: null from sandboxed or serialized documents', () => {
    const res = verifySameOriginWrite(writeRequest({ origin: 'null' }));
    expect(res?.status).toBe(403);
  });

  it('rejects cross-site origins', () => {
    for (const origin of ['https://evil.example', 'http://localhost:8080', 'https://localhost']) {
      const res = verifySameOriginWrite(writeRequest({ origin }));
      expect(res?.status).toBe(403);
    }
  });

  it('accepts an explicitly configured trusted origin', () => {
    vi.stubEnv('AUTH_TRUSTED_ORIGIN', 'https://novel-finder.example');
    const req = new NextRequest('https://deployed-host.example/api/auth/login', {
      method: 'POST',
      headers: { 'x-nf-csrf': '1', origin: 'https://novel-finder.example' },
    });
    expect(verifySameOriginWrite(req)).toBeNull();
  });

  it('keeps the header name stable for all callers', () => {
    expect(CSRF_HEADER).toBe('x-nf-csrf');
  });
});

describe('JSON content type gate', () => {
  it('accepts only application/json bodies', () => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
      expect(isJsonContentType(writeRequest({ 'content-type': contentType }))).toBe(true);
    }
  });

  it('rejects form and text bodies', () => {
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', '']) {
      expect(isJsonContentType(writeRequest({ 'content-type': contentType }))).toBe(false);
    }
    expect(isJsonContentType(writeRequest({ 'content-type': undefined }))).toBe(false);
  });
});
