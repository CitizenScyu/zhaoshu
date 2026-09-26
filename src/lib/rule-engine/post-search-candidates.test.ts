import { describe, expect, it } from 'vitest';
import { selectCandidates, type RawSource } from './compile-smoke';

// 最小合格源：HTTPS + 无 JS 规则 + ruleSearch.bookList + ruleContent.content + 非听书。
const src = (searchUrl: string): RawSource => ({
  bookSourceUrl: 'https://book15.net',
  searchUrl,
  ruleSearch: { bookList: '.book' },
  ruleContent: { content: '.content' },
});

const GET = 'https://book15.net/s?q={{key}}';
const POST = 'https://book15.net/s,{"method":"POST","body":"k={{key}}","charset":"gb2312"}';

describe('selectCandidates × postSearch 放开口径（41-postsearch）', () => {
  it('纯 GET 源两态都入选', () => {
    expect(selectCandidates([src(GET)]).length).toBe(1);
    expect(selectCandidates([src(GET)], { postSearch: true }).length).toBe(1);
  });

  it('POST 选项源：默认不入选，postSearch 开时入选', () => {
    expect(selectCandidates([src(POST)]).length).toBe(0);
    expect(selectCandidates([src(POST)], { postSearch: true }).length).toBe(1);
  });

  it('单引号 POST 选项也放开', () => {
    expect(selectCandidates([src("https://book15.net/s,{'method':'POST','body':'k={{key}}'}")], { postSearch: true }).length).toBe(1);
  });

  it.each([
    ['webView', 'https://book15.net/s?q={{key}},{"webView":true}'],
    ['未知键', 'https://book15.net/s?q={{key}},{"method":"POST","foo":1}'],
    ['选项含 java.', 'https://book15.net/s?q={{key}},{"method":"POST","body":"java.ajax()"}'],
    ['非法 JSON', 'https://book15.net/s?q={{key}},{method:POST}'],
  ])('postSearch 开也不入选：%s', (_label, searchUrl) => {
    expect(selectCandidates([src(searchUrl)], { postSearch: true }).length).toBe(0);
  });
});
