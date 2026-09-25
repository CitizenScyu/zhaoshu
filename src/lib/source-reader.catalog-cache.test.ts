// xfer41：目录会话读缓存（source-reader.ts readCatalogPayload）。每读一章都要取整本目录 payload，
// 改前同一会话每次都整行读库；改后 TTL 内只读一次，缺失/过期不缓存，TTL=0（单测默认）完全旁路。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { text: string; values: unknown[] };
const { getSql, execute } = vi.hoisted(() => ({ getSql: vi.fn(), execute: vi.fn<(query: Query) => Promise<unknown[]>>() }));
vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));
vi.mock('./db', () => ({ ensureSchema: vi.fn(), getSql }));

import { clearSourceCatalogCache, currentSourceHint, SourceRequestContext } from './source-reader';

const catalog = (id: string) => ({
  version: id, title: '书', author: '作者', sourceId: 's', sourceName: '源名', sourceUrl: 'https://book15.net/',
  bookUrl: `https://book15.net/book/${id}`, revision: 'r',
  chapters: Array.from({ length: 1500 }, (_, i) => ({ title: `第${i + 1}章 标题`, url: `https://book15.net/book/${id}/${i}.html` })),
});
const rows = new Map<string, unknown>();
const selects = () => execute.mock.calls.filter(([query]) => query.text.includes('FROM source_read_catalogs')).length;
const ctx = () => new SourceRequestContext(new AbortController().signal, 4);

beforeEach(() => {
  vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '300000');
  clearSourceCatalogCache();
  rows.clear();
  rows.set('v1', catalog('v1'));
  execute.mockReset().mockImplementation(async (query) => {
    if (query.text.includes('FROM source_read_catalogs')) {
      const payload = rows.get(query.values[0] as string);
      return payload ? [{ payload }] : [];
    }
    return [];
  });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
  getSql.mockReturnValue(Object.assign(sql, {
    transaction: async (queries: Query[]) => Promise.all(queries.map((query) => execute(query))),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearSourceCatalogCache();
});

describe('目录会话读缓存', () => {
  it('反例：同一会话两次取目录只读一次库（千章目录 ≈100 KB+/次）', async () => {
    const a = await currentSourceHint('v1', ctx());
    const b = await currentSourceHint('v1', ctx());
    expect(a.catalog?.chapters).toHaveLength(1500);
    expect(b).toEqual(a);
    expect(selects()).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(a.catalog))).toBeGreaterThan(100_000);
  });

  it('缺失/过期的会话不缓存：之后库里出现即读到', async () => {
    expect(await currentSourceHint('v2', ctx())).toEqual({});
    rows.set('v2', catalog('v2'));
    expect((await currentSourceHint('v2', ctx())).currentBookUrl).toBe('https://book15.net/book/v2');
    expect(selects()).toBe(2);
  });

  it('TTL 到期重读；TTL=0 完全旁路', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
    await currentSourceHint('v1', ctx());
    vi.setSystemTime(Date.now() + 300_001);
    await currentSourceHint('v1', ctx());
    expect(selects()).toBe(2);
    vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
    clearSourceCatalogCache();
    await currentSourceHint('v1', ctx());
    await currentSourceHint('v1', ctx());
    expect(selects()).toBe(4);
  });
});
