import { describe, expect, it } from 'vitest';
import type { SourceRequestContext } from '@/lib/source-reader';
import { engineFetchContent } from './api';
import { compileSource } from './compile';

const url = 'https://book15.net/challenge-fixture/chapter';
const form = '<form id="challenge-form" action="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1">Verify you are human</form>';
const challenge = '<html><head><title>Just a moment...</title></head><body><h1>Checking your browser...</h1>' + form + '</body></html>';
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function read(html: string, next?: string, strict = false) {
  const source = { url: 'https://book15.net/fixture', name: '合成源', searchUrl: '/search?q={{key}}', rules: {
    ruleContent: { content: 'body@text', nextContentUrl: 'a.next@href' },
  } };
  let calls = 0;
  const context = { page: async (target: string) => {
    calls++;
    expect(target).toBe(calls === 1 ? url : url + '?page=2');
    return { url: target, text: calls === 1 ? html : next! };
  } } as unknown as SourceRequestContext;
  return engineFetchContent({ ...source, compiled: compileSource(source) }, url, context, strict);
}

describe('正文挑战页必须有真实结构和页面提示', () => {
  it.each([false, true])('首页及后续挑战拒绝整章，strict=%s', async (strict) => {
    await expect(read(challenge, undefined, strict)).rejects.toMatchObject({ name: 'SourcePolicyError' });
    await expect(read('<body>正常前半章<a class="next" href="?page=2">继续</a></body>', challenge, strict))
      .rejects.toMatchObject({ name: 'SourcePolicyError' });
  });
  it('长挑战提示也拒绝，不依赖短正文阈值', async () => {
    await expect(read(challenge.replace('</body>', '<p>' + '浏览器验证中。'.repeat(100) + '</p></body>')))
      .rejects.toMatchObject({ name: 'SourcePolicyError' });
  });
  it.each([
    '他打开 geetest 文档，说“验证码和 Just a moment 都只是文字”。',
    '示例：<script src="/cdn-cgi/challenge-platform/demo.js"></script>。本章完。',
    challenge,
  ])('普通词及转义代码逐字保留 %#', async (text) => {
    expect((await read('<body><article>' + escape(text) + '</article></body>')).text).toBe(text);
  });
  it('短尾声单独加载脚本不算挑战', async () => {
    const text = '雨停了，他关上门。';
    expect((await read('<body>' + text + '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body>')).text).toBe(text);
  });
  it('只有真实表单但无页面提示仍保留正文', async () => {
    expect((await read('<html><head><title>第一章</title></head><body>正文' + form + '</body></html>')).text)
      .toBe('正文Verify you are human');
  });
  it('页面提示配转义表单不算真实结构', async () => {
    expect((await read('<html><head><title>Just a moment...</title></head><body>' + escape(form) + '</body></html>')).text).toBe(form);
  });
});
