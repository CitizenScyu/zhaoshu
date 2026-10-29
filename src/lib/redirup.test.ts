import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAdmission, type AdmissionTransport } from './rule-engine/admission';
import type { RawSource } from './rule-engine/compile-smoke';
import { fetchSourceText } from './source-fetch';
import { redirectHttpsUpgradeEnabled, upgradeRedirectLocation } from './source-policy';

// redirup1030：跳转的绝对 http:// Location 升级成 https:// 再过锁（ENGINE_REDIRECT_HTTPS_UPGRADE，默认 off）。
// 校验函数不 mock：host 白名单/端口/IP 红线都走真的 checkSourceUrl。

vi.mock('./supported-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supported-sources')>();
  return { ...actual, isRetiredBuiltinHost: () => false };
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const on = () => vi.stubEnv('ENGINE_REDIRECT_HTTPS_UPGRADE', '1');
const HTML = { 'content-type': 'text/html; charset=utf-8' };
const hit = () => new Response('<div class="i"><span class="t">书名</span><a href="/b/1">x</a></div>', { headers: HTML });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const source = (): RawSource => ({
  bookSourceUrl: 'https://up.example.com/', bookSourceName: '合成源', searchUrl: 'https://up.example.com/s?q={{key}}',
  checkKeyWord: '测试关键字', ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href', author: '.a@text' },
  ruleToc: { chapterList: '.toc@li', chapterName: 'a@text', chapterUrl: 'a@href' }, ruleContent: { content: '.c' },
} as RawSource);
const admit = (fetchPage: AdmissionTransport, ...hosts: string[]) => searchAdmission(source(), {
  fetchPage, declaredHosts: new Set(['up.example.com', ...hosts]), signal: new AbortController().signal, throttleMs: 0,
});

describe('redirup1030 开关与升级函数', () => {
  it('只认 1/true/on；关时 Location 原样', () => {
    expect(redirectHttpsUpgradeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ['1', 'true', 'on', ' ON ']) {
      expect(redirectHttpsUpgradeEnabled({ ENGINE_REDIRECT_HTTPS_UPGRADE: v } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
    expect(redirectHttpsUpgradeEnabled({ ENGINE_REDIRECT_HTTPS_UPGRADE: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(upgradeRedirectLocation('http://up.example.com/a')).toBe('http://up.example.com/a');
  });

  it('开时只升字面 http://，相对/https/其它 scheme 原样', () => {
    on();
    expect(upgradeRedirectLocation('HTTP://up.example.com/a?b=1')).toBe('https://up.example.com/a?b=1');
    expect(upgradeRedirectLocation('/a')).toBe('/a');
    expect(upgradeRedirectLocation('https://up.example.com/a')).toBe('https://up.example.com/a');
    expect(upgradeRedirectLocation('ftp://up.example.com/a')).toBe('ftp://up.example.com/a');
  });
});

describe('redirup1030 准入跳转', () => {
  it('关：声明 host 的 http Location 判 url_invalid，不发第二跳', async () => {
    const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValueOnce(redirect('http://up.example.com/s2'));
    expect((await admit(fetchPage)).verdict).toBe('url_invalid');
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('开：声明 host 的 http Location 升 https 后跟随', async () => {
    on();
    const fetchPage = vi.fn<AdmissionTransport>()
      .mockResolvedValueOnce(redirect('http://next.example.com/s2')).mockResolvedValueOnce(hit());
    expect((await admit(fetchPage, 'next.example.com')).verdict).toBe('ok');
    expect(String(fetchPage.mock.calls[1][0])).toBe('https://next.example.com/s2');
  });

  it.each(['http://evil.example.net/x', 'http://up.example.com:8080/x', 'http://127.0.0.1/x', 'http://@up.example.com/x'])(
    '开：升级不放宽其它检查项（%s 仍拒）', async (location) => {
      on();
      const fetchPage = vi.fn<AdmissionTransport>().mockResolvedValueOnce(redirect(location));
      expect((await admit(fetchPage)).verdict).toBe('url_invalid');
      expect(fetchPage).toHaveBeenCalledOnce();
    });
});

describe('redirup1030 读链路跳转（source-fetch）', () => {
  it('开：https→http 同址降级跳转升级后等于当前地址，按循环拒', async () => {
    on();
    const fetchMock = vi.fn().mockResolvedValue(redirect('http://book15.net/a'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/a', { signal: new AbortController().signal })).rejects.toThrow('循环');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('关拒、开跟随（book15 为运行时门内 host）', async () => {
    const off = vi.fn().mockResolvedValue(redirect('http://book15.net/a'));
    vi.stubGlobal('fetch', off);
    await expect(fetchSourceText('https://book15.net/', { signal: new AbortController().signal })).rejects.toThrow();
    expect(off).toHaveBeenCalledOnce();

    on();
    const follow = vi.fn().mockResolvedValueOnce(redirect('http://book15.net/a')).mockResolvedValueOnce(new Response('正文'));
    vi.stubGlobal('fetch', follow);
    expect(await fetchSourceText('https://book15.net/', { signal: new AbortController().signal }))
      .toEqual({ url: 'https://book15.net/a', text: '正文' });
  });

  it('开：未准入 host 的 http Location 仍拒', async () => {
    on();
    const fetchMock = vi.fn().mockResolvedValue(redirect('http://book15.net.evil.invalid/a'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourceText('https://book15.net/', { signal: new AbortController().signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
