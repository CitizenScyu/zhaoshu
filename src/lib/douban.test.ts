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
