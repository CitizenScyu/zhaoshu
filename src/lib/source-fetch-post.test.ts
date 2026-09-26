import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText } from './source-fetch';
import { encodeToBytes } from './source-charset';

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
