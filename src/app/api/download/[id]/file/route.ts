import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';
import { boundedPositiveInteger } from '@/lib/http';
import { findBookFilename, sanitizeBookFilename } from '@/lib/book-file-name';

// 下载完成的任务取回 TXT:文件在 GitHub 私库 CitizenScyu/zhaoshu-books 的 books/ 下
export const maxDuration = 60;

const REPO = process.env.ZHAOSHU_BOOKS_REPO || 'CitizenScyu/zhaoshu-books';
const BOOKS_DIR = 'books';
// One budget spans lookup and the raw stream, leaving room below maxDuration.
const GITHUB_TIMEOUT_MS = 55_000;
const UA = { 'User-Agent': 'zhaoshu-downloader/1.0' };

interface DirEntry {
  name: string;
}

function ghHeaders(accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    ...UA,
  };
}

function contentsUrl(path: string): string {
  // worker 写入时对文件名做了 encodeURIComponent,请求路径必须同样编码
  return `https://api.github.com/repos/${REPO}/contents/${path}`;
}

class FileUpstreamError extends Error {
  constructor(
    message: string,
    readonly code: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_ERROR',
    readonly status: number,
  ) {
    super(message);
  }
}

async function githubResponse(path: string, accept: string, signal: AbortSignal): Promise<Response | null> {
  const res = await fetch(contentsUrl(path), {
    headers: ghHeaders(accept),
    cache: 'no-store',
    signal,
  });
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    if (res.status === 404) return null;
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      throw new FileUpstreamError('文件服务请求受限，请稍后重试', 'UPSTREAM_RATE_LIMITED', 503);
    }
    throw new FileUpstreamError('文件服务暂不可用，请稍后重试', 'UPSTREAM_ERROR', 502);
  }
  return res;
}

// 在 books/ 目录里按 worker 的命名规则定位文件:先精确匹配,再按书名前缀兜底
async function findBookName(title: string, author: string, signal: AbortSignal): Promise<string | null> {
  const res = await githubResponse(BOOKS_DIR, 'application/vnd.github+json', signal);
  if (!res) return null;
  const listing: unknown = await res.json();
  if (!Array.isArray(listing)) {
    throw new FileUpstreamError('文件服务返回了无效目录，请稍后重试', 'UPSTREAM_ERROR', 502);
  }
  const names = listing
    .map((e) => (e as Partial<DirEntry>)?.name)
    .filter((n): n is string => typeof n === 'string' && n.endsWith('.txt'));
  if (names.length === 0) return null;

  return findBookFilename(names, title, author);
}

// 直接请求 raw 文件流,避免 JSON/base64 解码或整体缓冲 TXT
async function readFile(name: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
  const path = `${BOOKS_DIR}/${encodeURIComponent(name)}`;
  const res = await githubResponse(path, 'application/vnd.github.raw', signal);
  if (!res) return null;
  if (!res.body) {
    throw new FileUpstreamError('文件服务返回了空响应，请稍后重试', 'UPSTREAM_ERROR', 502);
  }
  return res.body;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const taskId = boundedPositiveInteger(id);
  if (taskId === null) {
    return NextResponse.json({ error: 'invalid id', code: 'INVALID_ID' }, { status: 400 });
  }
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json({ error: 'GITHUB_TOKEN is not configured', code: 'FILE_SERVICE_NOT_CONFIGURED' }, { status: 503 });
  }
  const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  const signal = AbortSignal.any([req.signal, timeout]);
  let task: { id: number; title: string; author: string; status: string };
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      SELECT id, title, author, status FROM download_tasks WHERE id = ${taskId}`) as {
      id: number;
      title: string;
      author: string;
      status: string;
    }[];
    if (rows.length === 0) {
      return NextResponse.json({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
    }
    task = rows[0];
    if (task.status !== 'done') {
      return NextResponse.json({ error: '任务尚未完成', code: 'TASK_NOT_READY' }, { status: 400 });
    }
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }

  try {
    signal.throwIfAborted();
    const name = await findBookName(task.title, task.author, signal);
    if (!name) {
      return NextResponse.json({ error: 'file not found', code: 'FILE_NOT_FOUND' }, { status: 404 });
    }
    const body = await readFile(name, signal);
    if (!body) {
      return NextResponse.json({ error: 'file not found', code: 'FILE_NOT_FOUND' }, { status: 404 });
    }

    const downloadName = `${sanitizeBookFilename(task.title) || 'novel'}.txt`;
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        // filename* 带 UTF-8 编码的中文名,filename 给不支持 RFC 5987 的客户端兜底
        'Content-Disposition':
          `attachment; filename="novel.txt"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    console.error(e);
    if (req.signal.aborted && !timeout.aborted) {
      return NextResponse.json({ error: '请求已取消', code: 'REQUEST_ABORTED' }, { status: 499 });
    }
    if (timeout.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))) {
      return NextResponse.json({ error: '文件服务响应超时，请稍后重试', code: 'UPSTREAM_TIMEOUT' }, { status: 504 });
    }
    if (e instanceof FileUpstreamError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    return NextResponse.json({ error: '文件服务暂不可用，请稍后重试', code: 'UPSTREAM_ERROR' }, { status: 502 });
  }
}
