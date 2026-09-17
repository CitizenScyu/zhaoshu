import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { withAuthHeaders } from '@/lib/auth-http';
import { ensureSchema } from '@/lib/db';
import { createDeadline, raceDeadline } from '@/lib/deadline';
import { cleanString } from '@/lib/sanitize';
import { SourcePolicyError } from '@/lib/source-policy';
import {
  readSourceChapter, resolveSourceBook, saveSourceCatalog, sourceReaderIndex,
  SourceReaderError, SourceRequestContext,
} from '@/lib/source-reader';

export const runtime = 'nodejs';
export const maxDuration = 60;
const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Owner-Token', 'X-Content-Type-Options': 'nosniff' };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...HEADERS, ...(status === 503 ? { 'Retry-After': '5' } : {}) } });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ resource: string }> }) {
  const auth = await requirePermission(req, 'read');
  if (!auth.ok) {
    const rejected = withAuthHeaders(auth.response);
    rejected.headers.set('X-Content-Type-Options', 'nosniff');
    return rejected;
  }
  const { resource } = await params;
  if (!['index', 'chapter'].includes(resource)) return response({ error: '阅读接口不存在。', code: 'SOURCE_RESOURCE_INVALID' }, 404);
  const query = req.nextUrl.searchParams;
  const title = cleanString(query.get('title'), 200);
  const author = cleanString(query.get('author') ?? '', 200);
  // 模糊候选的用户确认路径：前端点选候选后带上 book_url 重放，跳过书名/作者匹配。
  const bookUrl = cleanString(query.get('book_url') ?? '', 2048);
  const chapter = query.get('chapter') ?? '';
  const session = query.get('session') ?? '';
  if (resource === 'index' && (!title || (query.get('author') && !author))) {
    return response({ error: '请输入有效的书名和作者。', code: 'SOURCE_BOOK_INVALID' }, 400);
  }
  if (resource === 'chapter' && (!/^[a-f0-9]{40}$/.test(session) || query.get('version') !== session
    || !/^(0|[1-9]\d*)$/.test(chapter) || !Number.isSafeInteger(Number(chapter))
    || Number(chapter) >= 10_000 || (query.get('part') ?? '0') !== '0')) {
    return response({ error: '章节、目录会话或版本无效。', code: 'SOURCE_CHAPTER_INVALID' }, 400);
  }
  const deadline = createDeadline(55_000);
  const signal = AbortSignal.any([req.signal, deadline.signal]);
  try {
    const context = new SourceRequestContext(signal);
    if (resource === 'index') {
      await raceDeadline(signal, ensureSchema);
      const catalog = await resolveSourceBook({ title, author }, context, bookUrl ? { bookUrl } : {});
      await saveSourceCatalog(catalog, signal);
      return response(sourceReaderIndex(catalog));
    }
    return response(await readSourceChapter(session, Number(chapter), context));
  } catch (error) {
    if (signal.aborted) return response({ error: '书源查询已取消或超时，可重试或尝试「下载全书」。', code: 'SOURCE_TIMEOUT' }, 504);
    if (error instanceof SourceReaderError) {
      const body: Record<string, unknown> = { error: error.message, code: error.code };
      // 模糊降级层：把候选列表带回前端供用户点选确认。
      const candidates = (error as SourceReaderError & { candidates?: unknown }).candidates;
      if (Array.isArray(candidates)) body.candidates = candidates;
      return response(body, error.status);
    }
    if (error instanceof SourcePolicyError) return response({ error: '书源内容或地址未通过校验，可尝试「下载全书」。', code: 'SOURCE_REJECTED' }, 422);
    console.error('Source reader request failed');
    return response({ error: '书源阅读服务暂时不可用，请稍后重试。', code: 'SOURCE_INTERNAL' }, 500);
  } finally {
    deadline.dispose();
  }
}
