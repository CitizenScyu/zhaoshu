import { describe, expect, it } from 'vitest';
import type { Principal } from './auth-types';
import { hasPermission, OWNER_PRINCIPAL } from './permissions';

describe('permissions', () => {
  it('gives the fixed owner all three capabilities', () => {
    expect(['find', 'read', 'download'].map((permission) =>
      hasPermission(OWNER_PRINCIPAL, permission as 'find' | 'read' | 'download'))).toEqual([true, true, true]);
  });

  it('fails closed for an unknown role at runtime', () => {
    const damaged = { ...OWNER_PRINCIPAL, role: 'admin' } as unknown as Principal;
    expect(hasPermission(damaged, 'find')).toBe(false);
  });
});
