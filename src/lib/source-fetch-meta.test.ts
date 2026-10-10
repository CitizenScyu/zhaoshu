import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceText, SOURCE_HOST_SWAP_DELAY_MS } from './source-fetch';
import { refreshSupportedHosts } from './source-policy';
import { encodeToBytes, type SourceCharset } from './source-charset';

// book15 在 supported-sources 静态注册表里 lifecycle='retired'，许可门会在物理发射前拒绝；
// 本文件测的是响应字符集/meta 探测的传输语义，载体统一用合成活跃 host e1.test
// （beforeEach 注册、afterEach 复位，不跨用例污染）。
beforeEach(() => { refreshSupportedHosts(['e1.test']); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); refreshSupportedHosts([]); });
const signal = () => new AbortController().signal;
const html = (head: string) => `<!doctype html><html><head>${head}</head><body>合成正文</body></html>`;
const request = (options: Partial<Parameters<typeof fetchSourceText>[1]> = {}) =>
  fetchSourceText('https://e1.test/meta', { signal: signal(), responseCharset: 'auto', ...options });
function serve(text: string, charset: SourceCharset = 'utf-8', contentType = 'text/html') {
  const mock = vi.fn().mockResolvedValue(new Response(encodeToBytes(text, charset), { headers: { 'content-type': contentType } }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('META53: 有界HTML head响应字符集', () => {
  it.each([
    '<meta charset="gbk">', "<META CHARSET='GB2312'>", '<meta charset=gbk>',
    '<meta content="text/html; charset=gbk" http-equiv="Content-Type">',
    '<meta http-equiv="content-type" content="text/html;charset=gbk">',
    '<title>合成标题</title><meta charset=gbk>',
    '<script>const x="<meta charset=utf-8>";</script><meta charset=gbk>',
    '<!-- <meta charset=utf-8> --><meta charset=gbk>',
    '<meta charset=unknown><meta charset=gbk>',
    '<meta charset=gbk charset=utf-8>',
  ])('仅meta声明的GBK正确解码：%s', async (head) => {
    const text = html(head);
    const mock = serve(text, 'gbk');
    expect((await request()).text).toBe(text);
    expect(mock).toHaveBeenCalledOnce();
  });

  it('GB18030四字节正文不能误按GBK解码', async () => {
    const prefix = '<html><head><meta charset=gb18030></head><body>';
    const suffix = '</body></html>';
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from('95328236', 'hex'), Buffer.from(suffix)]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'text/html' } })));
    expect((await request()).text).toBe(prefix + '𠀀' + suffix);
  });

  it.each(['text/html', 'TEXT/HTML', 'Text/Html; charset=unknown', 'text/html; charset=constructor'])
    ('无有效HTTP编码可用meta：%s', async (contentType) => {
      const text = html('<meta charset=gbk>');
      serve(text, 'gbk', contentType);
      expect((await request()).text).toBe(text);
    });

  it.each(['text/html; charset=utf-8', 'Text/Html; CHARSET="UTF-8"'])('有效HTTP编码优先：%s', async (contentType) => {
    const text = html('<meta charset=gbk>');
    serve(text, 'utf-8', contentType);
    expect((await request()).text).toBe(text);
  });

  it.each(['gbk', 'utf-8', undefined] as const)('显式或缺省 responseCharset=%s不启用meta', async (responseCharset) => {
    const text = html(`<meta charset=${responseCharset === 'gbk' ? 'utf-8' : 'gbk'}>`);
    serve(text, responseCharset ?? 'utf-8', 'text/html; charset=unknown');
    expect((await request({ responseCharset })).text).toBe(text);
  });

  it('显式源响应声明保留HTTP和meta之上的优先级', async () => {
    const text = html('<meta charset=utf-8>');
    serve(text, 'gbk', 'text/html; charset=utf-8');
    expect((await request({ responseCharset: 'gbk', request: { method: 'POST', charset: 'gbk', body: 'q=synthetic' } })).text).toBe(text);
  });

  it.each(['text/plain', 'application/json', 'application/xhtml+xml', 'text/html-other', ''])('非HTML响应不启用meta：%s', async (contentType) => {
    const text = html('<meta charset=gbk>');
    serve(text, 'utf-8', contentType);
    expect((await request()).text).toBe(text);
  });

  it.each([
    '<!-- <meta charset=gbk> -->', '<script>const x="<meta charset=gbk>";</script>',
    '<style>x::before {content:"<meta charset=gbk>"}</style>', '<title><meta charset=gbk></title>',
    '<noscript><meta charset=gbk></noscript>', '<template><meta charset=gbk></template>',
    '<link title="<meta charset=gbk>">', '<meta content="text/html; charset=gbk">',
    '<meta http-equiv=refresh content="text/html; charset=gbk">', '<meta charset=big5>',
    '<meta charset=constructor>', '<meta charset=__proto__>', '<meta charset=gbk-unknown>',
    '<meta charset=utf-8><meta charset=gbk>',
  ])('伪meta或未知声明不改变UTF8：%s', async (head) => {
    const text = html(head);
    serve(text);
    expect((await request()).text).toBe(text);
  });

  it.each([
    '<html><head></head><meta charset=gbk><body>合成正文</body>',
    '<html><head></head><body><meta charset=gbk>合成正文</body>',
    '<html><head><div><meta charset=gbk>合成正文</div>',
    '<html><body><head><meta charset=gbk></head>合成正文</body>',
    '<meta charset=gbk><p>合成正文</p>',
    '</head><meta charset=gbk><p>合成正文</p>',
    '<html><head><meta charset=gbk',
  ])('原HTML head外或不完整声明不生效：%s', async (text) => {
    serve(text);
    expect((await request()).text).toBe(text);
  });

  it.each([1024, 1025])('meta完整标签末端在第%s字节：上限内生效、上限外回退', async (end) => {
    const meta = '<meta charset=gbk>';
    const text = '<head>' + ' '.repeat(end - '<head>'.length - meta.length) + meta + '</head>合成正文';
    serve(text, end === 1024 ? 'gbk' : 'utf-8');
    expect((await request()).text).toBe(text);
  });

  it('meta与GBK多字节正文均跨stream chunk，包括第1024字节的字符边界', async () => {
    const prefix = '<head><meta charset=gbk></head>';
    const text = prefix + ' '.repeat(1023 - prefix.length) + '合成正文';
    const bytes = encodeToBytes(text, 'gbk');
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()!); else controller.close(); },
    }), { headers: { 'content-type': 'text/html' } })));
    expect((await request()).text).toBe(text);
  });

  it.each([false, true])('读取前缀期间仍强制实际字节/Content-Length上限：头=%s', async (withLength) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40)); }, cancel });
    const headers: Record<string, string> = { 'content-type': 'text/html' };
    if (withLength) headers['content-length'] = '40';
    const mock = vi.fn().mockResolvedValue(new Response(stream, { headers }));
    vi.stubGlobal('fetch', mock);
    await expect(request({ maxBytes: 30 })).rejects.toThrow('书源响应体积超限');
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false); expect(mock).toHaveBeenCalledOnce();
  });

  it.each([false, true])('调用方取消在前缀%s选码后均终止并释放流', async (decoded) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const prefix = '<head><meta charset=gbk></head>' + (decoded ? ' '.repeat(1024) : '');
    const stream = new ReadableStream({ start(c) { c.enqueue(encodeToBytes(prefix, 'gbk')); }, cancel });
    const mock = vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', mock);
    const result = request({ signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException('synthetic cancel', 'AbortError'));
    await assertion;
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false); expect(mock).toHaveBeenCalledOnce();
  });

  it('前缀读取与后续正文共享原总deadline，已有一次换host规则不变', async () => {
    // 换 host 兜底需要同站对：唯一的对（book15）lifecycle='retired' 会被许可门拒绝。
    // doMock 只把同站对数据换成合成 e1.test ↔ www.e1.test，判定走真实实现；
    // finally 撤 mock 复位，不污染后续用例。
    vi.doMock('./supported-sources', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./supported-sources')>();
      return { ...actual, BUILTIN_SOURCE_HOSTS: ['e1.test', 'www.e1.test'] };
    });
    try {
      vi.resetModules();
      const { fetchSourceText: fetchSourceTextWithSwap } = await import('./source-fetch');
      vi.useFakeTimers();
      const cancel = vi.fn();
      const streams: ReadableStream[] = [];
      const mock = vi.fn().mockImplementation(async () => {
        const stream = new ReadableStream({ start(c) {
          c.enqueue(encodeToBytes('<head><meta charset=gbk>', 'gbk'));
          setTimeout(() => c.enqueue(new Uint8Array(1024).fill(32)), 60);
        }, cancel });
        streams.push(stream);
        return new Response(stream, { headers: { 'content-type': 'text/html' } });
      });
      vi.stubGlobal('fetch', mock);
      const result = fetchSourceTextWithSwap('https://e1.test/meta', {
        signal: signal(), responseCharset: 'auto', timeoutMs: 100,
      });
      const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(100 + SOURCE_HOST_SWAP_DELAY_MS + 100);
      await assertion;
      expect(mock).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2);
      expect(streams.every((s) => !s.locked)).toBe(true);
    } finally {
      vi.doUnmock('./supported-sources');
      vi.resetModules();
    }
  });
});
