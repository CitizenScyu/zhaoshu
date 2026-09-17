import { describe, expect, it } from 'vitest';
import {
  parseRegistrationMode,
  registerEntryHref,
  registerEntryLabel,
  registerEntryNotice,
  registerEntryState,
  registerEntryVisible,
  type RegistrationMode,
} from './register-entry';

const MODES: (RegistrationMode | null)[] = [null, 'closed', 'open', 'invite'];

describe('注册入口可见性：账号开关 × 注册三态 × 当前模式', () => {
  it('总闸未开（账号模式部署开关关闭）时一律不出现注册内容', () => {
    for (const registrationMode of MODES) {
      for (const memberMode of [true, false]) {
        const state = registerEntryState({ accountsEnabled: false, memberMode, registrationMode });
        expect(state).toBe('hidden');
        expect(registerEntryLabel(state)).toBeNull();
        expect(registerEntryNotice(state)).toBeNull();
        expect(registerEntryHref(state, '/read/3')).toBeNull();
      }
    }
  });

  it('用户主动切到管理员口令入口时不给注册链接（但也不解释，避免误导）', () => {
    for (const registrationMode of MODES) {
      const state = registerEntryState({ accountsEnabled: true, memberMode: false, registrationMode });
      expect(state).toBe('hidden');
      expect(registerEntryHref(state, null)).toBeNull();
      expect(registerEntryNotice(state)).toBeNull();
    }
  });

  it('三态取到时按服务端开关放行或关闭', () => {
    const at = (registrationMode: RegistrationMode | null) =>
      registerEntryState({ accountsEnabled: true, memberMode: true, registrationMode });

    expect(at('open')).toBe('open');
    expect(at('invite')).toBe('invite');
    expect(at('closed')).toBe('closed');
  });

  it('三态未知时不藏入口（否则重演「找不到注册入口」）', () => {
    const state = registerEntryState({ accountsEnabled: true, memberMode: true, registrationMode: null });
    expect(state).toBe('unknown');
    expect(registerEntryVisible(state)).toBe(true);
    expect(registerEntryLabel(state)).toBe('注册新账号');
  });

  it('只有 closed 不给链接，且只有 closed 给说明', () => {
    expect(registerEntryVisible('closed')).toBe(false);
    expect(registerEntryNotice('closed')).toBe('本站当前未开放注册。');
    for (const state of ['hidden', 'open', 'invite', 'unknown'] as const) {
      expect(registerEntryNotice(state)).toBeNull();
    }
  });
});

describe('注册入口文案与链接', () => {
  it('邀请码注册与开放注册文案与 AdminTab 三态同义', () => {
    expect(registerEntryLabel('open')).toBe('注册新账号');
    expect(registerEntryLabel('invite')).toBe('注册新账号（需邀请码）');
    expect(registerEntryLabel('unknown')).toBe('注册新账号');
  });

  it('带 returnTo 时编码进查询串，没有 returnTo 时就是裸路径', () => {
    expect(registerEntryHref('open', null)).toBe('/register');
    expect(registerEntryHref('invite', '/read/12?from=shelf'))
      .toBe('/register?returnTo=%2Fread%2F12%3Ffrom%3Dshelf');
  });

  it('服务端响应只认三态，其它形状一律 null（不在这里失败关闭）', () => {
    expect(parseRegistrationMode('open')).toBe('open');
    expect(parseRegistrationMode('invite')).toBe('invite');
    expect(parseRegistrationMode('closed')).toBe('closed');
    expect(parseRegistrationMode(undefined)).toBeNull();
    expect(parseRegistrationMode(null)).toBeNull();
    expect(parseRegistrationMode('public')).toBeNull();
    expect(parseRegistrationMode({ registrationMode: 'open' })).toBeNull();
  });
});
