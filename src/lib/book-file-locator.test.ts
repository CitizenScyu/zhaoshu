import { describe, expect, it, vi } from 'vitest';
import { locateBookFile } from './book-file-locator';

describe('shared download/reader file location', () => {
  it('uses a listed canonical name without another metadata request', async () => {
    const file = { name: '山河-作者.txt' };
    const lookup = vi.fn();
    expect(await locateBookFile({ files: [file], truncated: true }, '山河', '作者', lookup)).toBe(file);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('finds the exact file outside a truncated listing', async () => {
    const target = { name: '山河-作者.txt' };
    const lookup = vi.fn().mockResolvedValue(target);
    expect(await locateBookFile({ files: [{ name: '山河-另一作者.txt' }], truncated: true }, '山河', '作者', lookup)).toBe(target);
    expect(lookup).toHaveBeenCalledWith(target.name);
  });
  it('rejects a seemingly unique wrong author in a truncated listing', async () => {
    expect(await locateBookFile({ files: [{ name: '山河-另一作者.txt' }], truncated: true }, '山河', '作者', async () => null)).toBeNull();
  });
  it('checks canonical anonymous metadata before using a listed authorless legacy file', async () => {
    const canonical = { name: '山河-佚名.txt' };
    expect(await locateBookFile({ files: [{ name: '山河.txt' }], truncated: true }, '山河', '', async () => canonical)).toBe(canonical);
  });
  it('can look up an exact anonymous legacy file even when the listing is truncated', async () => {
    const legacy = { name: '山河.txt' };
    const lookup = vi.fn(async name => name === legacy.name ? legacy : null);
    expect(await locateBookFile({ files: [], truncated: true }, '山河', '', lookup)).toBe(legacy);
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['山河-佚名.txt', '山河.txt']);
  });
  it('retains a unique older author spelling only after exact lookups in a complete directory', async () => {
    const older = { name: '山河-旧名.txt' };
    expect(await locateBookFile({ files: [older], truncated: false }, '山河', '新名', async () => null)).toBe(older);
  });
  it('rejects ambiguous prefixes in a complete directory', async () => {
    expect(await locateBookFile({ files: [{ name: '山河-甲.txt' }, { name: '山河-乙.txt' }], truncated: false }, '山河', '作者', async () => null)).toBeNull();
  });
  it('propagates upstream errors instead of silently falling back to a different file', async () => {
    const error = new Error('rate limited');
    await expect(locateBookFile({ files: [{ name: '山河-旧名.txt' }], truncated: false }, '山河', '新名', async () => { throw error; })).rejects.toBe(error);
  });
});
