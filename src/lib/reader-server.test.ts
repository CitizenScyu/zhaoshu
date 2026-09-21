import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookFilename } from './book-file-name';
import { VOLUME_MANIFEST_FORMAT, VOLUME_MANIFEST_SCHEMA } from './volume-manifest';
import type { ReaderIndex } from './reader-types';
import type { ReadableTask } from './reader-server';

const { getSql, sql, fetchMock } = vi.hoisted(() => ({
  getSql: vi.fn(), sql: vi.fn(), fetchMock: vi.fn<typeof fetch>(),
}));
vi.mock('@/lib/db', () => ({ getSql }));

let server: typeof import('./reader-server');
const MAX_BYTES = 16 * 1024 * 1024;

function fixture(id = 1, text = '第一章 开始\n用于验证阅读切片的模拟正文。\n') {
  const task: ReadableTask = { id, title: '测试书' + id, author: '测试作者', status: 'done' };
  const bytes = Buffer.from(text);
  const sha = createHash('sha1').update('blob ' + bytes.byteLength + '\0').update(bytes).digest('hex');
  return { task, bytes, text, file: { type: 'file', name: bookFilename(task.title, task.author), sha, size: bytes.byteLength } };
}

function mockBook(book: ReturnType<typeof fixture>, response = new Response(book.text)) {
  fetchMock.mockResolvedValueOnce(Response.json([book.file])).mockResolvedValueOnce(response);
}

// ---- v2 分卷产物夹具 --------------------------------------------------------
//
// 发布形状从「整本 <version>.txt」变成「清单 <version>.json + 同目录 vol-NNN.txt」,
// DB 的 canonical_path 指向清单。阅读端读路径由 `artifact.canonical_path` 是否以
// `/index.json` 结尾决定,所以夹具用与发布器同口径的路径字符串。

const ARTIFACT_ID = 7;
const OWNER = 'fixture';
const REPO = 'private';
const BRANCH = 'main';

/** 章节/卷清单 + 各卷字节(卷边界必须落在章起点,否则读端校验会拒)。 */
interface VolumeFixture {
  paths: { canonicalPath: string };
  task: ReadableTask;
  bookText: string;
  chapters: { title: string; text: string }[];
  ranges: { startByte: number; endByte: number }[];
  volumes: { path: string; blobSha: string; bytes: number }[];
  manifest: Record<string, unknown>;
}

function volumeFixture(options: {
  id?: number; title?: string; author?: string; maxVolumeBytes: number; chapters: { title: string; text: string }[];
}): VolumeFixture {
  const title = options.title ?? '测试书';
  const author = options.author ?? '测试作者';
  const text = options.chapters.map(chapter => `${chapter.title}\n${chapter.text}\n`).join('');
  const bytes = Buffer.from(text);
  const blobSha = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
  const version = blobSha.slice(0, 8);
  const stem = encodeURIComponent(bookFilename(title, author).replace(/\.txt$/, ''));
  const paths = { canonicalPath: `books/${stem}/index.json` };

  const chapterBytes = options.chapters.map(chapter => Buffer.byteLength(`${chapter.title}\n${chapter.text}\n`, 'utf8'));
  const chapterStarts: number[] = [];
  const chapterEnds: number[] = [];
  let offset = 0;
  for (const size of chapterBytes) { chapterStarts.push(offset); offset += size; chapterEnds.push(offset); }

  // 按章贪心装箱(与发布器 splitBookVolumes 同口径:整章装得下就推进章边界)。
  const ranges: { startByte: number; endByte: number }[] = [];
  let volumeStart = 0;
  let filled = 0;
  for (let index = 0; index < chapterEnds.length; index++) {
    if (chapterEnds[index]! - volumeStart <= options.maxVolumeBytes) { filled = chapterEnds[index]!; continue; }
    if (filled > volumeStart) { ranges.push({ startByte: volumeStart, endByte: filled }); volumeStart = filled; }
    ranges.push({ startByte: volumeStart, endByte: chapterEnds[index]! }); // 单章 > 软目标:独占一卷
    volumeStart = chapterEnds[index]!;
    filled = chapterEnds[index]!;
  }
  if (filled > volumeStart) ranges.push({ startByte: volumeStart, endByte: filled });
  if (!ranges.length) ranges.push({ startByte: 0, endByte: 0 });

  const volumes = ranges.map((range, index) => {
    const volumeBytes = bytes.subarray(range.startByte, range.endByte);
    const sha = createHash('sha1').update(`blob ${volumeBytes.byteLength}\0`).update(volumeBytes).digest('hex');
    return {
      path: paths.canonicalPath.replace(/index\.json$/, `vol-${String(index + 1).padStart(3, '0')}.txt`),
      blobSha: sha,
      bytes: volumeBytes.byteLength,
    };
  });

  const chapterIndex = options.chapters.map((chapter, index) => {
    const start = chapterStarts[index]!;
    const end = chapterEnds[index]!;
    const volumeIndex = ranges.findIndex(range => start >= range.startByte && start < range.endByte);
    return {
      i: index, t: chapter.title, v: Math.max(volumeIndex, 0), s: start, e: end,
      p: Math.max(1, Math.ceil((end - start) / (32 * 1024))),
    };
  });

  return {
    paths,
    task: { id: options.id ?? 1, title, author, status: 'done', artifact_id: ARTIFACT_ID },
    bookText: text,
    chapters: options.chapters,
    ranges,
    volumes,
    manifest: {
      schema: VOLUME_MANIFEST_SCHEMA, format: VOLUME_MANIFEST_FORMAT, version, blob_sha: blobSha,
      bytes: bytes.byteLength, chars: text.length,
      chapters: options.chapters.length, chapters_total: options.chapters.length,
      title, author, generated_at: '2026-09-21T00:00:00.000Z', task_id: options.id ?? 1,
      volumes: ranges.map((range, index) => ({
        path: volumes[index]!.path,
        snapshot_path: `books/.snapshots/${stem}/v-${version}.txt`,
        blob_sha: volumes[index]!.blobSha, bytes: volumes[index]!.bytes,
        first_byte: range.startByte, last_byte: range.endByte,
      })),
      chapter_index: chapterIndex,
    },
  };
}

/** locateTaskArtifact 的 SQL 返回一条 v2 artifact 行(canonical_path 指向清单)。 */
function useVolumeArtifact(book: VolumeFixture) {
  sql.mockResolvedValue([{
    owner: OWNER, repo: REPO, branch: BRANCH,
    canonical_path: book.paths.canonicalPath,
    blob_sha: book.manifest.blob_sha as string,
    bytes: book.manifest.bytes as number,
  }]);
}

/** raw 取数分发:清单/卷按 URL 末段名解析,卷字节按清单区间切片。 */
function volumeResponder(book: VolumeFixture): (input: RequestInfo | URL) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    if (name === 'index.json') return new Response(JSON.stringify(book.manifest));
    const index = book.volumes.findIndex(volume => volume.path.endsWith(name));
    if (index < 0) throw new Error('Unexpected manifest/volume request: ' + name);
    const range = book.ranges[index]!;
    return new Response(Buffer.from(book.bookText, 'utf8').subarray(range.startByte, range.endByte));
  };
}

/** 把分卷夹具接到 SQL 与 fetch 上(artifact 定位走 sql,清单/卷走 raw fetch)。 */
function mockVolumeArtifact(book: VolumeFixture) {
  useVolumeArtifact(book);
  fetchMock.mockImplementation(volumeResponder(book) as never);
}

type ChapterIndexEntry = { i: number; t: string; v: number; s: number; e: number; p: number };

const OVERSIZED_CHAPTERS = 8500;
const ESCAPED_TITLE = String.fromCharCode(1).repeat(70) + '尾';
const PLAIN_TITLE = 'x'.repeat(70) + '尾';

function manifestJson(book: VolumeFixture): string {
  return JSON.stringify(book.manifest);
}

function manifestBytes(book: VolumeFixture): number {
  return Buffer.byteLength(manifestJson(book), 'utf8');
}

function indexJsonBytes(book: VolumeFixture): number {
  const entries = book.manifest.chapter_index as ChapterIndexEntry[];
  const index: ReaderIndex = {
    taskId: book.task.id, title: book.task.title, author: book.task.author,
    version: book.manifest.blob_sha as string, totalBytes: book.manifest.bytes as number,
    chapters: entries.map(entry => ({
      index: entry.i, title: entry.t, startByte: entry.s, endByte: entry.e, partCount: entry.p,
    })),
  };
  return Buffer.byteLength(JSON.stringify(index), 'utf8');
}

/**
 * 转义标题病态书:每章标题带 70 个控制字符,JSON 转义后把读端索引顶穿 4 MiB,
 * 而清单 raw 本身仍在 4 MiB 门内(见 §索引门 vs 清单门)。
 */
function escapedTitleBook(id = 3, chapters = OVERSIZED_CHAPTERS): VolumeFixture {
  const book = volumeFixture({
    id, title: '转义超限书', maxVolumeBytes: 64 * 1024 * 1024,
    chapters: Array.from({ length: chapters }, () => ({ title: ESCAPED_TITLE, text: '正文' })),
  });
  // 夹具里的 manifest 是手工构造的对象;整份 JSON 必须真的仍在 4 MiB 门内。
  expect(manifestBytes(book)).toBeLessThan(4 * 1024 * 1024);
  return book;
}

/** 对照组:同一批章节、标题只把控制字符换成等字节的 'x',索引不膨胀 ⇒ 必须仍可读。 */
function plainTitleBook(id = 4, chapters = OVERSIZED_CHAPTERS): VolumeFixture {
  const book = volumeFixture({
    id, title: '纯文本达标书', maxVolumeBytes: 64 * 1024 * 1024,
    chapters: Array.from({ length: chapters }, () => ({ title: PLAIN_TITLE, text: '正文' })),
  });
  expect(manifestBytes(book)).toBeLessThan(4 * 1024 * 1024);
  return book;
}

function streamBytes(bytes: Uint8Array, chunkSize: number, cancel = vi.fn()) {
  let position = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === bytes.byteLength) { controller.close(); return; }
      const end = Math.min(bytes.byteLength, position + chunkSize);
      controller.enqueue(bytes.subarray(position, end));
      position = end;
    },
    cancel,
  }, { highWaterMark: 0 });
}

describe('reader server file resolution and bounded cache', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('GITHUB_TOKEN', 'reader-server-test-github');
    vi.stubEnv('ZHAOSHU_BOOKS_REPO', 'test-owner/test-books');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() => { throw new Error('Unexpected network request'); });
    getSql.mockReturnValue(sql);
    server = await import('./reader-server');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('resolves an anonymous task to its canonical worker file among other authors', async () => {
    const book = fixture();
    book.task.author = '';
    book.file.name = bookFilename(book.task.title, '');
    fetchMock.mockResolvedValueOnce(Response.json([book.file, { ...book.file, name: book.task.title + '-另一作者.txt' }]));
    await expect(server.readerAvailability(book.task)).resolves.toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([0, MAX_BYTES + 1])('reports a %s-byte file unavailable without fetching raw text', async (size) => {
    const book = fixture();
    fetchMock.mockResolvedValueOnce(Response.json([{ ...book.file, size }]));
    await expect(server.readerAvailability(book.task)).resolves.toEqual({ available: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finds an exact worker filename beyond the 1,000-entry directory limit', async () => {
    const book = fixture();
    const listing = Array.from({ length: 1000 }, (_, index) => ({ ...book.file, name: '其他书' + index + '.txt' }));
    fetchMock.mockResolvedValueOnce(Response.json(listing)).mockResolvedValueOnce(Response.json(book.file));
    await expect(server.readerAvailability(book.task)).resolves.toEqual({ available: true });
    await expect(server.readerAvailability(book.task)).resolves.toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining(encodeURIComponent(book.file.name)),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github.object+json' }) }));
  });

  it.each([false, true])('only trusts a unique title fallback when the listing is complete (truncated: %s)', async (truncated) => {
    const book = fixture();
    const listing = [{ ...book.file, name: book.task.title + '-旧作者.txt' }];
    if (truncated) {
      listing.push(...Array.from({ length: 999 }, (_, index) => ({ ...book.file, name: '其他书' + index + '.txt' })));
    }
    fetchMock.mockResolvedValueOnce(Response.json(listing)).mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(server.readerAvailability(book.task)).resolves.toEqual({ available: !truncated });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['directory', 'file metadata'])('maps malformed %s JSON to an upstream error', async (stage) => {
    const book = fixture();
    if (stage === 'file metadata') fetchMock.mockResolvedValueOnce(Response.json([]));
    fetchMock.mockResolvedValueOnce(new Response('{broken json'));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 502 });
  });

  it('maps a timed-out exact metadata response body to 504', async () => {
    const book = fixture();
    const response = Response.json(book.file);
    vi.spyOn(response, 'json').mockRejectedValueOnce(new DOMException('test abort', 'AbortError'));
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(response);
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 504 });
  });

  it.each([
    { type: 'dir' }, { sha: 'invalid' }, { size: -1 }, { size: 0.5 }, { name: 'book.json' },
  ])('rejects invalid direct file metadata %j', async (invalid) => {
    const book = fixture();
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json({ ...book.file, ...invalid }));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes a five-minute directory snapshot while reusing unchanged raw bytes', async () => {
    const book = fixture();
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockBook(book);
    await server.readBookIndex(book.task);
    now += 5 * 60_000 - 1;
    await server.readBookIndex(book.task);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 2;
    fetchMock.mockResolvedValueOnce(Response.json([book.file]));
    await server.readBookIndex(book.task);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/\/contents\/books$/), expect.anything());
  });

  it('uses the actual raw blob version if a file changes after the metadata request', async () => {
    const oldBook = fixture(1, '第一章 旧版\n模拟旧版正文。\n');
    const updated = fixture(1, '第一章 新版\n模拟新版正文。\n');
    mockBook(oldBook, new Response(updated.text));
    const index = await server.readBookIndex(oldBook.task);
    expect(index.version).toBe(updated.file.sha);
    fetchMock.mockResolvedValueOnce(Response.json([updated.file]));
    await expect(server.readBookPart(oldBook.task, 0, 0, oldBook.file.sha)).rejects.toMatchObject({ status: 409 });
    await expect(server.readBookPart(oldBook.task, 0, 0, index.version)).resolves.toMatchObject({ text: updated.text });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('evicts the least recently used volume when the volume cache is over capacity', async () => {
    // v2 语义:发布形状是「清单 + 卷」,缓存单元从「整本书」变成「卷」(内容寻址,
    // 键 = 卷路径@blob_sha,MAX_CACHED_VOLUMES = 8)。「第四本书进缓存时淘汰第一本」
    // 的整本口径已不存在;这里保住同一冷热判据的唯一对应物:
    // 每章独占一卷(单章 > 软目标),读满 9 卷后最冷的第 1 卷被淘汰 ⇒ 复读要重取;
    // 而仍在缓存里的末卷复读零请求。
    const chapters = Array.from({ length: 9 }, (_, index) => ({
      title: `第${index + 1}章 冷热`, text: `CH${index}`.repeat(40),
    }));
    const book = volumeFixture({ id: 1, title: '冷热书', maxVolumeBytes: 64, chapters });
    expect(book.volumes).toHaveLength(9); // 单章 > 软目标 ⇒ 每章一卷
    mockVolumeArtifact(book);

    await server.readBookIndex(book.task);
    const version = book.manifest.blob_sha as string;
    for (let index = 0; index < 9; index++) await server.readBookPart(book.task, index, 0, version);

    // 末卷仍在缓存:复读零新请求。
    const beforeHot = fetchMock.mock.calls.length;
    const hot = await server.readBookPart(book.task, 8, 0, version);
    expect(hot.text).toBe(`${chapters[8]!.title}\n${chapters[8]!.text}\n`);
    expect(fetchMock.mock.calls.length).toBe(beforeHot);

    // 第 1 卷已被 8 卷上限淘汰:复读必须重新拉取,且内容逐字节相同。
    const cold = await server.readBookPart(book.task, 0, 0, version);
    expect(fetchMock.mock.calls.length).toBe(beforeHot + 1);
    expect(cold.text).toBe(`${chapters[0]!.title}\n${chapters[0]!.text}\n`);
  });

  it('coalesces simultaneous manifest requests for the same book into one fetch', async () => {
    // v2 语义:并发同一本书的目录请求只在「清单」这一跳去重(manifestPending);
    // 同一清单的两次 readBookIndex 必须共享同一个在途 raw 拉取,绝不重复拉清单。
    const book = volumeFixture({ id: 1, maxVolumeBytes: 1024 * 1024, chapters: [{ title: '第一章 合流', text: '并发合流正文。' }] });
    let releaseManifest!: (response: Response) => void;
    useVolumeArtifact(book);
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { releaseManifest = resolve; }));
    const first = server.readBookIndex(book.task);
    const second = server.readBookIndex(book.task);
    await vi.waitFor(() => expect(releaseManifest).toBeTypeOf('function'));
    // 两次并发调用只发出清单这一跳 raw 拉取,且仍在途。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseManifest(new Response(JSON.stringify(book.manifest)));
    const [firstIndex, secondIndex] = await Promise.all([first, second]);
    expect(firstIndex).toEqual(secondIndex);
    // 清单只被拉取一次(绝无第二次)。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('index.json'), expect.anything());
  });

  it('limits different in-flight books to two and frees capacity after they complete', async () => {
    const library = [fixture(1), fixture(2), fixture(3)];
    const releases: Array<() => void> = [];
    fetchMock.mockResolvedValueOnce(Response.json(library.map((book) => book.file)))
      .mockImplementationOnce(() => new Promise((resolve) => { releases.push(() => resolve(new Response(library[0].text))); }))
      .mockImplementationOnce(() => new Promise((resolve) => { releases.push(() => resolve(new Response(library[1].text))); }));
    const first = server.readBookIndex(library[0].task);
    const second = server.readBookIndex(library[1].task);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await expect(server.readBookIndex(library[2].task)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    fetchMock.mockResolvedValueOnce(new Response(library[2].text));
    await expect(server.readBookIndex(library[2].task)).resolves.toMatchObject({ taskId: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps parser limits consistently for every coalesced caller', async () => {
    // v2 语义:目录门限不再来自 parseTxtChapters 的章数上限,而是清单派生索引的字节门。
    // 两次并发读同一本书必须**共享同一次清单拉取**,并拿到同一个 422(不得一个成功一个失败)。
    const book = escapedTitleBook();
    useVolumeArtifact(book);
    fetchMock.mockImplementation(volumeResponder(book) as never);
    const results = await Promise.allSettled([server.readBookIndex(book.task), server.readBookIndex(book.task)]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 422 });
    }
    const reasons = results.map(result => (result.status === 'rejected' ? (result.reason as Error).message : null));
    expect(reasons[0]).toBe(reasons[1]);
    // 清单只被拉取一次(合流)。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the actual JSON index bytes including control-character escaping, not just the chapter count', async () => {
    // v2 语义:目录来自清单的 `chapter_index`。控制字符在标题里被 JSON 转义成
    // \uXXXX 后使索引膨胀 —— 同一批章节、等字节的纯文本标题必须仍可读,而转义标题版本必须 422。
    // 两侧都钉住,防止把门限退化成只看章数。
    const escaped = escapedTitleBook();
    const plain = plainTitleBook();
    // 清单 raw 与读端索引 JSON 是两个不同的门:构造出「清单未顶 4 MiB、索引顶穿」的窗口,
    // 这样 422 只可能来自索引字节门(否则会先在清单 raw 拉取处 413)。
    expect(manifestBytes(escaped)).toBeLessThan(4 * 1024 * 1024);
    expect(indexJsonBytes(escaped)).toBeGreaterThan(4 * 1024 * 1024);
    expect(indexJsonBytes(plain)).toBeLessThan(4 * 1024 * 1024);

    useVolumeArtifact(escaped);
    fetchMock.mockImplementation(volumeResponder(escaped) as never);
    const failure = await server.readBookIndex(escaped.task).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({
      status: 422, message: '章节目录过大,暂时无法在线阅读这本书。',
    });

    useVolumeArtifact(plain);
    fetchMock.mockImplementation(volumeResponder(plain) as never);
    const plainIndex = await server.readBookIndex(plain.task);
    expect(plainIndex.chapters).toHaveLength(OVERSIZED_CHAPTERS);
    expect(Buffer.byteLength(JSON.stringify(plainIndex), 'utf8')).toBeLessThan(4 * 1024 * 1024);
  });

  it('does not cache failed reads and allows a later request to retry', async () => {
    const book = fixture();
    mockBook(book, new Response(new Uint8Array([0xff])));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 422 });
    fetchMock.mockResolvedValueOnce(new Response(book.text));
    await expect(server.readBookIndex(book.task)).resolves.toMatchObject({ version: book.file.sha });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('isolates cached metadata and text after repository or GitHub credentials change', async () => {
    const book = fixture();
    mockBook(book);
    await server.readBookIndex(book.task);
    vi.stubEnv('GITHUB_TOKEN', 'rotated-reader-test-token');
    mockBook(book);
    await server.readBookIndex(book.task);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer rotated-reader-test-token' }),
    }));
    vi.stubEnv('ZHAOSHU_BOOKS_REPO', 'test-owner/other-test-books');
    mockBook(book);
    await server.readBookIndex(book.task);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/other-test-books/contents/books/'), expect.anything());
  });

  it('cancels a declared oversized raw body before buffering it', async () => {
    const book = fixture();
    const cancel = vi.fn();
    mockBook(book, new Response(streamBytes(book.bytes, 10, cancel), { headers: { 'Content-Length': String(MAX_BYTES + 1) } }));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('enforces the streaming byte limit when metadata and content length underreport the size', async () => {
    const book = fixture();
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { produced++; controller.enqueue(chunk); }, cancel,
    }, { highWaterMark: 0 });
    mockBook(book, new Response(stream, { headers: { 'Content-Length': '1' } }));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 413 });
    expect(produced).toBe(17);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('serves a 16 MiB unmarked book only as bounded UTF-8-safe parts', async () => {
    const book = fixture(1, '文'.repeat(Math.floor(MAX_BYTES / 3)) + 'a'.repeat(MAX_BYTES % 3));
    mockBook(book, new Response(streamBytes(book.bytes, 64 * 1024)));
    const index = await server.readBookIndex(book.task);
    expect(index.totalBytes).toBe(MAX_BYTES);
    expect(index.chapters).toHaveLength(1);
    expect(index.chapters[0].partCount).toBeGreaterThan(1);
    const restored = createHash('sha1').update('blob ' + MAX_BYTES + '\0');
    let position = 0;
    for (let partIndex = 0; partIndex < index.chapters[0].partCount; partIndex++) {
      const part = await server.readBookPart(book.task, 0, partIndex, index.version);
      expect(part.startByte).toBe(position);
      expect(part.endByte - part.startByte).toBeLessThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(part.text)).toBe(part.endByte - part.startByte);
      expect(part.text).not.toContain('\ufffd');
      restored.update(part.text);
      position = part.endByte;
    }
    expect(position).toBe(MAX_BYTES);
    expect(restored.digest('hex')).toBe(book.file.sha);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts Chinese and emoji split across network chunks', async () => {
    const book = fixture(1, '第一章 起点\n中文、🚀和𠮷跨越网络分块。\n');
    mockBook(book, new Response(streamBytes(book.bytes, 2)));
    const index = await server.readBookIndex(book.task);
    await expect(server.readBookPart(book.task, 0, 0, index.version)).resolves.toMatchObject({ text: book.text });
  });

  it('rejects incomplete UTF-8 at the end of a stream', async () => {
    const book = fixture();
    mockBook(book, new Response(streamBytes(new Uint8Array([0x61, 0xe4, 0xb8]), 1)));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 422 });
  });

  it.each(['fetch', 'body'])('uses a 60-second raw timeout and maps a %s abort to 504', async (stage) => {
    const book = fixture();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(Response.json([book.file]));
    const error = new DOMException('test transfer timeout', 'AbortError');
    if (stage === 'fetch') fetchMock.mockRejectedValueOnce(error);
    else fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(error); } })));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 504 });
    expect(timeout.mock.calls.map(([duration]) => duration)).toEqual([15_000, 60_000]);
  });

  it('invalidates the directory cache when a previously listed raw file has disappeared', async () => {
    const book = fixture();
    mockBook(book, new Response(null, { status: 404 }));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 404 });
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(server.readerAvailability(book.task)).resolves.toEqual({ available: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps a broken raw stream to 502 without retaining it in the cache', async () => {
    const book = fixture();
    mockBook(book, new Response(new ReadableStream({ start(controller) { controller.error(new Error('test broken connection')); } })));
    await expect(server.readBookIndex(book.task)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(new Response(book.text));
    await expect(server.readBookIndex(book.task)).resolves.toMatchObject({ version: book.file.sha });
  });
});
