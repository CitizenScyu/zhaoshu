import { NextRequest } from 'next/server';

export function ownerRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/owner', { headers });
}
