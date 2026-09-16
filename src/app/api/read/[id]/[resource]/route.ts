import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { withAuthHeaders } from '@/lib/auth-http';
import { getReadableTask, readBookIndex, readBookPart, readerAvailability, ReaderError } from '@/lib/reader-server';

// One route/function serves both index and chapter requests, so warm instances
// share a bounded TXT cache. No book content is placed in a public/CDN cache.
export const runtime = 'nodejs';
export const maxDuration = 120;

function privateResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Vary': 'Cookie, Authorization, X-Owner-Token',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 503 ? { 'Retry-After': '5' } : {}),
    },
  });
}

function parseOrdinal(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; resource: string }> },
) {
  const auth = await requirePermission(req, 'read');
  if (!auth.ok) {
    const response = withAuthHeaders(auth.response);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  }
  const { id, resource } = await params;
  const taskId = parseOrdinal(id);
  if (taskId === null || taskId < 1 || taskId > 2_147_483_647) {
    return privateResponse({ error: '无效的下载任务编号。' }, 400);
  }
  if (!['index', 'chapter', 'availability'].includes(resource)) {
    return privateResponse({ error: '阅读接口不存在。' }, 404);
  }
  const query = req.nextUrl.searchParams;
  const chapter = parseOrdinal(query.get('chapter'));
  const part = parseOrdinal(query.get('part') ?? '0');
  const version = query.get('version') ?? '';
  if (resource === 'chapter' && (chapter === null || part === null || !/^[a-f0-9]{40}$/.test(version))) {
    return privateResponse({ error: '无效的章节、段落或文件版本。' }, 400);
  }
  try {
    const task = await getReadableTask(taskId);
    if (resource === 'availability') return privateResponse(await readerAvailability(task));
    if (resource === 'index') return privateResponse(await readBookIndex(task));
    return privateResponse(await readBookPart(task, chapter!, part!, version));
  } catch (error) {
    if (error instanceof ReaderError) return privateResponse({ error: error.message }, error.status);
    // Avoid logging upstream bodies, tokens, connection strings, or book text.
    console.error('Reader request failed');
    return privateResponse({ error: '阅读服务暂时不可用，请稍后重试。' }, 500);
  }
}
