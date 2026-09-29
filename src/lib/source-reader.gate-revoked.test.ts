// cc-source-session-cache53（A线）：已加载目录的源被撤出运行时 host 门（准入撤销 ⇒ 门整集重置收窄）后，
// 章节续读不得被 loadSourceCatalog 的 validateSourceUrl(catalog.bookUrl) 挡死 ——
// 那条校验失败时应视同「当前源身份失效」进换源，而不是每章 422 直到目录会话 24h 过期。
// 夹具同 source-reader.test.ts：只 mock db / shuyuan / fetch，loadSourceCatalog / readCatalogPayload /
// readSourceChapter / switchSourceChapter 全走真实实现；时钟用 Date.now spy（合成节流推进）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceCatalog } from './source-reader';

type Query = { text: string; values: unknown[] };
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn(), sources: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('./db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));
vi.mock('./shuyuan', () => ({
  getReadingSources: mocks.sources,
  getSourcePools: async (signal: AbortSignal) => {
    const list = await mocks.sources(signal);
    return { traversal: list, selectable: list };
  },
}));

let service: typeof import('./source-reader');
const book = { title: '测试书', author: '作者' };
// 「可撤 host」的当前源：非内建 host，准入撤销后会被 refreshSupportedHosts 整集重置移出门。
const xSource = { url: 'https://x.test/', name: '被撤源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const backup = { url: 'https://backup.test/', name: '备用书源', searchUrl: '/books/search.html?kw={{key}}', rules: {} };
const searchOf = (base: string) => `${base}/books/search.html?kw=${encodeURIComponent(book.title)}`;
const detailOf = (base: string, id: number) =>
  `<meta property="og:novel:book_name" content="${book.title}"><meta property="og:novel:author" content="${book.author}">`
  + ['第一章', '第二章'].map((title, i) => `<dd><a href="/chapter/index${id}-${i + 1}.html">${title}</a></dd>`).join('');
const chapterOf = (base: string, id: number, chapter: number, text: string) =>
  [`${base}/chapter/index${id}-${chapter}.html`, { text: `<li class="chapter-content"><p>${text}</p></li>` }] as const;
const pages = new Map<string, { text?: string; status?: number }>();
const catalogs = new Map<string, SourceCatalog>();
const context = () => new service.SourceRequestContext(new AbortController().signal);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.sources.mockResolvedValue([xSource, backup]);
  catalogs.clear();
  pages.clear();
  for (const [base, id] of [[xSource.url.replace(/\/$/, ''), 42], [backup.url.replace(/\/$/, ''), 777]] as const) {
    pages.set(searchOf(base), { text: `<a href="/books/details${id}.html">${book.title}</a>` });
    pages.set(`${base}/books/details${id}.html`, { text: detailOf(base, id) });
    pages.set(...chapterOf(base, id, 1, `${base} 第一章正文`));
    pages.set(...chapterOf(base, id, 2, `${base} 第二章正文`));
  }
  // 暖正文缓存是模块级 Map：vi.resetModules 已重载模块，再显式清一次（clearSourceCatalogCache 同属新模块实例）。
  const fresh = await import('./source-reader');
  fresh.clearSourceCatalogCache();
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?').replace(/\s+/g, ' ').trim(), values });
  const transaction = vi.fn(async (queries: Query[]) => queries.map((query) => {
    if (query.text.includes('FROM labeled_books')) return [];
    if (query.text.startsWith('INSERT INTO source_read_catalogs')) {
      catalogs.set(query.values[0] as string, JSON.parse(query.values[1] as string));
      return [];
    }
    if (query.text.startsWith('DELETE')) return [];
    if (query.text.includes('FROM source_read_catalogs')) {
      const payload = catalogs.get(query.values[0] as string);
      return payload ? [{ payload }] : [];
    }
    throw new Error('Unexpected SQL ' + query.text);
  }));
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction }));
  mocks.fetch.mockImplementation(async (input) => {
    const fixture = pages.get(String(input));
    if (!fixture) throw new Error('Unexpected source request ' + input);
    return new Response(fixture.text, { status: fixture.status ?? 200 });
  });
  vi.stubGlobal('fetch', mocks.fetch);
  // 合成时钟：每次 Date.now() 前进 400ms，节流槽（同站 350ms 间隔）无需真实等待。
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time += 400);
  service = fresh;
  // 初始门：builtin 底 + 两个测试源都在门内（模拟两源均准入 ok）。
  (await import('./source-policy')).refreshSupportedHosts(['x.test', 'backup.test']);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('源被撤出 host 门后的章节续读（准入撤销 ⇒ 门收窄）', () => {
  it('暖缓存过期的新章换源到可用源交付，而不是 422 卡死到会话过期', async () => {
    // 建会话：当前源 = x.test（在门内、在池内），第一章正常交付。
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    expect(catalog.sourceUrl).toBe(xSource.url);
    expect((await service.readSourceChapter(catalog.version, 0, context())).servedFromUrl).toBe(xSource.url);

    // 撤准入：admission 不再 ok ⇒ engineHosts 不含 x.test ⇒ 门整集重置收窄；源同时出池。
    // 池里仍有可用源 backup（有这本书）——「有可恢复源」成立。
    (await import('./source-policy')).refreshSupportedHosts(['backup.test']);
    mocks.sources.mockResolvedValue([backup]);

    // 第二章（避开暖缓存）。修复前：loadSourceCatalog 的 validateSourceUrl(catalog.bookUrl)
    // 对出门 host 抛 SourcePolicyError ⇒ 每章 422 SOURCE_REJECTED，换源流程永远到不了。
    const part = await service.readSourceChapter(catalog.version, 1, context());
    expect(part).toMatchObject({ text: `${backup.url.replace(/\/$/, '')} 第二章正文`, servedFromUrl: backup.url });
    // 换源固化：带出新目录会话，后续章节直接用新源续读，不再碰出门 host。
    expect(part.sourceSession).toBeTruthy();
    expect(part.sourceSession).not.toBe(catalog.version);
    expect(catalogs.has(part.sourceSession!)).toBe(true);
  });

  it('出门 host 的任何章节 URL 都不再被请求（换源后不再回打被撤源）', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    (await service.readSourceChapter(catalog.version, 0, context()));
    (await import('./source-policy')).refreshSupportedHosts(['backup.test']);
    mocks.sources.mockResolvedValue([backup]);
    mocks.fetch.mockClear();
    await service.readSourceChapter(catalog.version, 1, context());
    const requested = mocks.fetch.mock.calls.map(([input]) => String(input));
    expect(requested.some((url) => url.startsWith('https://x.test/'))).toBe(false);
    expect(requested.some((url) => url.startsWith('https://backup.test/'))).toBe(true);
  });

  it('无备用源时仍按既有 503 语义收尾（不因校验失败改抛 422）', async () => {
    const catalog = await service.resolveSourceBook(book, context());
    catalogs.set(catalog.version, catalog);
    (await service.readSourceChapter(catalog.version, 0, context()));
    (await import('./source-policy')).refreshSupportedHosts(['backup.test']);
    // 池也空了（全网无可用源）：既有语义 = 503 SOURCE_CHAPTER_UNAVAILABLE，不是 422 SOURCE_REJECTED。
    mocks.sources.mockResolvedValue([]);
    await expect(service.readSourceChapter(catalog.version, 1, context()))
      .rejects.toMatchObject({ code: 'SOURCE_CHAPTER_UNAVAILABLE', status: 503 });
  });
});
