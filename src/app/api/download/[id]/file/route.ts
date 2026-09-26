import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { authJson, withAuthHeaders } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { boundedPositiveInteger } from '@/lib/http';
import { sanitizeBookFilename } from '@/lib/book-file-name';
import { locateBookFile } from '@/lib/book-file-locator';
import {
  artifactContentsRoot, artifactContentsUrl, locateTaskArtifact, type ArtifactLocation,
} from '@/lib/artifact-locator';
import { BodyReadError, encodeArtifactPath, gitBlobSha, readBoundedBody } from '@/lib/artifact-bytes';
import { MAX_MANIFEST_BYTES, isVolumeManifestPath, parseVolumeManifest, volumeReadPaths } from '@/lib/volume-manifest';
import type { VolumeEntry, VolumeManifest } from '@/lib/volume-manifest';
import { MAX_READER_BYTES } from '@/lib/txt-chapters';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

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
    readonly code: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT',
    readonly status: number,
  ) {
    super(message);
  }
}

async function fetchChecked(url: string, accept: string, signal: AbortSignal): Promise<Response | null> {
  const res = await fetch(url, {
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

async function githubResponse(path: string, accept: string, signal: AbortSignal, artifactUrl?: string): Promise<Response | null> {
  return fetchChecked(artifactUrl ?? contentsUrl(path), accept, signal);
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
  const file = await locateBookFile({ files: names.map(name => ({ name })), truncated: listing.length >= 1000 }, title, author, async (name) => {
    const metadata = await githubResponse(`${BOOKS_DIR}/${encodeURIComponent(name)}`, 'application/vnd.github.object+json', signal);
    if (!metadata) return null;
    const value: unknown = await metadata.json();
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'file'
      || !('name' in value) || value.name !== name) {
      throw new FileUpstreamError('文件服务返回了无效文件信息，请稍后重试', 'UPSTREAM_ERROR', 502);
    }
    return { name };
  });
  return file?.name ?? null;
}

// 直接请求 raw 文件流,避免 JSON/base64 解码或整体缓冲 TXT
async function readFile(name: string, signal: AbortSignal, artifactUrl?: string): Promise<ReadableStream<Uint8Array> | null> {
  const path = `${BOOKS_DIR}/${encodeURIComponent(name)}`;
  const res = await githubResponse(path, 'application/vnd.github.raw', signal, artifactUrl);
  if (!res) return null;
  if (!res.body) {
    throw new FileUpstreamError('文件服务返回了空响应，请稍后重试', 'UPSTREAM_ERROR', 502);
  }
  return res.body;
}

/** 下载响应头(v2 分卷与旧单文件同款:文件名 .txt、不缓存)。 */
function downloadHeaders(title: string): Record<string, string> {
  const downloadName = `${sanitizeBookFilename(title) || 'novel'}.txt`;
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    // filename* 带 UTF-8 编码的中文名,filename 给不支持 RFC 5987 的客户端兜底
    'Content-Disposition':
      `attachment; filename="novel.txt"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie, Authorization, X-Owner-Token',
  };
}

/** 有界缓冲失败 → 下载端错误(readBoundedBody 只管机制,措辞与状态码在此一处翻译)。 */
function bodyReadError(error: unknown): unknown {
  if (!(error instanceof BodyReadError)) return error;
  switch (error.reason) {
    case 'too-large': return new FileUpstreamError('文件服务返回的文件异常，请稍后重试', 'UPSTREAM_ERROR', 502);
    case 'empty': return new FileUpstreamError('文件服务返回了空响应，请稍后重试', 'UPSTREAM_ERROR', 502);
    case 'invalid-utf8': return new FileUpstreamError('文件服务返回了非 UTF-8 文本，请稍后重试', 'UPSTREAM_ERROR', 502);
    case 'timeout': return new FileUpstreamError('文件服务响应超时，请稍后重试', 'UPSTREAM_TIMEOUT', 504);
    default: return new FileUpstreamError('文件服务暂不可用，请稍后重试', 'UPSTREAM_ERROR', 502);
  }
}

/**
 * 取 v2 artifact 的清单(raw 有界,上限与读端同值 MAX_MANIFEST_BYTES)。文件 404 → null;
 * 内容解析失败 → 502(判据是读端同一份 parseVolumeManifest,绝不猜)。
 */
async function readVolumeManifest(root: string, canonicalPath: string, signal: AbortSignal): Promise<VolumeManifest | null> {
  const res = await fetchChecked(`${root}/${encodeArtifactPath(canonicalPath)}`, 'application/vnd.github.raw', signal);
  if (!res) return null;
  let bytes: Buffer;
  try {
    bytes = await readBoundedBody(res, MAX_MANIFEST_BYTES);
  } catch (error) {
    throw bodyReadError(error);
  }
  const manifest = parseVolumeManifest(bytes);
  if (!manifest) {
    throw new FileUpstreamError('文件服务返回了无效的章节目录，请稍后重试', 'UPSTREAM_ERROR', 502);
  }
  return manifest;
}

/** 按 volumeReadPaths 次序取卷(快照卷 404 才回退规范卷);都缺 → null。 */
async function fetchVolume(root: string, entry: VolumeEntry, signal: AbortSignal): Promise<Response | null> {
  for (const path of volumeReadPaths(entry)) {
    const res = await fetchChecked(`${root}/${encodeArtifactPath(path)}`, 'application/vnd.github.raw', signal);
    if (res) return res;
  }
  return null;
}

/**
 * v2 产物下载:按清单顺序逐卷取回并顺序下发。卷级用与读端同一个 `gitBlobSha` 校验
 * (清单声明 sha ≠ 实取字节 ⇒ 拒绝,绝不下发半新半旧的书)。`pull` 驱动、一次一卷 ⇒
 * 天然背压,整本正文永不进内存(峰值 ≈ 单卷 16 MiB)。
 */
function volumeConcatStream(root: string, manifest: VolumeManifest, signal: AbortSignal): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const entry = manifest.volumes[index];
        if (!entry) {
          controller.close();
          return;
        }
        const res = await fetchVolume(root, entry, signal);
        if (!res) throw new FileUpstreamError('文件服务缺少分卷，请稍后重试', 'UPSTREAM_ERROR', 502);
        let bytes: Buffer;
        try {
          bytes = await readBoundedBody(res, MAX_READER_BYTES);
        } catch (error) {
          throw bodyReadError(error);
        }
        if (gitBlobSha(bytes) !== entry.blob_sha) {
          throw new FileUpstreamError('书籍文件已更新，请重新下载', 'UPSTREAM_ERROR', 409);
        }
        index++;
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** v2 分卷产物的下载响应:清单 + 各卷拼接成的整本正文(而非清单 JSON)。 */
async function downloadVolumeBook(artifact: ArtifactLocation, title: string, signal: AbortSignal): Promise<NextResponse> {
  const root = artifactContentsRoot(artifact);
  const manifest = await readVolumeManifest(root, artifact.canonical_path, signal);
  if (!manifest) {
    return authJson({ error: 'file not found', code: 'FILE_NOT_FOUND' }, { status: 404 });
  }
  return new NextResponse(volumeConcatStream(root, manifest, signal), {
    status: 200,
    headers: downloadHeaders(title),
  });
}

async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePermission(req, 'download');
  if (!auth.ok) return withAuthHeaders(auth.response);
  const { id } = await params;
  const taskId = boundedPositiveInteger(id);
  if (taskId === null) {
    return authJson({ error: 'invalid id', code: 'INVALID_ID' }, { status: 400 });
  }
  const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  const signal = AbortSignal.any([req.signal, timeout]);
  let task: { id: number; title: string; author: string; status: string; artifact_id?: string | null };
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      SELECT id, title, author, status, to_jsonb(download_tasks)->>'artifact_id' AS artifact_id FROM download_tasks
      WHERE id = ${taskId} AND requested_by = 'user' AND user_id = ${auth.principal.userId}`) as {
      id: number;
      title: string;
      author: string;
      status: string;
      artifact_id?: string | null;
    }[];
    if (rows.length === 0) {
      return authJson({ error: 'task not found', code: 'TASK_NOT_FOUND' }, { status: 404 });
    }
    task = rows[0];
    if (task.status !== 'done') {
      return authJson({ error: '任务尚未完成', code: 'TASK_NOT_READY' }, { status: 400 });
    }
  } catch (e) {
    console.error(e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }

  if (!process.env.GITHUB_TOKEN) {
    return authJson({ error: 'file service is not configured', code: 'FILE_SERVICE_NOT_CONFIGURED' }, { status: 503 });
  }

  try {
    signal.throwIfAborted();
    const artifact = task.artifact_id == null ? null : await locateTaskArtifact(getSql(), task.artifact_id);
    // v2 分卷产物:canonical_path 指向清单(index.json),正文在分卷里 —— 下载必须像阅读端
    // 一样分流并拼接正文;旧单文件产物(非 index.json)行为逐字不变。
    if (artifact && isVolumeManifestPath(artifact.canonical_path)) {
      return await downloadVolumeBook(artifact, task.title, signal);
    }
    const name = artifact ? artifact.canonical_path : await findBookName(task.title, task.author, signal);
    if (!name) {
      return authJson({ error: 'file not found', code: 'FILE_NOT_FOUND' }, { status: 404 });
    }
    const body = await readFile(name, signal, artifact ? artifactContentsUrl(artifact) : undefined);
    if (!body) {
      return authJson({ error: 'file not found', code: 'FILE_NOT_FOUND' }, { status: 404 });
    }

    return new NextResponse(body, { status: 200, headers: downloadHeaders(task.title) });
  } catch (e) {
    console.error(e);
    if (req.signal.aborted && !timeout.aborted) {
      return authJson({ error: '请求已取消', code: 'REQUEST_ABORTED' }, { status: 499 });
    }
    if (timeout.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))) {
      return authJson({ error: '文件服务响应超时，请稍后重试', code: 'UPSTREAM_TIMEOUT' }, { status: 504 });
    }
    if (e instanceof FileUpstreamError) {
      return authJson({ error: e.message, code: e.code }, { status: e.status });
    }
    return authJson({ error: '文件服务暂不可用，请稍后重试', code: 'UPSTREAM_ERROR' }, { status: 502 });
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
