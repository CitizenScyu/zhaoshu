import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cases from './fixtures/source-policy.json';
import { SourcePolicyError, validateSourceUrl } from './source-policy';

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
