import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cases from './fixtures/source-policy.json';
import { refreshSupportedHosts, SourcePolicyError, validateSourceUrl } from './source-policy';

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
