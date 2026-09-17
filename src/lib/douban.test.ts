import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRating, parseVotes, verifyBatch, verifyBook } from './douban';

// 真实豆瓣详情页片段
const SUBJECT_HTML = `
<div class="rating_wrap clearbox">
  <strong class="rating_num " property="v:average"> 8.5 </strong>
  <span property="v:votes">2617</span>人评价
</div>
`;

describe('response-body timeouts', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  function stalledBody(signal: AbortSignal) {
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }));
  }

  it('times out stalled suggest JSON after headers and returns unavailable', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => stalledBody(signal = init.signal)));
    const result = verifyBook('测试书', '作者');
    await vi.advanceTimersByTimeAsync(12_001);
    expect(signal.aborted).toBe(true);
    expect(await result).toMatchObject({ status: 'unavailable', found: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out stalled subject text while retaining verified identity without a score', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => String(url).includes('subject_suggest')
      ? Response.json([{ id: '1', title: '测试书', author_name: '作者' }]) : stalledBody(signal = init.signal)));
    const result = verifyBook('测试书', '作者');
    await vi.advanceTimersByTimeAsync(12_001);
    expect(signal.aborted).toBe(true);
    expect(await result).toMatchObject({ status: 'verified', found: true, doubanId: '1', note: '详情页暂不可达，未取到评分' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases all concurrency slots when response bodies stall', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url, init) => stalledBody(init.signal));
    vi.stubGlobal('fetch', fetcher);
    const result = verifyBatch(Array.from({ length: 6 }, (_, i) => ({ title: `书${i}`, author: '作者' })));
    await vi.advanceTimersByTimeAsync(24_001);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect((await result).every(info => info.status === 'unavailable')).toBe(true);
  });

  it('clears timers after successful body consumption', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('subject_suggest')
      ? Response.json([{ id: '1', title: '测试书', author_name: '作者' }]) : new Response(SUBJECT_HTML)));
    expect(await verifyBook('测试书', '作者')).toMatchObject({ status: 'verified', rating: 8.5, ratingCount: 2617 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// 书名判定（pickMatch）：候选全部构造，不联网。
// 断言 doubanId 是为了证明「选中了哪一条」，而不只是「有没有命中」。
describe('书名判定：同一本书 vs 另一本书', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const WUZEI = '爱潜水的乌贼';

  function stubSuggest(items: { id: string; title: string; author_name: string }[]) {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      String(url).includes('subject_suggest') ? Response.json(items) : new Response(SUBJECT_HTML)));
  }

  it('续篇不是同一本书：《诡秘之主》不匹配《诡秘之主2》', async () => {
    stubSuggest([{ id: '2', title: '诡秘之主2', author_name: WUZEI }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'not_found', found: false });
  });

  it('外传不是同一本书：《诡秘之主》不匹配《诡秘之主 · 外传》', async () => {
    stubSuggest([{ id: '3', title: '诡秘之主 · 外传', author_name: WUZEI }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'not_found', found: false });
  });

  it('前传不是同一本书：《诡秘之主》不匹配《诡秘之主前传》', async () => {
    stubSuggest([{ id: '4', title: '诡秘之主前传', author_name: WUZEI }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'not_found', found: false });
  });

  it('数字后缀不是同一本书（中文候选：《诡秘之主 Vol.2》）', async () => {
    stubSuggest([{ id: '5', title: '诡秘之主 Vol.2', author_name: WUZEI }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'not_found', found: false });
  });

  it('英文后缀不是同一本书（英文候选：《Dune》不匹配《Dune Messiah》）', async () => {
    stubSuggest([{ id: '6', title: 'Dune Messiah', author_name: 'Frank Herbert' }]);
    expect(await verifyBook('Dune', 'Frank Herbert')).toMatchObject({ status: 'not_found', found: false });
  });

  it('冒号副标题没有可靠信号，不认：《人类简史》不匹配《人类简史：从动物到上帝》', async () => {
    stubSuggest([{ id: '7', title: '人类简史：从动物到上帝', author_name: '尤瓦尔·赫拉利' }]);
    expect(await verifyBook('人类简史', '尤瓦尔·赫拉利')).toMatchObject({ status: 'not_found', found: false });
  });

  it('冒号副标题可能是另一本书且作者相同，故一律不认：《三体》不匹配《三体：死神永生》', async () => {
    stubSuggest([{ id: '10', title: '三体：死神永生', author_name: '刘慈欣' }]);
    expect(await verifyBook('三体', '刘慈欣')).toMatchObject({ status: 'not_found', found: false });
  });

  it('书名完全一致应当命中', async () => {
    stubSuggest([{ id: '1', title: '诡秘之主', author_name: WUZEI }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'verified', doubanId: '1' });
  });

  it('书名完全一致、请求方未给作者，也应命中', async () => {
    stubSuggest([{ id: '1', title: '诡秘之主', author_name: WUZEI }]);
    expect(await verifyBook('诡秘之主')).toMatchObject({ status: 'verified', doubanId: '1' });
  });

  it('书名完全一致、作者写法不同（带后缀 / 顺序不同）也应命中', async () => {
    stubSuggest([{ id: '1', title: '诡秘之主', author_name: `${WUZEI} 著` }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'verified', doubanId: '1' });
  });

  it('候选里同时有正条目和衍生条目时，必须选正条目', async () => {
    stubSuggest([
      { id: '9', title: '诡秘之主 1', author_name: WUZEI },
      { id: '1', title: '诡秘之主', author_name: WUZEI },
    ]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'verified', doubanId: '1' });
  });

  it('作者已知而候选作者字段为空：不判为已验证', async () => {
    stubSuggest([{ id: '1', title: '诡秘之主', author_name: '' }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'not_found', found: false });
  });

  it('同名但作者不同：不判为已验证', async () => {
    stubSuggest([{ id: '8', title: '诡秘之主', author_name: '另一个人' }]);
    expect(await verifyBook('诡秘之主', WUZEI)).toMatchObject({ status: 'not_found', found: false });
  });
});

describe('parseRating', () => {
  it('extracts the rating from a real subject page', () => {
    expect(parseRating(SUBJECT_HTML)).toBe(8.5);
  });

  it('handles whitespace around the value (known pitfall)', () => {
    expect(parseRating('<strong class="rating_num " property="v:average"> 9.1 </strong>')).toBe(9.1);
  });

  it('handles no whitespace at all', () => {
    expect(parseRating('<strong class="rating_num">8.0</strong>')).toBe(8);
  });

  it('handles a multi-digit integer rating', () => {
    expect(parseRating('<strong class="rating_num">10</strong>')).toBe(10);
  });

  it('returns null when the marker is absent', () => {
    expect(parseRating('<div>暂无评分</div>')).toBeNull();
  });

  it('does not match a value that is not a number', () => {
    expect(parseRating('<strong class="rating_num">暂无</strong>')).toBeNull();
  });
});

describe('parseVotes', () => {
  it('extracts the vote count from a real subject page', () => {
    expect(parseVotes(SUBJECT_HTML)).toBe(2617);
  });

  it('handles digits inside a span while 人评价 sits outside (known pitfall)', () => {
    expect(parseVotes('<span property="v:votes">2617</span>人评价')).toBe(2617);
  });

  it('strips comma group separators', () => {
    expect(parseVotes('<span property="v:votes">1,234</span>人评价')).toBe(1234);
  });

  it('strips full-width comma separators', () => {
    expect(parseVotes('<span property="v:votes">1，234</span>人评价')).toBe(1234);
  });

  it('handles whitespace around the number', () => {
    expect(parseVotes('<span property="v:votes"> 88 </span>人评价')).toBe(88);
  });

  it('returns null when the marker is absent', () => {
    expect(parseVotes('<div>暂无评价</div>')).toBeNull();
  });
});
