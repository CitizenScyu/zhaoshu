import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireApiOwner(req: NextRequest): NextResponse | null {
  const expected = process.env.APP_OWNER_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'APP_OWNER_TOKEN is not configured' },
      { status: 503 },
    );
  }

  const authorization = req.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : req.headers.get('x-owner-token') ?? '';
  if (!equalSecret(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
