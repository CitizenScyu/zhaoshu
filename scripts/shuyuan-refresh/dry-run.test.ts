import { afterEach, describe, expect, it, vi } from 'vitest';

// dry-run 的抓取/合并去重必须与 refreshShuyuan 同语义(同一批导出件:fetchText/parseIndex/
// sameRules/normalizeUrl/cleanJson)。这里用合成上游 + 桩库行钉住计数口径:
//   merged = 去重后源数;added = 库中无;updated = 同 url 但规则变;unchanged = 同 url 同规则;
//   removed = 库中有但本轮上游没有。
// 不连真库、不连真上游(mock fetch),不写库(dry-run 全程只有一条 SELECT 桩)。

const rows: { source_url: string; source: Record<string, unknown> }[] = [];
vi.mock('@/lib/db', () => ({
  getSql: () => (async () => rows),
}));

import { dryRunRefresh } from './dry-run';

const INDEX_HTML = [
  '<a href="/yuedu/shuyuans/content/id/100.html">合集A</a>',
  '<a href="/yuedu/shuyuans/content/id/101.html">合集B</a>',
  '<a href="/yuedu/shuyuans/content/id/102.html">合集C</a>',
].join('\n');

const collection = (entries: { url: string; name: string; extra?: string }[]) => entries.map((e) => ({
  bookSourceUrl: e.url, bookSourceName: e.name, bookSourceGroup: 'g', tag: e.extra ?? 'x',
}));

function stubFetch(byId: Record<number, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/yuedu/shuyuans/index.html')) return new Response(INDEX_HTML, { status: 200 });
    const m = /json\/id\/(\d+)\.json/.exec(String(url));
    if (m) {
      const body = byId[Number(m[1])];
      if (body === undefined) return new Response('gone', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); rows.length = 0; });

describe('dryRunRefresh 计数口径', () => {
  it('新增/更新/未变/删除 与库内既有行逐条比对', async () => {
    stubFetch({
      100: collection([
        { url: 'https://a.example/1', name: '新源A' },            // added(库无)
        { url: 'https://a.example/2', name: '改名B' },            // updated(同 url,规则变:name 变)
        { url: 'https://a.example/3', name: '旧源C' },            // unchanged(同 url 同规则)
      ]),
      101: collection([{ url: 'https://a.example/3/', name: '旧源C' }]), // 尾部斜杠 → normalizeUrl 撞已存在的 3
      102: collection([{ url: 'https://a.example/4', name: '新源D' }]),
    });
    // 库内既有行:2 仅书名字段不同(→ updated);3 与上游逐字相同(→ unchanged);
    // gone 上游已无(→ removed)。键顺序不同不影响 sameRules。
    rows.push(
      { source_url: 'https://a.example/2', source: { tag: 'x', bookSourceName: '原名B', bookSourceUrl: 'https://a.example/2', bookSourceGroup: 'g' } },
      { source_url: 'https://a.example/3', source: { bookSourceUrl: 'https://a.example/3', bookSourceName: '旧源C', bookSourceGroup: 'g', tag: 'x' } },
      { source_url: 'https://a.example/gone', source: { bookSourceUrl: 'https://a.example/gone', bookSourceName: '已消失', bookSourceGroup: 'g', tag: 'x' } },
    );

    const counts = await dryRunRefresh();
    expect(counts.compared).toBe(true);
    expect(counts.collectionIds).toEqual([100, 101, 102]);
    expect(counts.merged).toBe(4); // 1,2,3,4(3/ 归一化后与 3 同键)
    expect(counts.added).toBe(2);  // 1、4
    expect(counts.updated).toBe(1); // 2(name 变)
    expect(counts.unchanged).toBe(1); // 3
    expect(counts.removed).toBe(1); // gone
  });

  it('DRY_RUN_NO_DB=1 时只抓上游、不连库(计数置空)', async () => {
    stubFetch({ 100: collection([{ url: 'https://a.example/1', name: 'X' }]), 101: [], 102: [] });
    process.env.DRY_RUN_NO_DB = '1';
    try {
      const counts = await dryRunRefresh();
      expect(counts.compared).toBe(false);
      expect(counts.merged).toBe(1);
      expect(counts.added).toBeNull();
    } finally {
      delete process.env.DRY_RUN_NO_DB;
    }
  });
});
