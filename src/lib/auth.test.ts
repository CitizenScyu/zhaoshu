import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerRequest } from './fixtures/auth';
import { requireOwner, requirePermission, resolvePrincipal } from './auth';

describe('owner-header principal adapter', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [{ Authorization: 'Bearer owner-test' }],
    [{ 'x-owner-token': 'owner-test' }],
  ])('maps a valid owner header to the fixed owner principal', async (headers) => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const result = await resolvePrincipal(ownerRequest(headers));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal).toMatchObject({ userId: 1, role: 'owner', authMethod: 'owner-header' });
  });

  it.each([
    {} as Record<string, string>,
    { Authorization: 'Basic owner-test' },
    { Authorization: 'Bearer wrong' },
    { 'x-owner-token': 'wrong' },
    { Authorization: 'Bearer owner-test', 'x-owner-token': 'owner-test' },
  ])('rejects missing, malformed, wrong, or conflicting credentials', async (headers) => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const result = await resolvePrincipal(ownerRequest(headers));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('reports unavailable owner configuration explicitly', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', '');
    const result = await resolvePrincipal(ownerRequest({ Authorization: 'Bearer value' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it('allows the owner through the new permission and owner guards', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const request = ownerRequest({ Authorization: 'Bearer owner-test' });
    const permission = await requirePermission(request, 'download');
    const owner = await requireOwner(request);
    expect(permission.ok).toBe(true);
    expect(owner.ok).toBe(true);
  });

  it('does not introduce a member or session fallback in A01', async () => {
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-test');
    const result = await requirePermission(
      ownerRequest({ Cookie: '__Host-nf-session=not-implemented' }),
      'find',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
