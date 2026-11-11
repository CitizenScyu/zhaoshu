import { describe, expect, it } from 'vitest';
import { selectCandidates, type RawSource } from './compile-smoke';

// junkhost1112：bookSourceUrl 的 host 段拼了备注/选项的源不入选。
const src = (bookSourceUrl: string): RawSource => ({
  bookSourceUrl,
  searchUrl: '/s?q={{key}}',
  ruleSearch: { bookList: '.book' },
  ruleContent: { content: '.content' },
});

describe('selectCandidates × host 段备注（junkhost1112）', () => {
  it.each([
    'https://book15.net',
    'http://book15.net',
    'https://m.book15.net/',
    'https://book15.net/路径/中文?q=书名#frag',
    'https://book15.net  ',
  ])('正常 host 照旧入选：%s', (url) => {
    expect(selectCandidates([src(url)]).length).toBe(1);
  });

  it.each([
    'https://zhidao.baidu.com已校验',
    'https://m.iyouman.com♤Haxc',
    'https://www.b5200.net-By Dark',
    "https://www.555x.org,{{'webView': true}}",
    'https://m.fbook.net 备用',
    'https://八叉书库.example.com',
    'https:///s',
  ])('host 段带备注/空白/逗号/非 ASCII 不入选：%s', (url) => {
    expect(selectCandidates([src(url)]).length).toBe(0);
  });
});
