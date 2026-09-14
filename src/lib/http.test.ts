import { describe, expect, it, vi } from 'vitest';
import { boundedPositiveInteger, MAX_BUSINESS_ID, readJsonBody, RequestBodyError } from './http';

function streamingRequest(stream: ReadableStream<Uint8Array>, headers?: HeadersInit) {
  return new Request('http://localhost/api/test', {
    method: 'POST', body: stream, headers, duplex: 'half',
  } as RequestInit);
}

describe('readJsonBody', () => {
  it('decodes split UTF-8 sequences and accepts the exact byte limit', async () => {
    const bytes = new TextEncoder().encode('{"title":"书😀"}');
    let offset = 0;
    const req = streamingRequest(new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }));
    expect(req.headers.has('content-length')).toBe(false);
    await expect(readJsonBody(req, bytes.length)).resolves.toEqual({ title: '书😀' });
  });

  it.each([undefined, { 'content-length': '1' }])('cancels an oversized streaming body with headers %s', async (headers) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let reads = 0;
    const req = streamingRequest(new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    }, { highWaterMark: 0 }), headers);

    await expect(readJsonBody(req, 12)).rejects.toMatchObject({
      message: 'request body too large', code: 'BODY_TOO_LARGE',
    });
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(req.body!.locked).toBe(false);
  });

  it('counts bytes instead of decoded string length', async () => {
    const raw = '{"x":"中文"}';
    const req = new Request('http://localhost', { method: 'POST', body: raw });
    await expect(readJsonBody(req, raw.length)).rejects.toBeInstanceOf(RequestBodyError);
  });

  it('rejects an oversized declared length before pulling the body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const req = streamingRequest(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { 'content-length': '1000' });
    await expect(readJsonBody(req, 10)).rejects.toBeInstanceOf(RequestBodyError);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['', 'null', '[]', '1', 'true', '"text"', '{"broken":'])('returns null for invalid/objectless JSON %s', async (body) => {
    const req = new Request('http://localhost', { method: 'POST', body });
    await expect(readJsonBody(req, 100)).resolves.toBeNull();
  });

  it('accepts an object without changing its fields', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: '{"id":7,"items":[1,2]}' });
    await expect(readJsonBody(req, 100)).resolves.toEqual({ id: 7, items: [1, 2] });
    await expect(readJsonBody(new Request('http://localhost'), 100)).resolves.toBeNull();
  });
});

describe('boundedPositiveInteger', () => {
  it.each([1, '1', MAX_BUSINESS_ID, String(MAX_BUSINESS_ID)])('accepts %s', (value) => {
    expect(boundedPositiveInteger(value)).toBe(Number(value));
  });

  it.each([
    undefined, null, true, false, {}, [1], '', ' ', ' 1', '1 ', '01', '+1',
    '1.5', 1.5, '1.0', '1e2', '0x10', 'Infinity', Infinity, NaN, -1, 0,
    MAX_BUSINESS_ID + 1, String(MAX_BUSINESS_ID + 1), Number.MAX_SAFE_INTEGER + 1,
  ])('rejects non-canonical or out-of-range integer %s', (value) => {
    expect(boundedPositiveInteger(value)).toBeNull();
  });

  it('enforces a smaller page bound without rounding', () => {
    expect(boundedPositiveInteger('10000', 10000)).toBe(10000);
    expect(boundedPositiveInteger('10001', 10000)).toBeNull();
    expect(boundedPositiveInteger('1.9', 10000)).toBeNull();
  });
});
