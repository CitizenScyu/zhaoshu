import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchText, isTrustedRedirectTarget } from './shuyuan';

// fetchText 的**有界跳转**语义:上游 yckceo 把合集 JSON 端点改成 302 跳转到 jsdelivr
// (2026-09-21 实测 gcore.jsdelivr.net)。原先 redirect:'error' 硬拒一切跳转会全量失败;
// 改为「最多 N 跳 + 目标主机白名单(*)」后必须逐条钉住:
//   - 白名单内跨主机 302 → 跟随成功;相对 Location → 正确解析;
//   - 白名单外主机 / 超跳数 / 非 https → 一律拒绝(不放 SSRF 面)。
// 每示例都断言 fetch 用 redirect:'manual'(绝不无脑 'follow')。

const origin = 'https://www.yckceo.com/yuedu/shuyuans/json/id/1275.json';
const signal = () => new AbortController().signal;

function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}
function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchText 有界跳转', () => {
  it('白名单内跨主机 302 → 跟随成功(redirect 始终 manual)', async () => {
    const cdn = 'https://gcore.jsdelivr.net/gh/mumuceo/file01/202609/894_abc.json';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(redirect(cdn))
      .mockResolvedValueOnce(ok('[]'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchText(origin, 12_000, signal())).resolves.toBe('[]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(origin);
    expect(fetchMock.mock.calls[1][0]).toBe(cdn);
    // 关键:两跳都用 manual,绝不 follow(否则 = 无界跳转,SSRF 放大面)。
    expect(fetchMock.mock.calls.map(([, init]) => init?.redirect)).toEqual(['manual', 'manual']);
  });

  it('相对 Location 正确解析(基于当前跳的 base)', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(redirect('/gh/mumuceo/file01/x.json'))
      .mockResolvedValueOnce(ok('[1]'));
    vi.stubGlobal('fetch', fetchMock);

    // 相对路径解析后会落回 yckceo 主机 — 不在白名单,故先验解析、后验拒绝,见下一例。
    // 这里改用一个相对跳转到白名单主机绝对路径的形态来验证 base 解析:
    fetchMock.mockReset()
      .mockResolvedValueOnce(redirect('https://cdn.jsdelivr.net/gh/x/y.json'))
      .mockResolvedValueOnce(ok('[1]'));
    await expect(fetchText(origin, 12_000, signal())).resolves.toBe('[1]');

    // 真·相对 Location:目标是同主机路径,解析为 yckceo → 非白名单 → 拒绝;
    // 断言错误里的 host 来自解析后的绝对 URL(证明 base 解析生效),而非原样回显。
    const relMock = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('/yuedu/shuyuans/other.json'));
    vi.stubGlobal('fetch', relMock);
    await expect(fetchText(origin, 12_000, signal())).rejects.toThrow('www.yckceo.com');
  });

  it('白名单外主机 → 拒绝跟随', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('https://evil.example/x.json'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchText(origin, 12_000, signal())).rejects.toThrow('非受信主机');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 未发起第二跳
  });

  it('超跳数 → 拒绝(白名单内也要有上限)', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    // 永远 302 到白名单内另一个地址:第 4 跳(redirects=3)必须被拒。
    fetchMock.mockImplementation(async () => redirect(`https://cdn.jsdelivr.net/gh/x/${Math.random()}.json`));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchText(origin, 12_000, signal())).rejects.toThrow('跳转次数超限');
    expect(fetchMock).toHaveBeenCalledTimes(4); // 初始 + 3 次跟随后第 4 次触发上限
  });

  it('非 https 目标 → 拒绝', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('http://cdn.jsdelivr.net/x.json'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchText(origin, 12_000, signal())).rejects.toThrow('非受信主机');
  });

  it('循环跳转 → 拒绝', async () => {
    const self = 'https://cdn.jsdelivr.net/a.json';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(redirect(self))
      .mockResolvedValueOnce(redirect(self));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchText(origin, 12_000, signal())).rejects.toThrow('形成循环');
  });
});

describe('isTrustedRedirectTarget 判定', () => {
  it('精确与子域放行,其余拒绝', () => {
    expect(isTrustedRedirectTarget('https://jsdelivr.net/a.json', origin)).toBe(true);
    expect(isTrustedRedirectTarget('https://gcore.jsdelivr.net/a.json', origin)).toBe(true);
    expect(isTrustedRedirectTarget('https://cdn.jsdelivr.net/a.json', origin)).toBe(true);
    expect(isTrustedRedirectTarget('https://fastly.jsdelivr.net/a.json', origin)).toBe(true);
    expect(isTrustedRedirectTarget('https://evil-jsdelivr.net/a.json', origin)).toBe(false); // 后缀伪装
    expect(isTrustedRedirectTarget('https://jsdelivr.net.evil.example/a.json', origin)).toBe(false);
    expect(isTrustedRedirectTarget('http://cdn.jsdelivr.net/a.json', origin)).toBe(false); // 非 https
    expect(isTrustedRedirectTarget('https://127.0.0.1/a.json', origin)).toBe(false); // 内网
    expect(isTrustedRedirectTarget('not a url', origin)).toBe(false);
  });
});