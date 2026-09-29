// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthController } from '@/lib/auth-client';
import { OwnerProvider } from './OwnerProvider';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('storage fallback emits distinct opaque marks for consecutive changes at one clock value', () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  vi.spyOn(AuthController.prototype, 'start').mockResolvedValue(undefined);
  const registered = vi.spyOn(AuthController.prototype, 'setNotify');
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  render(<OwnerProvider><span>合成页面</span></OwnerProvider>);
  const notify = registered.mock.calls.find(([callback]) => callback)?.[0];
  expect(notify).toBeTypeOf('function');
  notify!(); notify!();
  const values = writes.mock.calls.filter(([key]) => key === 'novel-finder-auth-signal').map(([, value]) => value);
  expect(values).toHaveLength(2);
  expect(values[0]).not.toBe(values[1]);
  for (const value of values) {
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThan(128);
    expect(value).not.toMatch(/username|password|token|cookie|session|profile|合成页面/i);
  }
});
