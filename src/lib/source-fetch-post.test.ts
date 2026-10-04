import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText } from './source-fetch';
import { encodeToBytes } from './source-charset';
import { buildSourceSearchRequest } from './source-parser';

// request640：source-fetch 增设退休 builtin 请求许可门，真实注册表里 book15 lifecycle='retired'。
// 本文件全部用例以 book15.net 为合成载体测 POST/跳转/字符集的传输合同，不测生命周期——
// 把退休门钉成 false（等价「book15 仍活跃」的注册表形态，同 source-fetch.test.ts 上方两组）；
// 退休门自身的行为断言见 source-fetch.test.ts 的「退休 builtin 请求许可门」专组。
vi.mock('./supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supported-sources')>();
  return { ...actual, isRetiredBuiltinHost: () => false };
});

afterEach(() => { vi.unstubAllGlobals(); });
const base = () => ({ signal: new AbortController().signal });

describe('source-fetch POST/charset（41-postsearch）', () => {
  it('POST：method 与 body 发到首跳', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSourceText('https://book15.net/s', {
      ...base(),
      request: { method: 'POST', body: 'searchkey=%BD%A3', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, charset: 'gbk' },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(new TextDecoder().decode(init.body)).toBe('searchkey=%BD%A3');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it.each([307, 308])('POSTREDIR53: 同origin %s链保留表单/JSON的编码字节和请求头', async (status) => {
    for (const body of ['searchkey={{key}}', '{"key":"{{key}}"}']) {
      const request = buildSourceSearchRequest('https://book15.net/s,' + JSON.stringify({
        method: 'POST', body, charset: 'gb2312', headers: { Referer: 'https://book15.net/index' },
      }), '合成书', 'https://book15.net');
      const expectedBody = encodeToBytes(request.body!, request.charset);
      const fetchMock = vi.fn().mockImplementation(async (url, init) => {
        if (url === request.url) return new Response(null, { status, headers: { location: '/middle' } });
        const valid = init.method === 'POST' && Buffer.from(init.body ?? []).equals(Buffer.from(expectedBody))
          && init.headers['Content-Type'] === request.headers!['Content-Type'] && init.headers.Referer === request.headers!.Referer;
        if (!valid) return new Response('合成搜索需要POST关键词', { status: 405 });
        return url === 'https://book15.net/middle'
          ? new Response(null, { status: 308, headers: { location: '/result' } }) : new Response('合成搜索结果');
      });
      vi.stubGlobal('fetch', fetchMock);
      const beforeRequest = vi.fn().mockResolvedValue(undefined);
      expect(await fetchSourceText(request.url, { ...base(), request, beforeRequest }))
        .toEqual({ url: 'https://book15.net/result', text: '合成搜索结果' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(beforeRequest).toHaveBeenCalledTimes(3);
    }
  });

  it.each([[301, false], [302, false], [303, false], [307, true], [308, true]] as const)
    ('POSTREDIR53: %s跨origin=%s降GET后不因返回原站而恢复body或头', async (status, crossOrigin) => {
      const middle = `https://${crossOrigin ? 'www.book15.net' : 'book15.net'}/middle`;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status, headers: { location: middle } }))
        .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: 'https://book15.net/result' } }))
        .mockResolvedValueOnce(new Response('合成结果'));
      vi.stubGlobal('fetch', fetchMock);
      const request = buildSourceSearchRequest('https://book15.net/s,' + JSON.stringify({
        method: 'POST', body: 'k={{key}}', headers: { Referer: 'https://book15.net/index', 'User-Agent': 'synthetic-agent' },
      }), '合成书', 'https://book15.net');
      await fetchSourceText(request.url, { ...base(), request });
      expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET', 'GET']);
      for (const [, init] of fetchMock.mock.calls.slice(1)) {
        expect(init.body).toBeUndefined();
        expect(init.headers['Content-Type']).toBeUndefined();
        expect(init.headers.Referer).toBeUndefined();
        expect(init.headers['User-Agent']).not.toBe('synthetic-agent');
      }
    });

  it.each([307, 308])('POSTREDIR53: %s不能把POST带向host门外', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status, headers: { location: 'https://not-approved.invalid/search' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/s', {
      ...base(), request: { method: 'POST', body: 'k=synthetic', charset: 'utf-8' },
    })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('POSTREDIR53: GET的307仍不续传仅供首跳的自定义头', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/result' } }))
      .mockResolvedValueOnce(new Response('结果'));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSourceText('https://book15.net/s', { ...base(), request: {
      method: 'GET', charset: 'utf-8', headers: { Referer: 'https://book15.net/index' },
    } });
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.Referer).toBeUndefined();
  });

  it('响应按显式 gbk 解码', async () => {
    const body = encodeToBytes('剑来搜索结果', 'gbk');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const page = await fetchSourceText('https://book15.net/s', { ...base(), responseCharset: 'gbk' });
    expect(page.text).toBe('剑来搜索结果');
  });

  it("responseCharset='auto' 按 Content-Type 嗅探 gbk", async () => {
    const body = encodeToBytes('圣墟', 'gbk');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/html; charset=gbk' } })));
    const page = await fetchSourceText('https://book15.net/s', { ...base(), responseCharset: 'auto' });
    expect(page.text).toBe('圣墟');
  });

  it("responseCharset='auto' 无 charset 头时回退 utf-8", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('普通 utf8 正文', { headers: { 'content-type': 'text/html' } })));
    const page = await fetchSourceText('https://book15.net/s', { ...base(), responseCharset: 'auto' });
    expect(page.text).toBe('普通 utf8 正文');
  });

  it('POST 遇 302 重定向后降级为无 body 的 GET', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/result' } }))
      .mockResolvedValueOnce(new Response('结果'));
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchSourceText('https://book15.net/s', {
      ...base(), request: { method: 'POST', body: 'k=x', charset: 'utf-8' },
    });
    expect(page).toEqual({ url: 'https://book15.net/result', text: '结果' });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it('缺省（无 request/charset）= 现有 GET/utf-8 行为', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('正文'));
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchSourceText('https://book15.net/s', base());
    expect(page.text).toBe('正文');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});
