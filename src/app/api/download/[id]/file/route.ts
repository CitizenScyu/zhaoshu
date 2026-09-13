import { NextRequest, NextResponse } from 'next/server';
import { requireApiOwner } from '@/lib/auth';
import { ensureSchema, getSql } from '@/lib/db';

// 下载完成的任务取回 TXT:文件在 GitHub 私库 CitizenScyu/zhaoshu-books 的 books/ 下
export const maxDuration = 60;

const REPO = process.env.ZHAOSHU_BOOKS_REPO || 'CitizenScyu/zhaoshu-books';
const BOOKS_DIR = 'books';
const UA = { 'User-Agent': 'zhaoshu-downloader/1.0' };

// 必须与 zhaoshu-books/worker.mjs 的 sanitizeFilename 完全一致:
// 非法字符删除(不转空格)、控制字符删除、空白折叠、结尾去横杠/空格、截 80 字符
function sanitizeFilename(s: string): string {
  const name = String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-\s]+$/, '');
  return name.length > 80 ? name.slice(0, 80).replace(/[-\s]+$/, '') : name;
}

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

// 在 books/ 目录里按 worker 的命名规则定位文件:先精确匹配,再按书名前缀兜底
async function findBookName(title: string, author: string): Promise<string | null> {
  const res = await fetch(contentsUrl(BOOKS_DIR), {
    headers: ghHeaders('application/vnd.github+json'),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`GitHub 目录读取失败: HTTP ${res.status}`);
  }
  const listing: unknown = await res.json();
  if (!Array.isArray(listing)) return null;
  const names = listing
    .map((e) => (e as Partial<DirEntry>)?.name)
    .filter((n): n is string => typeof n === 'string' && n.endsWith('.txt'));
  if (names.length === 0) return null;

  const exact = `${sanitizeFilename(`${title}-${author}`)}.txt`;
  if (names.includes(exact)) return exact;

  // 兜底:书名部分前缀命中(作者名可能被 worker 截断或写过不同写法)
  const titlePrefix = sanitizeFilename(title);
  if (titlePrefix) {
    const loose = names.filter((n) => n.startsWith(`${titlePrefix}-`));
    if (loose.length === 1) return loose[0];
  }
  return null;
}

// base64 content 优先(contents API 常规返回),文件 >1MB 时无 content,退回 raw 媒体类型
async function readFile(name: string): Promise<Uint8Array | null> {
  const path = `${BOOKS_DIR}/${encodeURIComponent(name)}`;
  const res = await fetch(contentsUrl(path), {
    headers: ghHeaders('application/vnd.github+json'),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub 文件读取失败: HTTP ${res.status}`);
  }
  const meta = (await res.json()) as { content?: string; encoding?: string };
  if (typeof meta.content === 'string' && meta.encoding === 'base64') {
    return new Uint8Array(Buffer.from(meta.content.replace(/\s/g, ''), 'base64'));
  }

  const raw = await fetch(contentsUrl(path), {
    headers: ghHeaders('application/vnd.github.raw'),
    cache: 'no-store',
  });
  if (!raw.ok) {
    throw new Error(`GitHub 原始文件读取失败: HTTP ${raw.status}`);
  }
  return new Uint8Array(await raw.arrayBuffer());
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const taskId = Number(id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json({ error: 'GITHUB_TOKEN is not configured' }, { status: 503 });
  }
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
      return NextResponse.json({ error: 'task not found' }, { status: 404 });
    }
    const task = rows[0];
    if (task.status !== 'done') {
      return NextResponse.json({ error: '任务尚未完成' }, { status: 400 });
    }

    const name = await findBookName(task.title, task.author);
    if (!name) {
      return NextResponse.json({ error: 'file not found' }, { status: 404 });
    }
    const bytes = await readFile(name);
    if (!bytes) {
      return NextResponse.json({ error: 'file not found' }, { status: 404 });
    }

    const downloadName = `${sanitizeFilename(task.title) || 'novel'}.txt`;
    // Blob 而非裸 Uint8Array:后者在 TS 的 BodyInit 类型下不被接受
    return new NextResponse(new Blob([bytes as BlobPart]), {
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
    return NextResponse.json({ error: 'file not found' }, { status: 404 });
  }
}
