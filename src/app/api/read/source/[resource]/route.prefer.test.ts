// 41-srcmem：首选源软提示（prefer=1）在 index 资源上的服务端行为。
// 覆盖：提示源用上了（无 hintCleared）、提示源失败（不在池内 404 / host 门 / 不可达）静默回落整池搜索并回
// hintCleared、无 prefer 的显式点选确认失败仍 404（行为不变）、无提示的整池搜索行为不变。
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requirePermission, ensureSchema, resolveSourceBook, saveSourceCatalog, sourceReaderIndex } = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  ensureSchema: vi.fn(),
  resolveSourceBook: vi.fn(),
  saveSourceCatalog: vi.fn(),
  sourceReaderIndex: vi.fn(),
}));

vi.mock('@/lib/db-quota-guard', () => ({ withDbQuotaGuard: (handler: unknown) => handler }));
vi.mock('@/lib/auth', () => ({ requirePermission }));
vi.mock('@/lib/auth-http', () => ({ withAuthHeaders: (r: unknown) => r }));
vi.mock('@/lib/db', () => ({ ensureSchema }));
vi.mock('@/lib/source-reader', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/source-reader')>()),
  resolveSourceBook, saveSourceCatalog, sourceReaderIndex,
}));

let GET: typeof import('./route').GET;
let SourceReaderError: typeof import('@/lib/source-reader').SourceReaderError;
let SourcePolicyError: typeof import('@/lib/source-policy').SourcePolicyError;

function request(query: string) {
  return GET(new NextRequest('http://localhost/api/read/source/index?' + query), {
    params: Promise.resolve({ resource: 'index' }),
  });
}

const HINT = 'title=剑来&author=烽火戏诸侯&book_url=https%3A%2F%2Fsrc%2Fbook%2F1&source=https%3A%2F%2Fsrc&prefer=1';

describe('GET /api/read/source/index — 首选源软提示 prefer', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ ok: true });
    ensureSchema.mockResolvedValue(undefined);
    saveSourceCatalog.mockResolvedValue(undefined);
    // sourceReaderIndex 回带 catalog 的标记，便于断言"最终用的是哪次搜索的结果"。
    sourceReaderIndex.mockImplementation((catalog: { marker: string }) => ({ chapters: [{ index: 0 }], marker: catalog.marker }));
    const mod = await import('@/lib/source-reader');
    SourceReaderError = mod.SourceReaderError;
    SourcePolicyError = (await import('@/lib/source-policy')).SourcePolicyError;
    GET = (await import('./route')).GET;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('提示源用上了：返回该源目录，不带 hintCleared', async () => {
    // srcmem41b：命中记忆后服务端会用 sourceBookMatches 核对目录与请求同书，故 catalog 必须带上匹配的书名/作者。
    resolveSourceBook.mockResolvedValueOnce({ marker: 'hinted', title: '剑来', author: '烽火戏诸侯' });
    const res = await request(HINT);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.marker).toBe('hinted');
    expect(body.hintCleared).toBeUndefined();
    expect(resolveSourceBook).toHaveBeenCalledTimes(1);
    // 提示走 confirm 路径：带 bookUrl + sourceUrl。
    expect(resolveSourceBook.mock.calls[0][2]).toEqual({ bookUrl: 'https://src/book/1', sourceUrl: 'https://src' });
  });

  it('记忆指向同源另一本书（书名不符）：视同首选源失败，静默回落整池搜索 + hintCleared', async () => {
    // srcmem41b（审查 §3-1 必修）：源站在 TTL 内把该 bookUrl 改指别的书 —— prefer 命中的目录书名/作者与请求不一致，
    // 此时应回落整池按书名重搜（会给对的书），而不是盲信返回别的书。
    resolveSourceBook
      .mockResolvedValueOnce({ marker: 'wrong-book', title: '大奉打更人', author: '卖报小郎君' })
      .mockResolvedValueOnce({ marker: 'fallback' });
    const res = await request(HINT);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.marker).toBe('fallback');
    expect(body.hintCleared).toBe(true);
    expect(resolveSourceBook).toHaveBeenCalledTimes(2);
    // 回落是整池按书名搜：不再带 bookUrl。
    expect(resolveSourceBook.mock.calls[1][2]).toEqual({});
  });

  it('记忆指向正确的书（书名/作者相符）：直接用，不回落', async () => {
    // 作者门也过：请求作者非空时两侧作者需同一套归一后相等。
    resolveSourceBook.mockResolvedValueOnce({ marker: 'hinted', title: '剑来', author: '烽火戏诸侯' });
    const res = await request(HINT);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.marker).toBe('hinted');
    expect(body.hintCleared).toBeUndefined();
    expect(resolveSourceBook).toHaveBeenCalledTimes(1);
  });

  it('提示源不在池内（404）：静默回落整池搜索，回 hintCleared，且回落不带 bookUrl', async () => {
    resolveSourceBook
      .mockRejectedValueOnce(new SourceReaderError('没有找到该候选对应的可用书源', 'SOURCE_NOT_FOUND', 404))
      .mockResolvedValueOnce({ marker: 'fallback' });
    const res = await request(HINT);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.marker).toBe('fallback');
    expect(body.hintCleared).toBe(true);
    expect(resolveSourceBook).toHaveBeenCalledTimes(2);
    expect(resolveSourceBook.mock.calls[1][2]).toEqual({});
  });

  it('提示 bookUrl 过不了 host 门（SourcePolicyError）：同样静默回落 + hintCleared', async () => {
    resolveSourceBook
      .mockRejectedValueOnce(new SourcePolicyError('host 未通过校验'))
      .mockResolvedValueOnce({ marker: 'fallback' });
    const res = await request(HINT);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.hintCleared).toBe(true);
    expect(resolveSourceBook).toHaveBeenCalledTimes(2);
  });

  it('提示源不可达（503）：回落 + hintCleared', async () => {
    resolveSourceBook
      .mockRejectedValueOnce(new SourceReaderError('该书源暂时无法访问', 'SOURCE_UNAVAILABLE', 503))
      .mockResolvedValueOnce({ marker: 'fallback' });
    const res = await request(HINT);
    expect(res.status).toBe(200);
    expect((await res.json()).hintCleared).toBe(true);
  });

  it('回落后的整池搜索也失败：把该失败照常返回（不再二次回落）', async () => {
    resolveSourceBook
      .mockRejectedValueOnce(new SourceReaderError('提示源没书', 'SOURCE_NOT_FOUND', 404))
      .mockRejectedValueOnce(new SourceReaderError('全都没搜到', 'SOURCE_UNAVAILABLE', 503));
    const res = await request(HINT);
    expect(res.status).toBe(503);
    expect(resolveSourceBook).toHaveBeenCalledTimes(2);
  });

  it('显式点选确认（无 prefer）失败仍 404，不回落', async () => {
    resolveSourceBook.mockRejectedValueOnce(new SourceReaderError('该候选失效', 'SOURCE_NOT_FOUND', 404));
    const res = await request('title=剑来&author=烽火戏诸侯&book_url=https%3A%2F%2Fsrc%2Fbook%2F1&source=https%3A%2F%2Fsrc');
    expect(res.status).toBe(404);
    expect(resolveSourceBook).toHaveBeenCalledTimes(1);
    expect(resolveSourceBook.mock.calls[0][2]).toEqual({ bookUrl: 'https://src/book/1', sourceUrl: 'https://src' });
  });

  it('无提示的整池搜索：不带 bookUrl，行为不变', async () => {
    resolveSourceBook.mockResolvedValueOnce({ marker: 'plain' });
    const res = await request('title=剑来&author=烽火戏诸侯');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.marker).toBe('plain');
    expect(body.hintCleared).toBeUndefined();
    expect(resolveSourceBook.mock.calls[0][2]).toEqual({});
  });

  it('prefer=1 缺 source：当普通请求处理（不进软提示分支）', async () => {
    resolveSourceBook.mockResolvedValueOnce({ marker: 'plain' });
    // 缺 source ⇒ 校验层不触发（只在 query.has(source) 时校验），hinted=false，按 title/author 搜。
    const res = await request('title=剑来&author=烽火戏诸侯&prefer=1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.hintCleared).toBeUndefined();
    expect(resolveSourceBook.mock.calls[0][2]).toEqual({});
  });
});
