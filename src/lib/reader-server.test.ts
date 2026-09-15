import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookFilename } from './book-file-name';
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

  it('evicts the least recently used book when a fourth book is loaded', async () => {
    const library = [fixture(1), fixture(2), fixture(3), fixture(4)];
    const rawReads = new Map<string, number>();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/books')) return Response.json(library.map((book) => book.file));
      const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const book = library.find((item) => item.file.name === name);
      if (!book) throw new Error('Unexpected book');
      rawReads.set(name, (rawReads.get(name) ?? 0) + 1);
      return new Response(book.text);
    });
    for (const book of library.slice(0, 3)) await server.readBookIndex(book.task);
    await server.readBookIndex(library[0].task);
    await server.readBookIndex(library[3].task);
    await server.readBookIndex(library[2].task);
    await server.readBookIndex(library[1].task);
    expect(rawReads.get(library[0].file.name)).toBe(1);
    expect(rawReads.get(library[1].file.name)).toBe(2);
    expect(rawReads.get(library[2].file.name)).toBe(1);
    expect(rawReads.get(library[3].file.name)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('coalesces simultaneous directory and raw requests for the same book', async () => {
    const book = fixture();
    let releaseDirectory!: (response: Response) => void;
    let releaseRaw!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { releaseDirectory = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRaw = resolve; }));
    const first = server.readBookIndex(book.task);
    const second = server.readBookIndex(book.task);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseDirectory(Response.json([book.file]));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releaseRaw(new Response(book.text));
    const [firstIndex, secondIndex] = await Promise.all([first, second]);
    expect(firstIndex).toEqual(secondIndex);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const text = Array.from({ length: 10_001 }, (_, index) => '第' + (index + 1) + '章 标题\n').join('');
    const book = fixture(1, text);
    mockBook(book);
    const results = await Promise.allSettled([server.readBookIndex(book.task), server.readBookIndex(book.task)]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ name: 'ReaderError', status: 422 });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds the actual JSON index bytes including control-character escaping, not just the chapter count', async () => {
    const escapedText = Array.from({ length: 10_000 }, (_, index) =>
      '第' + (index + 1) + '章 ' + '\u0001'.repeat(70) + '尾\n').join('');
    const escapedBook = fixture(1, escapedText);
    const plainBook = fixture(2, escapedText.replaceAll('\u0001', 'x'));
    expect(escapedBook.bytes.byteLength).toBeLessThan(1024 * 1024);
    expect(escapedBook.bytes.byteLength).toBe(plainBook.bytes.byteLength);
    fetchMock.mockResolvedValueOnce(Response.json([escapedBook.file, plainBook.file]))
      .mockResolvedValueOnce(new Response(escapedBook.text))
      .mockResolvedValueOnce(new Response(plainBook.text));
    const failure = await server.readBookIndex(escapedBook.task).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({
      status: 422, message: '章节目录过大，暂时无法在线阅读这本书。',
    });
    const plainIndex = await server.readBookIndex(plainBook.task);
    expect(plainIndex.chapters).toHaveLength(10_000);
    expect(Buffer.byteLength(JSON.stringify(plainIndex))).toBeLessThan(4 * 1024 * 1024);
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
