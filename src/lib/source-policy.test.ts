import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cases from './fixtures/source-policy.json';
import { refreshSupportedHosts, SourcePolicyError, upgradeSourceTemplateUrl, validateSourceUrl } from './source-policy';

describe('书源精确 allowlist（与 worker 共用夹具）', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('策略测试禁止网络'); })));
  afterEach(() => vi.unstubAllGlobals());

  it.each(cases)('$name', ({ input, base, expected }) => {
    if (expected) expect(validateSourceUrl(input, base).href).toBe(expected);
    else expect(() => validateSourceUrl(input, base)).toThrow(SourcePolicyError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('拒绝过长地址', () => {
    expect(() => validateSourceUrl('https://book15.net/' + 'a'.repeat(2048))).toThrow(SourcePolicyError);
  });
});

// M1 任务 4，设计 §6.1：运行时 host 门动态化。fail-closed 语义 = 收窄到内建集合，
// 绝不放大（只并入 refresh 传入的规范 host），也绝不空集（book15 双 host 永在）。
describe('动态 host 集合（M1 任务 4，设计 §6.1）', () => {
  afterEach(() => refreshSupportedHosts([])); // 复位到内建集合，避免用例间串状态

  it('冷启动只认内建 book15 双 host，引擎 host 被拒', () => {
    expect(validateSourceUrl('https://book15.net/a').href).toBe('https://book15.net/a');
    expect(validateSourceUrl('https://www.book15.net/a').href).toBe('https://www.book15.net/a');
    expect(() => validateSourceUrl('https://engine.example/a')).toThrow(SourcePolicyError);
  });

  it('refreshSupportedHosts 并入 ok 态 host；集合外 host / IP 直连 / http / 带端口 / userinfo 全拒', () => {
    refreshSupportedHosts([
      'engine.example', 'NEW.example', // 第二个经 host 归一化小写后应可用
      'NEW.example:8443', 'https://path.example/a', 'user@mail.example',
      '127.0.0.1', '10.0.0.1', '[::1]', 'localhost', '',
    ]);
    expect(validateSourceUrl('https://engine.example/a').href).toBe('https://engine.example/a');
    expect(validateSourceUrl('https://new.example/a').href).toBe('https://new.example/a');
    for (const rejected of [
      'https://path.example/a', 'https://mail.example/a', 'https://127.0.0.1/a', 'https://10.0.0.1/a',
      'https://[::1]/a', 'https://localhost/a', 'http://engine.example/a',
      'https://engine.example:444/a', 'https://user@engine.example/a', 'https://evil.invalid/a',
    ]) {
      expect(() => validateSourceUrl(rejected)).toThrow(SourcePolicyError);
    }
  });

  it('fail-closed：空集/全非法输入收窄到内建集合，绝不空集', () => {
    refreshSupportedHosts([]);
    expect(validateSourceUrl('https://book15.net/a').href).toBe('https://book15.net/a');
    refreshSupportedHosts(['127.0.0.1', 'bad host', '[::1]']);
    expect(validateSourceUrl('https://www.book15.net/a').href).toBe('https://www.book15.net/a');
    expect(() => validateSourceUrl('https://engine.example/a')).toThrow(SourcePolicyError);
  });

  it('下一轮 refresh 未出现的动态 host 被移除（不残留、不累积放大）', () => {
    refreshSupportedHosts(['engine.example']);
    expect(validateSourceUrl('https://engine.example/a').href).toBe('https://engine.example/a');
    refreshSupportedHosts([]);
    expect(() => validateSourceUrl('https://engine.example/a')).toThrow(SourcePolicyError);
  });
});

// 41-urlfix：模板 URL 的 http→https 升级。纯函数级反例——只改 scheme，
// 升级后仍交同一把 checkSourceUrl 检查（host 白名单/端口/IP 防线一个不少），不引入新授权。
describe('模板 URL http→https 升级（41-urlfix）', () => {
  afterEach(() => refreshSupportedHosts([])); // 复位到内建集合，避免用例间串状态

  it('只把字面 http:// 换成 https://，host/端口/路径/查询串逐字不变（大小写不敏感）', () => {
    expect(upgradeSourceTemplateUrl('http://book15.net/s?q=a&p=1')).toBe('https://book15.net/s?q=a&p=1');
    expect(upgradeSourceTemplateUrl('HTTP://book15.net/s')).toBe('https://book15.net/s'); // 前缀大小写不敏感
    // 已是 https / 其它 scheme / 相对引用一律原样返回（后者仍按 base 解析，交给锁处理）。
    expect(upgradeSourceTemplateUrl('https://book15.net/s')).toBe('https://book15.net/s');
    expect(upgradeSourceTemplateUrl('/search?q=a')).toBe('/search?q=a');
    expect(upgradeSourceTemplateUrl('//book15.net/s')).toBe('//book15.net/s');
    expect(upgradeSourceTemplateUrl('ftp://book15.net/s')).toBe('ftp://book15.net/s');
    expect(upgradeSourceTemplateUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('升级后仍被同一把锁按原判据拒：非白名单 host / 非 443 端口 / userinfo / IP 直连 / 私网', () => {
    // 升级前 host 就不在白名单：升 https 也不会放行（不引入任何新 host 授权）。
    expect(() => validateSourceUrl(upgradeSourceTemplateUrl('http://evil.invalid/s'))).toThrow(SourcePolicyError);
    expect(() => validateSourceUrl(upgradeSourceTemplateUrl('http://127.0.0.1/s'))).toThrow(SourcePolicyError);
    expect(() => validateSourceUrl(upgradeSourceTemplateUrl('http://10.0.0.1/s'))).toThrow(SourcePolicyError);
    expect(() => validateSourceUrl(upgradeSourceTemplateUrl('http://book15.net:8080/s'))).toThrow(SourcePolicyError);
    expect(() => validateSourceUrl(upgradeSourceTemplateUrl('http://user@book15.net/s'))).toThrow(SourcePolicyError);
  });
});
