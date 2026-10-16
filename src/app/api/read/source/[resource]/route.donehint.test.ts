// readerlocal42：书仓直读提示在 index 资源上的服务端行为。
// 覆盖：findDoneReadTask 命中时 index 响应附带 doneReadTaskId（整池路径与 prefer 命中路径），
// 未命中不带字段，查询抛错不影响目录交付（静默），chapter 资源不触发该查询。
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requirePermission, ensureSchema, resolveSourceBook, saveSourceCatalog, sourceReaderIndex, findDoneReadTask, readSourceChapter } = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  ensureSchema: vi.fn(),
  resolveSourceBook: vi.fn(),
  saveSourceCatalog: vi.fn(),
  sourceReaderIndex: vi.fn(),
  findDoneReadTask: vi.fn(),
  readSourceChapter: vi.fn(),
}));

vi.mock('@/lib/db-quota-guard', () => ({ withDbQuotaGuard: (handler: unknown) => handler }));
vi.mock('@/lib/auth', () => ({ requirePermission }));
vi.mock('@/lib/auth-http', () => ({ withAuthHeaders: (r: unknown) => r }));
vi.mock('@/lib/db', () => ({ ensureSchema }));
vi.mock('@/lib/library-read-task', () => ({ findDoneReadTask }));
vi.mock('@/lib/source-reader', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/source-reader')>()),
  resolveSourceBook, saveSourceCatalog, sourceReaderIndex, readSourceChapter,
}));

let GET: typeof import('./route').GET;
let SourceReaderError: typeof import('@/lib/source-reader').SourceReaderError;

function request(query: string) {
  return GET(new NextRequest('http://localhost/api/read/source/index?' + query), {
    params: Promise.resolve({ resource: 'index' }),
  });
}

describe('GET /api/read/source/index — 书仓直读提示 doneReadTaskId', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ ok: true });
    ensureSchema.mockResolvedValue(undefined);
    saveSourceCatalog.mockResolvedValue(undefined);
    sourceReaderIndex.mockImplementation((catalog: { title: string; author: string }) => ({
      taskId: null, title: catalog.title, author: catalog.author, version: 'v', totalBytes: 0, chapters: [],
    }));
    findDoneReadTask.mockResolvedValue(null);
    readSourceChapter.mockResolvedValue({ taskId: null, version: 'v', chapterIndex: 0, partIndex: 0, partCount: 1, title: '一', startByte: 0, endByte: 3, text: '一' });
    SourceReaderError = (await import('@/lib/source-reader')).SourceReaderError;
    GET = (await import('./route')).GET;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('书仓有同书 done 全文：响应附带 doneReadTaskId，查询用目录解析出的书名/作者', async () => {
    findDoneReadTask.mockResolvedValueOnce(321);
    resolveSourceBook.mockResolvedValueOnce({ title: '剑来', author: '烽火戏诸侯' });
    const res = await request('title=剑来&author=烽火戏诸侯');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.doneReadTaskId).toBe(321);
    expect(findDoneReadTask).toHaveBeenCalledWith(true, '剑来', '烽火戏诸侯');
  });

  it('书仓没有同书 done：响应不带 doneReadTaskId 字段', async () => {
    resolveSourceBook.mockResolvedValueOnce({ title: '剑来', author: '烽火戏诸侯' });
    const res = await request('title=剑来&author=烽火戏诸侯');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.doneReadTaskId).toBeUndefined();
  });

  it('查询抛错：目录照常交付（提示是加分项，绝不拖垮正文路径）', async () => {
    findDoneReadTask.mockRejectedValueOnce(new Error('db down'));
    resolveSourceBook.mockResolvedValueOnce({ title: '剑来', author: '烽火戏诸侯' });
    const res = await request('title=剑来&author=烽火戏诸侯');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.title).toBe('剑来');
    expect(body.doneReadTaskId).toBeUndefined();
  });

  it('prefer 命中路径同样附带 doneReadTaskId', async () => {
    findDoneReadTask.mockResolvedValueOnce(77);
    resolveSourceBook.mockResolvedValueOnce({ title: '剑来', author: '烽火戏诸侯' });
    const res = await request('title=剑来&author=烽火戏诸侯&book_url=https%3A%2F%2Fsrc%2Fbook%2F1&source=https%3A%2F%2Fsrc&prefer=1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.doneReadTaskId).toBe(77);
    expect(body.hintCleared).toBeUndefined();
  });

  it('prefer 回落路径：doneReadTaskId 与 hintCleared 同时带', async () => {
    findDoneReadTask.mockResolvedValueOnce(99);
    resolveSourceBook
      .mockRejectedValueOnce(new SourceReaderError('没有找到该候选对应的可用书源', 'SOURCE_NOT_FOUND', 404))
      .mockResolvedValueOnce({ title: '剑来', author: '烽火戏诸侯' });
    const res = await request('title=剑来&author=烽火戏诸侯&book_url=https%3A%2F%2Fsrc%2Fbook%2F1&source=https%3A%2F%2Fsrc&prefer=1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.doneReadTaskId).toBe(99);
    expect(body.hintCleared).toBe(true);
  });

  it('chapter 资源不触发 done 任务查询', async () => {
    const session = 'a'.repeat(40);
    const res = await GET(new NextRequest(`http://localhost/api/read/source/chapter?session=${session}&version=${session}&chapter=0&part=0`), {
      params: Promise.resolve({ resource: 'chapter' }),
    });
    expect(res.status).toBe(200);
    expect(findDoneReadTask).not.toHaveBeenCalled();
  });
});
