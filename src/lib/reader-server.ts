import { createHash } from 'node:crypto';
import { getSql } from '@/lib/db';
import { locateBookFile } from '@/lib/book-file-locator';
import { MAX_READER_BYTES, parseTxtChapters, splitChapterParts } from '@/lib/txt-chapters';
import type { ByteRange } from '@/lib/txt-chapters';
import type { ReaderChapter, ReaderIndex, ReaderPart } from '@/lib/reader-types';

const DIRECTORY_TTL_MS = 5 * 60_000;
const MAX_CACHED_BOOKS = 3;
const MAX_CACHED_BYTES = 48 * 1024 * 1024;
const MAX_PENDING_BOOKS = 2;
const METADATA_TIMEOUT_MS = 15_000;
const TEXT_TIMEOUT_MS = 60_000;
const MAX_INDEX_JSON_BYTES = 4 * 1024 * 1024;

export class ReaderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ReaderError';
  }
}

export interface ReadableTask {
  id: number;
  title: string;
  author: string;
  status: string;
}

interface BookFile {
  name: string;
  sha: string;
  size: number;
}

interface Source {
  key: string;
  baseUrl: string;
  token: string;
}

interface Directory {
  sourceKey: string;
  expiresAt: number;
  files: BookFile[];
  truncated: boolean;
}

interface CachedBook {
  bytes: Buffer;
  version: string;
  chapters: ReaderChapter[];
  parts: ByteRange[][];
}

let directory: Directory | undefined;
let directoryPending: { key: string; promise: Promise<Directory> } | undefined;
const books = new Map<string, CachedBook>();
const pendingBooks = new Map<string, Promise<CachedBook>>();
let cachedBytes = 0;

function getSource(): Source {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new ReaderError('文件服务尚未配置，请联系站点所有者。', 503);
  const repo = process.env.ZHAOSHU_BOOKS_REPO || 'CitizenScyu/zhaoshu-books';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new ReaderError('文件服务配置有误。', 503);
  }
  return {
    key: `${repo}:${createHash('sha256').update(token).digest('hex')}`,
    baseUrl: `https://api.github.com/repos/${repo}/contents/books`,
    token,
  };
}

async function githubFetch(source: Source, name?: string, raw = false): Promise<Response> {
  try {
    const response = await fetch(`${source.baseUrl}${name ? `/${encodeURIComponent(name)}` : ''}`, {
      headers: {
        Authorization: `Bearer ${source.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : name
          ? 'application/vnd.github.object+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'novel-finder-reader/1.0',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(raw ? TEXT_TIMEOUT_MS : METADATA_TIMEOUT_MS),
    });
    if (response.status === 404) return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 403 || response.status === 429) {
        throw new ReaderError('文件服务暂时不可用，请稍后重试。', 503);
      }
      throw new ReaderError('读取书籍文件失败，请稍后重试。', 502);
    }
    return response;
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ReaderError('读取书籍超时，请重试。', 504);
    }
    throw new ReaderError('暂时无法连接文件服务，请重试。', 502);
  }
}

async function githubJson(response: Response): Promise<unknown> {
  // Fetch resolves when headers arrive; body timeouts and malformed JSON must
  // keep the same upstream error handling as failures before the headers.
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ReaderError('读取书籍超时，请重试。', 504);
    }
    throw new ReaderError('书籍文件信息读取失败，请稍后重试。', 502);
  }
}

function parseFile(value: unknown): BookFile | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as Record<string, unknown>;
  if (file.type !== 'file' || typeof file.name !== 'string' || !file.name.endsWith('.txt')
    || typeof file.sha !== 'string' || !/^[a-f0-9]{40}$/.test(file.sha)
    || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) return null;
  return { name: file.name, sha: file.sha, size: file.size };
}

async function getDirectory(source: Source): Promise<Directory> {
  if (directory?.sourceKey === source.key && directory.expiresAt > Date.now()) return directory;
  if (directoryPending?.key === source.key) return directoryPending.promise;
  const promise = (async () => {
    const response = await githubFetch(source);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReaderError('书籍目录不存在或文件服务没有访问权限。', 404);
    }
    const value = await githubJson(response);
    if (!Array.isArray(value)) throw new ReaderError('书籍目录格式有误，请稍后重试。', 502);
    const result: Directory = {
      sourceKey: source.key,
      expiresAt: Date.now() + DIRECTORY_TTL_MS,
      files: value.map(parseFile).filter((file): file is BookFile => file !== null),
      truncated: value.length >= 1000,
    };
    directory = result;
    return result;
  })();
  directoryPending = { key: source.key, promise };
  try {
    return await promise;
  } finally {
    if (directoryPending?.promise === promise) directoryPending = undefined;
  }
}

async function locateFile(source: Source, task: ReadableTask): Promise<BookFile | null> {
  const listing = await getDirectory(source);
  return locateBookFile(listing, task.title, task.author, async (expected) => {
    const response = await githubFetch(source, expected);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const file = parseFile(await githubJson(response));
    if (!file || file.name !== expected) throw new ReaderError('书籍文件信息有误，请稍后重试。', 502);
    if (listing.files.length < 1100) listing.files.push(file);
    return file;
  });
}

export async function getReadableTask(taskId: number, viewerId: number): Promise<ReadableTask> {
  // Reading is deliberately read-only: these tables already exist for every
  // download task. Do not run ensureSchema's DDL on a chapter navigation.
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, author, status, user_id FROM download_tasks WHERE id = ${taskId}` as (ReadableTask & { user_id: number })[];
  const task = rows[0];
  // 已完成 TXT 是共享的，但他人未完成任务的存在性和状态不能透出：与不存在的任务同样返回 404。
  if (!task || (task.status !== 'done' && task.user_id !== viewerId)) {
    throw new ReaderError('下载任务不存在。', 404);
  }
  if (task.status !== 'done') throw new ReaderError('下载尚未完成，请完成下载后再阅读。', 409);
  return { id: task.id, title: task.title, author: task.author, status: task.status };
}

export async function readerAvailability(task: ReadableTask): Promise<{ available: boolean }> {
  const file = await locateFile(getSource(), task);
  return { available: file !== null && file.size > 0 && file.size <= MAX_READER_BYTES };
}

async function readBytes(source: Source, file: BookFile): Promise<Buffer> {
  if (file.size > MAX_READER_BYTES) throw new ReaderError('暂不支持超过 16 MiB 的 TXT 文件。', 413);
  const response = await githubFetch(source, file.name, true);
  if (response.status === 404) {
    directory = undefined;
    await response.body?.cancel().catch(() => undefined);
    throw new ReaderError('书籍文件不存在，请返回书库检查下载任务。', 404);
  }
  if (!response.body) throw new ReaderError('书籍文件为空。', 422);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_READER_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new ReaderError('暂不支持超过 16 MiB 的 TXT 文件。', 413);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_READER_BYTES) throw new ReaderError('暂不支持超过 16 MiB 的 TXT 文件。', 413);
      // Validate incrementally without retaining a decoded copy of the book.
      try {
        decoder.decode(value, { stream: true });
      } catch {
        throw new ReaderError('TXT 需要使用 UTF-8 编码，请重新下载或转换文件。', 422);
      }
      chunks.push(value);
    }
    try {
      decoder.decode();
    } catch {
      throw new ReaderError('TXT 需要使用 UTF-8 编码，请重新下载或转换文件。', 422);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ReaderError) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ReaderError('读取书籍超时，请重试。', 504);
    }
    throw new ReaderError('书籍传输中断，请重试。', 502);
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new ReaderError('书籍文件为空。', 422);
  return Buffer.concat(chunks, size);
}

function cacheBook(key: string, book: CachedBook) {
  const old = books.get(key);
  if (old) cachedBytes -= old.bytes.byteLength;
  books.delete(key);
  books.set(key, book);
  cachedBytes += book.bytes.byteLength;
  while (books.size > MAX_CACHED_BOOKS || cachedBytes > MAX_CACHED_BYTES) {
    const oldestKey = books.keys().next().value;
    if (oldestKey === undefined) break;
    cachedBytes -= books.get(oldestKey)!.bytes.byteLength;
    books.delete(oldestKey);
  }
}

async function getBook(task: ReadableTask): Promise<CachedBook> {
  const source = getSource();
  const file = await locateFile(source, task);
  if (!file) throw new ReaderError('书籍文件不存在，请返回书库检查下载任务。', 404);
  const key = `${source.key}/${file.name}:${file.sha}`;
  const existing = books.get(key);
  if (existing) {
    // Touch the LRU without copying the TXT buffer.
    books.delete(key);
    books.set(key, existing);
    return existing;
  }
  const pending = pendingBooks.get(key);
  if (pending) return pending;
  if (pendingBooks.size >= MAX_PENDING_BOOKS) {
    throw new ReaderError('正在准备其他书籍，请稍后重试。', 503);
  }
  const promise = (async () => {
    const bytes = await readBytes(source, file);
    // A blob SHA is not a Git ref. Hash the actual raw content so index and
    // chapter reads cannot silently mix revisions if the file changed mid-read.
    const version = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    const parsed = parseTxtChapters(bytes);
    if (!parsed.length) throw new ReaderError('书籍文件没有可阅读的正文。', 422);
    const parts = parsed.map((chapter) => splitChapterParts(bytes, chapter));
    const chapters = parsed.map((chapter, index) => ({ ...chapter, partCount: parts[index].length }));
    const book: CachedBook = { bytes, version, chapters, parts };
    if (version !== file.sha) directory = undefined;
    cacheBook(`${source.key}/${file.name}:${version}`, book);
    return book;
  })().catch((error) => {
    // Normalize before sharing the promise so concurrent readers receive the
    // same public status when the parser rejects an unsupported TXT.
    if (error instanceof RangeError) throw new ReaderError(error.message, 422);
    throw error;
  });
  pendingBooks.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingBooks.delete(key);
  }
}

export async function readBookIndex(task: ReadableTask): Promise<ReaderIndex> {
  const book = await getBook(task);
  const index: ReaderIndex = {
    taskId: task.id,
    title: task.title,
    author: task.author,
    version: book.version,
    totalBytes: book.bytes.byteLength,
    chapters: book.chapters,
  };
  // Escaped control characters can expand an otherwise small TXT directory.
  // Bound the actual JSON response below the hosting platform's payload limit.
  if (Buffer.byteLength(JSON.stringify(index), 'utf8') > MAX_INDEX_JSON_BYTES) {
    throw new ReaderError('章节目录过大，暂时无法在线阅读这本书。', 422);
  }
  return index;
}

export async function readBookPart(
  task: ReadableTask,
  chapterIndex: number,
  partIndex: number,
  expectedVersion: string,
): Promise<ReaderPart> {
  const book = await getBook(task);
  if (expectedVersion !== book.version) throw new ReaderError('书籍文件已更新，请重新加载目录。', 409);
  const chapter = book.chapters[chapterIndex];
  const part = book.parts[chapterIndex]?.[partIndex];
  if (!chapter || !part) throw new ReaderError('章节或段落不存在。', 400);
  return {
    taskId: task.id,
    version: book.version,
    chapterIndex,
    partIndex,
    partCount: chapter.partCount,
    title: chapter.title,
    startByte: part.startByte,
    endByte: part.endByte,
    text: book.bytes.toString('utf8', part.startByte, part.endByte),
  };
}
