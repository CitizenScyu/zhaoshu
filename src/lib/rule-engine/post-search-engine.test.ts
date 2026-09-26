import { afterEach, describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineSearchBook, type EngineSource } from './api';
import { compileSource } from './compile';
import { encodeQueryComponent } from '@/lib/source-charset';

const rules = {
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};
const HTML = '<div class="book"><span class="name">剑来</span><span class="author">烽火</span><a href="/d/1.html">x</a></div>';

function source(searchUrl: string): EngineSource {
  return { url: 'https://book15.net/e/', name: '源', searchUrl, compiled: compileSource({ url: 'https://book15.net/e/', searchUrl, rules }) };
}
// 记录每次取页的 url 与 opts；对任何 url 都回同一份 HTML。
function recording() {
  const calls: { url: string; opts: unknown }[] = [];
  const context = { page: async (url: string, opts?: unknown) => { calls.push({ url, opts }); return { url, text: HTML }; } } as unknown as SourceRequestContext;
  return { calls, context };
}

afterEach(() => { delete process.env.ENGINE_POST_SEARCH; });

describe('engineSearchBook × ENGINE_POST_SEARCH 开关', () => {
  const POST_URL = 'https://book15.net/s,{"method":"POST","body":"k={{key}}","charset":"gb2312"}';

  it('关（默认）：POST 选项源沿用旧纯 GET 展开 → 抛不支持', async () => {
    const { context } = recording();
    await expect(engineSearchBook(source(POST_URL), '剑来', context)).rejects.toThrow();
  });

  it('开：POST 源构造 POST 请求 + gbk body + 响应按 gbk 解码', async () => {
    process.env.ENGINE_POST_SEARCH = '1';
    const { calls, context } = recording();
    const results = await engineSearchBook(source(POST_URL), '剑来', context);
    expect(results).toEqual([{ title: '剑来', author: '烽火', bookUrl: 'https://book15.net/d/1.html' }]);
    expect(calls[0].url).toBe('https://book15.net/s');
    expect(calls[0].opts).toEqual({
      request: { method: 'POST', body: `k=${encodeQueryComponent('剑来', 'gbk')}`, headers: undefined, charset: 'gbk' },
      responseCharset: 'gbk',
    });
  });

  it('开：纯 GET 源仍走 GET，responseCharset=auto', async () => {
    process.env.ENGINE_POST_SEARCH = '1';
    const { calls, context } = recording();
    await engineSearchBook(source('https://book15.net/s?q={{key}}'), '剑来', context);
    expect(calls[0].url).toBe(`https://book15.net/s?q=${encodeURIComponent('剑来')}`);
    expect(calls[0].opts).toMatchObject({ request: { method: 'GET', charset: 'utf-8' }, responseCharset: 'auto' });
  });
});
