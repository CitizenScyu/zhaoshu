import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';

export const maxDuration = 60;

// Validate a draft token without reading business data or initializing the DB.
export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  return NextResponse.json({ ok: true }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
