import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent } from './api';
import { compileSource } from './compile';
import { engineContentTextNodesFallbackEnabled } from './syntax-flags';

const SITE = 'https://book15.net'; // 过 host 门（.example 保留域取页被拒）
const url = `${SITE}/b/1.html`;
// 合成页：正文全在 .con 的 <p> 子元素里，.con 自身没有直接文本节点（www.suduguu.com 现网形态）。
const pPage = '<html><body><h1>第一章</h1><div class="con">\n\n<p>　　第一段&amp;。</p><p>　　第二段。</p>\n\n</div></body></html>';

function read(content: string, html: string, strict = true) {
  const source = { url: SITE, name: '合成源', searchUrl: '/s?q={{key}}', rules: { ruleContent: { content } } };
  const context = { page: async (target: string) => ({ url: target, text: html }) } as unknown as SourceRequestContext;
  return engineFetchContent({ ...source, compiled: compileSource(source) }, url, context, strict);
}

describe('textnodes1031 正文 @textNodes 取空兜底', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('开关解析', () => {
    expect(engineContentTextNodesFallbackEnabled({})).toBe(false);
    expect(engineContentTextNodesFallbackEnabled({ ENGINE_CONTENT_TEXTNODES_FALLBACK: 'yes' })).toBe(false);
    expect(engineContentTextNodesFallbackEnabled({ ENGINE_CONTENT_TEXTNODES_FALLBACK: ' On ' })).toBe(true);
  });

  it('off：逐字不变，strict 仍 empty_content_page', async () => {
    await expect(read('.con@textNodes', pPage)).rejects.toThrow('empty_content_page');
  });

  it('on：改取 @html 按正文口径转纯文本（段落换行、实体解码、全角缩进保留）', async () => {
    vi.stubEnv('ENGINE_CONTENT_TEXTNODES_FALLBACK', '1');
    expect((await read('.con@textNodes', pPage)).text).toBe('　　第一段&。\n　　第二段。');
  });

  it('on：## 尾缀照旧作用于兜底结果', async () => {
    vi.stubEnv('ENGINE_CONTENT_TEXTNODES_FALLBACK', '1');
    expect((await read('.con@textNodes##第二段', pPage)).text).toBe('　　第一段&。\n　　。');
  });

  it('on：|| 全部是 @textNodes 支才兜底，首个非空支的结果不变', async () => {
    vi.stubEnv('ENGINE_CONTENT_TEXTNODES_FALLBACK', '1');
    vi.stubEnv('ENGINE_SYNTAX_OR', '1');
    expect((await read('#nr@textNodes||.con@textNodes', pPage)).text).toBe('　　第一段&。\n　　第二段。');
    await expect(read('#nr@text||.con@textNodes', pPage)).rejects.toThrow('empty_content_page');
  });

  it('on：XPath /text() 同口径（www.bqgns.com 形态）', async () => {
    vi.stubEnv('ENGINE_CONTENT_TEXTNODES_FALLBACK', '1');
    vi.stubEnv('ENGINE_SYNTAX_XPATH', '1');
    expect((await read("//div[@class='con']/text()", pPage)).text).toBe('　　第一段&。\n　　第二段。');
  });

  it('on：直接文本非空时不兜底，<p> 里的文字照旧不取', async () => {
    vi.stubEnv('ENGINE_CONTENT_TEXTNODES_FALLBACK', '1');
    const mixed = '<html><body><div class="con">直接文本<p>广告</p></div></body></html>';
    expect((await read('.con@textNodes', mixed)).text).toBe('直接文本');
  });

  it('on：选择器无命中或子元素也没有文字时仍是空页', async () => {
    vi.stubEnv('ENGINE_CONTENT_TEXTNODES_FALLBACK', '1');
    await expect(read('#nr@textNodes', pPage)).rejects.toThrow('empty_content_page');
    await expect(read('.con@textNodes', '<html><body><div class="con"><p> </p><img src="/a.png"></div></body></html>'))
      .rejects.toThrow('empty_content_page');
  });
});
