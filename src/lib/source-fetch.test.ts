import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText, MAX_SOURCE_BYTES } from './source-fetch';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const options = () => ({ signal: new AbortController().signal });

describe('source fetch worker policy parity', () => {
  it('checks each redirect before sending a request, including relative redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('正文'));
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSourceText('https://book15.net/start', { ...options(), beforeRequest })).toEqual({ url: 'https://book15.net/next', text: '正文' });
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init.redirect === 'manual' && init.cache === 'no-store')).toBe(true);
  });

  it.each(['http://book15.net/a', 'https://book15.net.evil.invalid/a', 'https://@book15.net/a', 'https://127.0.0.1/a'])(
    'blocks redirect target %s before fetching it', async (location) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('stops redirect loops', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/' } })));
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('循环');
  });

  it('bounds redirects even when every location is new', async () => {
    let ordinal = 0;
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/hop' + ++ordinal } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('次数超限');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])('bounds declared and streamed bodies (declared=%s)', async (declared) => {
    const body = new Uint8Array(MAX_SOURCE_BYTES + 1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: declared ? { 'content-length': String(body.length) } : {} })));
    await expect(fetchSourceText('https://book15.net/', options())).rejects.toThrow('体积超限');
  });

  it('keeps a single deadline for headers, redirects and body even if the upstream ignores abort', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const result = fetchSourceText('https://book15.net/', { ...options(), timeoutMs: 100 });
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('propagates cancellation and does not begin an aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller left'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', { signal: controller.signal })).rejects.toThrow('caller left');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
