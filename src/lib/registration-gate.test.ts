import { describe, expect, it } from 'vitest';
import { effectiveRegistrationMode, gateStatusLabel, gateWarning } from '@/lib/registration-gate';

describe('部署闸门展示', () => {
  it('状态文案只有两态', () => {
    expect(gateStatusLabel(true)).toBe('已启用');
    expect(gateStatusLabel(false)).toBe('未启用');
  });

  it('只有闸门未开才给说明，已开启时返回 null（不留空占位）', () => {
    expect(gateWarning(true)).toBeNull();
    const warning = gateWarning(false);
    expect(warning).toContain('部署闸门未开启');
    // 必须说清「改不动」的原因和出路，否则用户只看到「不生效」会更懵。
    expect(warning).toContain('AUTH_ACCOUNTS_ENABLED=true');
    expect(warning).toContain('重新部署');
  });
});

describe('对外实际生效的注册模式', () => {
  it('闸门开且成员总闸开 → 与库里的三态一致', () => {
    expect(effectiveRegistrationMode(true, true, 'open')).toBe('open');
    expect(effectiveRegistrationMode(true, true, 'invite')).toBe('invite');
    expect(effectiveRegistrationMode(true, true, 'closed')).toBe('closed');
  });

  it('成员总闸关闭 → 一律关闭，与 /api/auth/registration 一致', () => {
    expect(effectiveRegistrationMode(true, false, 'open')).toBe('closed');
    expect(effectiveRegistrationMode(true, false, 'invite')).toBe('closed');
  });

  it('部署闸门未开 → 一律关闭，库里的模式只是草稿', () => {
    expect(effectiveRegistrationMode(false, true, 'open')).toBe('closed');
    expect(effectiveRegistrationMode(false, true, 'invite')).toBe('closed');
    expect(effectiveRegistrationMode(false, false, 'open')).toBe('closed');
  });
});
