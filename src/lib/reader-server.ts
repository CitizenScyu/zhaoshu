import { createHash } from 'node:crypto';
import { getSql } from '@/lib/db';
import { locateBookFile } from '@/lib/book-file-locator';
import {
  artifactContentsRoot, artifactContentsUrl, locateTaskArtifact, type ArtifactLocation,
} from '@/lib/artifact-locator';
import { BodyReadError, encodeArtifactPath, gitBlobSha, readBoundedBody } from '@/lib/artifact-bytes';
import { MAX_READER_BYTES, parseTxtChapters, splitChapterParts } from '@/lib/txt-chapters';
import type { ByteRange } from '@/lib/txt-chapters';
import { MAX_MANIFEST_BYTES, isVolumeManifestPath, parseVolumeManifest } from '@/lib/volume-manifest';
import type { VolumeEntry, VolumeManifest } from '@/lib/volume-manifest';
import type { ReaderChapter, ReaderIndex, ReaderPart } from '@/lib/reader-types';

const DIRECTORY_TTL_MS = 5 * 60_000;
const MAX_CACHED_VOLUMES = 8;
const MAX_CACHED_VOLUME_BYTES = 64 * 1024 * 1024;
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
  artifact_id?: string | number | null;
}

interface BookFile {
  name: string;
  sha: string;
  size: number;
}

interface Source {
  key: string;
  /** contents API 根(无路径);相对路径追加到它后面。 */
  baseUrl: string;
  token: string;
  /** 旧单文件产物:目录定位直接返回它,且用 `fileUrl` 取字节(绝对 URL,不再拼路径)。 */
  artifactFile?: BookFile;
  /** 旧单文件产物的绝对 contents URL。 */
  fileUrl?: string;
  /** v2 分卷产物的清单路径(= DB canonical_path,已按段百分号编码)。 */
  manifestPath?: string;
}

interface Directory {
  sourceKey: string;
  expiresAt: number;
  files: BookFile[];
  truncated: boolean;
}

interface CachedManifest {
  sourceKey: string;
  manifestPath: string;
  expiresAt: number;
  manifest: VolumeManifest;
}

let directory: Directory | undefined;
let directoryPending: { key: string; promise: Promise<Directory> } | undefined;
let cachedManifest: CachedManifest | undefined;
let manifestPending: { key: string; promise: Promise<VolumeManifest> } | undefined;
const volumes = new Map<string, Buffer>();
const pendingVolumes = new Map<string, Promise<Buffer>>();
let cachedVolumeBytes = 0;

function getSource(artifact: ArtifactLocation | null = null): Source {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new ReaderError('文件服务尚未配置,请联系站点所有者。', 503);
  const tokenKey = createHash('sha256').update(token).digest('hex');
  if (artifact) {
    const key = `${artifact.owner}/${artifact.repo}@${artifact.branch}:${tokenKey}`;
    // v2:canonical_path 指向章节/卷清单,卷是它的同目录兄弟 ⇒ 用仓库 contents 根取任意路径。
    if (isVolumeManifestPath(artifact.canonical_path)) {
      return { key, baseUrl: artifactContentsRoot(artifact), token, manifestPath: artifact.canonical_path };
    }
    // 旧单文件产物:行为逐字保持(绝对 URL 直取,不再拼路径)。
    return {
      key,
      baseUrl: artifactContentsRoot(artifact),
      token,
      artifactFile: { name: artifact.canonical_path, sha: artifact.blob_sha, size: Number(artifact.bytes) },
      fileUrl: artifactContentsUrl(artifact),
    };
  }
  const repo = process.env.ZHAOSHU_BOOKS_REPO || 'CitizenScyu/zhaoshu-books';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new ReaderError('文件服务配置有误。', 503);
  }
  return {
    key: `${repo}:${tokenKey}`,
    baseUrl: `https://api.github.com/repos/${repo}/contents/books`,
    token,
  };
}

/** 相对名字 → 绝对 contents URL;旧单文件产物用其自带绝对 URL。 */
function fileUrl(source: Source, name: string): string {
  if (source.fileUrl && source.artifactFile?.name === name) return source.fileUrl;
  return `${source.baseUrl}/${encodeArtifactPath(name)}`;
}

async function githubFetch(source: Source, name?: string, raw = false): Promise<Response> {
  try {
    const response = await fetch(name === undefined ? source.baseUrl : fileUrl(source, name), {
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
        throw new ReaderError('文件服务暂时不可用,请稍后重试。', 503);
      }
      throw new ReaderError('读取书籍文件失败,请稍后重试。', 502);
    }
    return response;
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ReaderError('读取书籍超时,请重试。', 504);
    }
    throw new ReaderError('暂时无法连接文件服务,请重试。', 502);
  }
}

async function githubJson(response: Response): Promise<unknown> {
  // Fetch resolves when headers arrive; body timeouts and malformed JSON must
  // keep the same upstream error handling as failures before the headers.
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ReaderError('读取书籍超时,请重试。', 504);
    }
    throw new ReaderError('书籍文件信息读取失败,请稍后重试。', 502);
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
    if (!Array.isArray(value)) throw new ReaderError('书籍目录格式有误,请稍后重试。', 502);
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
  if (source.artifactFile) return source.artifactFile;
  const listing = await getDirectory(source);
  return locateBookFile(listing, task.title, task.author, async (expected) => {
    const response = await githubFetch(source, expected);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const file = parseFile(await githubJson(response));
    if (!file || file.name !== expected) throw new ReaderError('书籍文件信息有误,请稍后重试。', 502);
    if (listing.files.length < 1100) listing.files.push(file);
    return file;
  });
}

export async function getReadableTask(taskId: number, viewerId: number): Promise<ReadableTask> {
  // Reading is deliberately read-only: these tables already exist for every
  // download task. Do not run ensureSchema's DDL on a chapter navigation.
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, author, status, user_id, to_jsonb(download_tasks)->>'artifact_id' AS artifact_id
    FROM download_tasks WHERE id = ${taskId}` as (ReadableTask & { user_id: number })[];
  const task = rows[0];
  // 已完成 TXT 是共享的,但他人未完成任务的存在性和状态不能透出:与不存在的任务同样返回 404。
  if (!task || (task.status !== 'done' && task.user_id !== viewerId)) {
    throw new ReaderError('下载任务不存在。', 404);
  }
  if (task.status !== 'done') throw new ReaderError('下载尚未完成,请完成下载后再阅读。', 409);
  return { id: task.id, title: task.title, author: task.author, status: task.status,
    ...(task.artifact_id != null ? { artifact_id: task.artifact_id } : {}) };
}

async function taskSource(task: ReadableTask): Promise<Source> {
  // 若上一次取元数据时目录已被标脏,先清空再重建(旧实现用 await 调度点达成的效果)。
  // 不这样做的话,「目录缓存失效 → 立刻重取」在同一微任务里会看到脏缓存。
  if (directory === undefined || directory.expiresAt <= Date.now()) directoryPending = undefined;
  return getSource(task.artifact_id == null ? null : await locateTaskArtifact(getSql(), task.artifact_id));
}

export async function readerAvailability(task: ReadableTask): Promise<{ available: boolean }> {
  const source = await taskSource(task);
  if (source.manifestPath !== undefined) {
    // v2:可取 + 可解析即为可读,不再有大小门槛(读代价是 O(卷))。
    try {
      await readManifest(source);
      return { available: true };
    } catch (error) {
      if (error instanceof ReaderError && error.status === 404) return { available: false };
      throw error;
    }
  }
  const file = await locateFile(source, task);
  return { available: file !== null && file.size > 0 && file.size <= MAX_READER_BYTES };
}

/** 有界缓冲的失败 → 读端错误:措辞与状态码在此一处翻译(readBoundedBody 只管机制)。 */
function bodyReadFailure(error: unknown, tooLarge: string): unknown {
  if (!(error instanceof BodyReadError)) return error;
  switch (error.reason) {
    case 'too-large': return new ReaderError(tooLarge, 413);
    case 'empty': return new ReaderError('书籍文件为空。', 422);
    case 'invalid-utf8': return new ReaderError('TXT 需要使用 UTF-8 编码,请重新下载或转换文件。', 422);
    case 'timeout': return new ReaderError('读取书籍超时,请重试。', 504);
    default: return new ReaderError('书籍传输中断,请重试。', 502);
  }
}

/**
 * Raw 流式拉取并做有界缓冲。`limit` 是**单文件**上限(卷与旧单文件都是 16 MiB;
 * 清单另给 4 MiB):防被篡改的清单让服务器去拉一个超大「卷」。
 * 有界缓冲机制在 artifact-bytes.readBoundedBody(与下载端共用),这里只做拉取与错误翻译。
 */
async function readBounded(source: Source, name: string, limit: number, tooLarge: string): Promise<Buffer> {
  const response = await githubFetch(source, name, true);
  if (response.status === 404) {
    directory = undefined;
    await response.body?.cancel().catch(() => undefined);
    throw new ReaderError('书籍文件不存在,请返回书库检查下载任务。', 404);
  }
  try {
    return await readBoundedBody(response, limit);
  } catch (error) {
    throw bodyReadFailure(error, tooLarge);
  }
}

function readBytes(source: Source, file: BookFile): Promise<Buffer> {
  if (file.size > MAX_READER_BYTES) {
    throw new ReaderError('书籍文件异常(超过 16 MiB),暂时无法阅读。', 413);
  }
  return readBounded(source, file.name, MAX_READER_BYTES, '书籍文件异常(超过 16 MiB),暂时无法阅读。');
}

/** 取清单(raw 流式;绝不走 JSON 信封的 getBytes 路径)。 */
async function readManifest(source: Source, force = false): Promise<VolumeManifest> {
  const key = `${source.key}@${source.manifestPath}`;
  if (!force && cachedManifest?.sourceKey === source.key
    && cachedManifest.manifestPath === source.manifestPath && cachedManifest.expiresAt > Date.now()) {
    return cachedManifest.manifest;
  }
  if (manifestPending?.key === key && !force) return manifestPending.promise;
  const path = source.manifestPath as string;
  const promise = (async () => {
    const bytes = await readBounded(source, path, MAX_MANIFEST_BYTES, '章节目录异常,暂时无法在线阅读这本书。');
    const manifest = parseVolumeManifest(bytes);
    if (!manifest) throw new ReaderError('章节目录格式有误,请稍后重试。', 502);
    cachedManifest = { sourceKey: source.key, manifestPath: path, expiresAt: Date.now() + DIRECTORY_TTL_MS, manifest };
    return manifest;
  })().catch((error: unknown) => {
    if (error instanceof ReaderError && error.status === 404) {
      throw new ReaderError('书籍文件不存在,请返回书库检查下载任务。', 404);
    }
    throw error;
  });
  if (!force) manifestPending = { key, promise };
  try {
    return await promise;
  } finally {
    if (manifestPending?.key === key && manifestPending.promise === promise) manifestPending = undefined;
  }
}

function cacheVolume(key: string, bytes: Buffer): void {
  const old = volumes.get(key);
  if (old) cachedVolumeBytes -= old.byteLength;
  volumes.delete(key);
  volumes.set(key, bytes);
  cachedVolumeBytes += bytes.byteLength;
  while (volumes.size > MAX_CACHED_VOLUMES || cachedVolumeBytes > MAX_CACHED_VOLUME_BYTES) {
    const oldest = volumes.keys().next().value;
    if (oldest === undefined) break;
    cachedVolumeBytes -= volumes.get(oldest)!.byteLength;
    volumes.delete(oldest);
  }
}

/** 卷字节与 git blob sha 不符:命中的可能正是「清单旧、卷新」的漂移窗。 */
class VolumeChangedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super('volume content changed');
    this.name = 'VolumeChangedError';
    this.path = path;
  }
}

async function getVolume(source: Source, entry: VolumeEntry, bypassCache = false): Promise<Buffer> {
  // 缓存键含 blob sha ⇒ 换版天然不串;卷是内容寻址字节,永不复用别的版本。
  const key = `${entry.path}@${entry.blob_sha}`;
  if (!bypassCache) {
    const existing = volumes.get(key);
    if (existing) {
      // Touch the LRU without copying the buffer.
      volumes.delete(key);
      volumes.set(key, existing);
      return existing;
    }
    const pending = pendingVolumes.get(key);
    if (pending) return pending;
    if (pendingVolumes.size >= MAX_PENDING_BOOKS) {
      throw new ReaderError('正在准备其他书籍,请稍后重试。', 503);
    }
  }
  const promise = (async () => {
    const bytes = await readBounded(source, entry.path, MAX_READER_BYTES, '卷文件异常,暂时无法阅读。');
    const sha = gitBlobSha(bytes);
    if (sha !== entry.blob_sha) throw new VolumeChangedError(entry.path);
    cacheVolume(key, bytes);
    return bytes;
  })();
  if (bypassCache) return promise;
  pendingVolumes.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingVolumes.delete(key);
  }
}

/** 按 [start, end) 全书偏移取字节:遍历重叠卷,逐卷校验卷级 sha,拼重叠片段(正常 1 卷)。 */
async function readRange(source: Source, manifest: VolumeManifest, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const entry of manifest.volumes) {
    if (entry.last_byte <= start || entry.first_byte >= end) continue;
    const bytes = await getVolume(source, entry);
    const from = Math.max(start, entry.first_byte) - entry.first_byte;
    const to = Math.min(end, entry.last_byte) - entry.first_byte;
    chunks.push(bytes.subarray(from, to));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total !== end - start) throw new ReaderError('章节目录格式有误,请稍后重试。', 502);
  return Buffer.concat(chunks, total);
}

/**
 * 卷级 sha 校验失败时的唯一补救路径(设计 §七 / §十四.4):
 * 重拉一次清单;版本已变(或重取的卷仍不符)→ 409,由客户端重载目录。
 * 任何情况下都不把「半新半旧」的字节当正常书返回 —— 这里直接抛出,调用方不产生正文。
 */
async function recoverVolumeDrift(source: Source, manifest: VolumeManifest, error: VolumeChangedError): Promise<never> {
  let refreshed: VolumeManifest | null = null;
  try {
    refreshed = await readManifest(source, true);
  } catch {
    refreshed = null;
  }
  if (refreshed && refreshed.version !== manifest.version) {
    throw new ReaderError('书籍文件已更新,请重新加载目录。', 409);
  }
  // 版本没变:再直取一次该卷(绕开缓存),仍不符则同样是「文件已更新」。
  const entry = manifest.volumes.find((volume) => volume.path === error.path);
  if (entry) {
    try {
      await getVolume(source, entry, true);
      throw new ReaderError('书籍文件已更新,请重新加载目录。', 409);
    } catch (retry) {
      if (retry instanceof ReaderError) throw retry;
    }
  }
  throw new ReaderError('书籍文件已更新,请重新加载目录。', 409);
}

/**
 * 章内分段(与发布侧同函数、同默认 32 KiB 段上限)。
 * 这里把「整本大小上限」放宽到 ≥ 本段字节数:大书的一个章不能因整本超限而被拒。
 */
function chapterParts(bytes: Buffer): ByteRange[] {
  return splitChapterParts(bytes, { startByte: 0, endByte: bytes.byteLength },
    undefined, Math.max(bytes.byteLength, MAX_READER_BYTES));
}

export async function readBookIndex(task: ReadableTask): Promise<ReaderIndex> {
  const source = await taskSource(task);
  if (source.manifestPath !== undefined) {
    const manifest = await readManifest(source);
    const chapters: ReaderChapter[] = manifest.chapter_index.map((entry) => ({
      index: entry.i,
      title: entry.t,
      startByte: entry.s,
      endByte: entry.e,
      partCount: entry.p,
    }));
    const index: ReaderIndex = {
      taskId: task.id,
      title: task.title,
      author: task.author,
      // 客户端与 /read 路由的 version 契约是 40 hex(blob sha),用清单声明的全书 sha。
      version: manifest.blob_sha,
      totalBytes: manifest.bytes,
      chapters,
    };
    // Escaped control characters can expand an otherwise small directory.
    if (Buffer.byteLength(JSON.stringify(index), 'utf8') > MAX_INDEX_JSON_BYTES) {
      throw new ReaderError('章节目录过大,暂时无法在线阅读这本书。', 422);
    }
    return index;
  }
  const book = await legacyBook(source, task);
  const index: ReaderIndex = {
    taskId: task.id,
    title: task.title,
    author: task.author,
    version: book.version,
    totalBytes: book.bytes.byteLength,
    chapters: book.chapters,
  };
  if (Buffer.byteLength(JSON.stringify(index), 'utf8') > MAX_INDEX_JSON_BYTES) {
    throw new ReaderError('章节目录过大,暂时无法在线阅读这本书。', 422);
  }
  return index;
}

export async function readBookPart(
  task: ReadableTask,
  chapterIndex: number,
  partIndex: number,
  expectedVersion: string,
): Promise<ReaderPart> {
  const source = await taskSource(task);
  if (source.manifestPath !== undefined) {
    const manifest = await readManifest(source);
    // 客户端持有的版本是清单声明的全书 blob sha(40 hex)。
    if (expectedVersion !== manifest.blob_sha) throw new ReaderError('书籍文件已更新,请重新加载目录。', 409);
    const chapter = manifest.chapter_index[chapterIndex];
    if (!chapter) throw new ReaderError('章节或段落不存在。', 400);
    let rangeBytes: Buffer;
    try {
      rangeBytes = await readRange(source, manifest, chapter.s, chapter.e);
    } catch (error) {
      if (error instanceof VolumeChangedError) await recoverVolumeDrift(source, manifest, error);
      throw error;
    }
    const parts = chapterParts(rangeBytes);
    // 读端重算的段数必须与清单一致(同函数同字节 ⇒ 必然一致);否则清单不可信。
    if (parts.length !== chapter.p) throw new ReaderError('章节目录格式有误,请稍后重试。', 502);
    const part = parts[partIndex];
    if (!part) throw new ReaderError('章节或段落不存在。', 400);
    return {
      taskId: task.id,
      version: manifest.blob_sha,
      chapterIndex,
      partIndex,
      partCount: parts.length,
      title: chapter.t,
      // 回填为**全书偏移**(与客户端进度百分比、目录口径一致)。
      startByte: chapter.s + part.startByte,
      endByte: chapter.s + part.endByte,
      text: rangeBytes.toString('utf8', part.startByte, part.endByte),
    };
  }
  const book = await legacyBook(source, task);
  if (expectedVersion !== book.version) throw new ReaderError('书籍文件已更新,请重新加载目录。', 409);
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

// ---- 旧单文件产物分支(行为逐字保持:走 isVolumeManifestPath === false 的既有实现)----

interface CachedBook {
  bytes: Buffer;
  version: string;
  chapters: ReaderChapter[];
  parts: ByteRange[][];
}

const books = new Map<string, CachedBook>();
const pendingBooks = new Map<string, Promise<CachedBook>>();
let cachedBytes = 0;

function cacheBook(key: string, book: CachedBook) {
  const old = books.get(key);
  if (old) cachedBytes -= old.bytes.byteLength;
  books.delete(key);
  books.set(key, book);
  cachedBytes += book.bytes.byteLength;
  while (books.size > MAX_CACHED_VOLUMES || cachedBytes > MAX_CACHED_VOLUME_BYTES) {
    const oldestKey = books.keys().next().value;
    if (oldestKey === undefined) break;
    cachedBytes -= books.get(oldestKey)!.bytes.byteLength;
    books.delete(oldestKey);
  }
}

async function legacyBook(source: Source, task: ReadableTask): Promise<CachedBook> {
  const file = await locateFile(source, task);
  if (!file) throw new ReaderError('书籍文件不存在,请返回书库检查下载任务。', 404);
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
    throw new ReaderError('正在准备其他书籍,请稍后重试。', 503);
  }
  const promise = (async () => {
    const bytes = await readBytes(source, file);
    // A blob SHA is not a Git ref. Hash the actual raw content so index and
    // chapter reads cannot silently mix revisions if the file changed mid-read.
    const version = gitBlobSha(bytes);
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
