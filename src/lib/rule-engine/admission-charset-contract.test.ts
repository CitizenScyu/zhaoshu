import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceRequestContext } from '@/lib/source-reader';
import { buildSourceSearchRequest } from '@/lib/source-parser';
import { refreshSupportedHosts } from '@/lib/source-policy';
import { encodeToBytes, type SourceCharset } from '@/lib/source-charset';
import { engineSearchBook } from './api';
import { searchAdmission } from './admission';
import { compileSource } from './compile';

vi.mock('@/lib/db', () => ({ getSql: () => { throw new Error('合成字符集验证不能访问数据库'); } }));
vi.mock('@/lib/shuyuan', () => ({
  getReadingSources: () => { throw new Error('合成字符集验证不能读取源池'); },
  getSourcePools: () => { throw new Error('合成字符集验证不能读取源池'); },
}));

// 真实注册表 book15 已退休（lifecycle='retired'），运行时 engineSearchBook → context.page →
// fetchSourceText 的退休门会在物理发射前拒绝。本契约只测字符集双用途，载体用合成活跃 host
// cc53.test（beforeEach 注册进运行时 host 门、afterEach 复位回内建集合，不跨文件污染）。
const BASE = 'https://cc53.test';
const TITLE = '合成书';
const HTML = '<div class="book" data-title="合成书"><span class="title">合成书</span><span class="author">合成作者</span><a href="/book/1">详情</a></div>';

beforeEach(() => {
  vi.stubEnv('ENGINE_POST_SEARCH', '1');
  refreshSupportedHosts(['cc53.test']);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); refreshSupportedHosts([]); });

function template(method: 'GET' | 'POST', charset: SourceCharset) {
  return BASE + '/charset-contract' + (method === 'GET' ? '?q={{key}}' : '') + ',' + JSON.stringify({
    method, charset, ...(method === 'POST' ? { body: 'q={{key}}' } : {}),
  });
}

async function checkBoth(searchUrl: string, bodyCharset: SourceCharset, headerCharset?: string, expected: 'match' | 'empty' | 'garbled' = 'match') {
  const request = buildSourceSearchRequest(searchUrl, TITLE, BASE);
  const fetchPage = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    expect(String(input)).toBe(request.url);
    expect(init?.method).toBe(request.method);
    expect(init?.body).toEqual(request.body === undefined ? undefined : encodeToBytes(request.body, request.charset));
    return new Response(encodeToBytes(HTML, bodyCharset), {
      headers: { 'Content-Type': 'text/html' + (headerCharset ? `; charset=${headerCharset}` : '') },
    });
  });
  vi.stubGlobal('fetch', fetchPage);
  const rules = {
    ruleSearch: { bookList: expected === 'garbled' ? '.book' : '.book[data-title="合成书"]', name: '.title@text', author: '.author@text', bookUrl: 'a@href' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.content@text' },
  };
  const raw = { bookSourceUrl: BASE, bookSourceName: '合成契约源', checkKeyWord: TITLE, searchUrl, ...rules };
  const admission = await searchAdmission(raw, {
    fetchPage, declaredHosts: new Set(['cc53.test']), signal: new AbortController().signal, throttleMs: 0,
  });
  expect(admission).toMatchObject({ verdict: expected === 'empty' ? 'no_result' : 'ok', candidateCount: expected === 'empty' ? 0 : 1 });
  const source = { url: BASE, name: raw.bookSourceName, searchUrl, compiled: compileSource({ url: BASE, searchUrl, rules }) };
  const context = new SourceRequestContext(new AbortController().signal);
  const results = await engineSearchBook(source, TITLE, context);
  if (expected === 'match') {
    expect(results).toEqual([{ title: TITLE, author: '合成作者', bookUrl: BASE + '/book/1' }]);
  } else if (expected === 'empty') expect(results).toEqual([]);
  else {
    // 非空乱码仍可能通过结构性候选判定，解码策略一致不等于错误声明一定变为no_result。
    expect(results).toHaveLength(1);
    expect(results[0].title).not.toBe(TITLE);
  }
  expect(context.requests).toBe(1);
  expect(fetchPage).toHaveBeenCalledTimes(2);
}

describe('CHARSETCONTRACT53：非UTF8声明保持请求/响应双用途', () => {
  const legacy = ['gbk', 'gb18030'] as const;
  for (const method of ['GET', 'POST'] as const) {
    it.each(legacy)(`${method} 声明 %s、HTTP谎报UTF8但body同声明：两入口保留既有可用结果`, async charset => {
      await checkBoth(template(method, charset), charset, 'utf-8');
    });
    it.each(legacy)(`${method} 声明 %s但body为UTF8：按声明解码，中文筛选两入口同为无候选`, async charset => {
      await checkBoth(template(method, charset), 'utf-8', 'utf-8', 'empty');
    });
  }
  it('结构性规则可能保留非空乱码候选，不把策略对齐声称为错误声明识别', async () => {
    await checkBoth(template('POST', 'gbk'), 'utf-8', 'utf-8', 'garbled');
  });
  it.each(legacy)('声明 %s、无响应charset头时沿用声明', async charset => {
    await checkBoth(template('POST', charset), charset);
  });
  it.each(legacy)('声明 %s、未知响应charset头时沿用声明', async charset => {
    await checkBoth(template('POST', charset), charset, 'synthetic-unknown');
  });
  it.each(legacy)('声明UTF8时仍可由HTTP %s头选择响应解码', async charset => {
    await checkBoth(template('POST', 'utf-8'), charset, charset);
  });
  it.each(legacy)('未声明字符集的GET仍可由HTTP %s头选择响应解码', async charset => {
    await checkBoth(BASE + '/charset-contract?q={{key}}', charset, charset);
  });
  it('普通GET没有charset头时仍按UTF8', async () => {
    await checkBoth(BASE + '/charset-contract?q={{key}}', 'utf-8');
  });
});
