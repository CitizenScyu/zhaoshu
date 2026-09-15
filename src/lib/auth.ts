import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { AuthResult, Permission } from './auth-types';
import { hasPermission, OWNER_PRINCIPAL } from './permissions';

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireApiOwner(req: NextRequest): NextResponse | null {
  const expected = process.env.APP_OWNER_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'APP_OWNER_TOKEN is not configured', code: 'OWNER_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const authorization = req.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : req.headers.get('x-owner-token') ?? '';
  if (!equalSecret(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }
  return null;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
}

export async function resolvePrincipal(req: NextRequest): Promise<AuthResult> {
  const authorization = req.headers.get('authorization');
  const ownerHeader = req.headers.get('x-owner-token');

  if (authorization !== null && ownerHeader !== null) {
    return { ok: false, response: unauthorized() };
  }

  if (authorization === null && ownerHeader === null) {
    return { ok: false, response: unauthorized() };
  }

  const expected = process.env.APP_OWNER_TOKEN;
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'APP_OWNER_TOKEN is not configured', code: 'OWNER_NOT_CONFIGURED' },
        { status: 503 },
      ),
    };
  }

  const provided = authorization !== null
    ? authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    : ownerHeader ?? '';
  if (!provided || !equalSecret(provided, expected)) {
    return { ok: false, response: unauthorized() };
  }
  return { ok: true, principal: OWNER_PRINCIPAL };
}

export async function requirePermission(
  req: NextRequest,
  permission: Permission,
): Promise<AuthResult> {
  const result = await resolvePrincipal(req);
  if (!result.ok) return result;
  if (!hasPermission(result.principal, permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    };
  }
  return result;
}

export async function requireOwner(req: NextRequest): Promise<AuthResult> {
  const result = await resolvePrincipal(req);
  if (!result.ok) return result;
  if (result.principal.role !== 'owner') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    };
  }
  return result;
}
