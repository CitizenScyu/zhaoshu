import { describe, expect, it } from 'vitest';
import {
  charsetFromContentType, encodeQueryComponent, encodeToBytes, javaCjkCharset, javaUrlEncodeCjk, normalizeCharset,
} from './source-charset';

describe('gbkjs1029 javaUrlEncodeCjk（java.net.URLEncoder GBK 系口径）', () => {
  it('字符集名：Java Charset.forName 大小写不敏感、不 trim，只收 gbk/gb2312/gb18030', () => {
    expect(javaCjkCharset('GBK')).toBe('gbk');
    expect(javaCjkCharset('Gb2312')).toBe('gb2312');
    expect(javaCjkCharset('gb18030')).toBe('gb18030');
    for (const raw of [' gbk', 'gb-2312', 'x-gbk', 'utf-8', 'big5', undefined]) expect(javaCjkCharset(raw)).toBeNull();
  });

  it('ASCII 按 URLEncoder：只留 A-Za-z0-9.-*_，空格 +，其余单字节 %XX', () => {
    expect(javaUrlEncodeCjk('a Z-_.*~!/', 'gbk')).toBe('a+Z-_.*%7E%21%2F');
  });

  it('汉字与全角空格编 GBK 双字节；三种字符集在 GB2312 区一致', () => {
    for (const cs of ['gbk', 'gb2312', 'gb18030'] as const) expect(javaUrlEncodeCjk('书名　中', cs)).toBe('%CA%E9%C3%FB%A1%A1%D6%D0');
  });

  it('GBK 扩展区汉字：gbk/gb18030 收，gb2312 表外致命失败', () => {
    expect(javaUrlEncodeCjk('镕', 'gbk')).toBe(javaUrlEncodeCjk('镕', 'gb18030'));
    expect(javaUrlEncodeCjk('镕', 'gbk')).toMatch(/^%[89A-F][0-9A-F]%[0-9A-F]{2}$/);
    expect(() => javaUrlEncodeCjk('镕', 'gb2312')).toThrow('U+9555');
  });

  it.each([['·'], ['é'], ['：'], ['€'], ['😀'], ['']])('映射不一/表外字符 %s 抛错、不回退 UTF-8', (ch) => {
    expect(() => javaUrlEncodeCjk(`书${ch}`, 'gbk')).toThrow('不能按 gbk 复现');
  });
});

describe('source-charset 归一化', () => {
  it.each([
    ['UTF-8', 'utf-8'], ['utf8', 'utf-8'],
    ['GBK', 'gbk'], ['gb2312', 'gbk'], ['GB-2312', 'gbk'], ['x-gbk', 'gbk'],
    ['gb18030', 'gb18030'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeCharset(raw)).toBe(expected);
  });

  it('未知/非字符串 → null', () => {
    expect(normalizeCharset('big5')).toBeNull();
    expect(normalizeCharset('shift_jis')).toBeNull();
    expect(normalizeCharset('constructor')).toBeNull();
    expect(normalizeCharset('__proto__')).toBeNull();
    expect(normalizeCharset(42)).toBeNull();
    expect(normalizeCharset(undefined)).toBeNull();
  });

  it('从 Content-Type 提取字符集', () => {
    expect(charsetFromContentType('text/html; charset=gbk')).toBe('gbk');
    expect(charsetFromContentType('text/html;charset="GB2312"')).toBe('gbk');
    expect(charsetFromContentType('text/html; charset=utf-8')).toBe('utf-8');
    expect(charsetFromContentType('text/html')).toBeNull();
    expect(charsetFromContentType('text/html; charset=big5')).toBeNull();
    expect(charsetFromContentType(null)).toBeNull();
  });
});

describe('encodeQueryComponent', () => {
  it('utf-8 与 encodeURIComponent 一致', () => {
    for (const s of ['剑来', '斗破 苍穹', 'a-b_c.d', 'x&y=z']) {
      expect(encodeQueryComponent(s, 'utf-8')).toBe(encodeURIComponent(s));
    }
  });

  it('GBK 按双字节表百分号编码（剑来=%BD%A3%C0%B4）', () => {
    expect(encodeQueryComponent('剑来', 'gbk')).toBe('%BD%A3%C0%B4');
    expect(encodeQueryComponent('圣墟', 'gbk')).toBe('%CA%A5%D0%E6');
  });

  it('GBK 下 ASCII unreserved 原样、保留字符单字节百分号', () => {
    expect(encodeQueryComponent('ab-1', 'gbk')).toBe('ab-1');
    expect(encodeQueryComponent('a b', 'gbk')).toBe('a%20b');
  });

  it('GBK 双字节可被 TextDecoder(gbk) 还原', () => {
    const enc = encodeQueryComponent('剑来圣墟', 'gbk');
    const bytes = Uint8Array.from(enc.match(/%[0-9A-F]{2}/g)!.map((h) => parseInt(h.slice(1), 16)));
    expect(new TextDecoder('gbk').decode(bytes)).toBe('剑来圣墟');
  });
});

describe('encodeToBytes（POST body 字节化）', () => {
  it('utf-8 = TextEncoder', () => {
    expect(encodeToBytes('来x', 'utf-8')).toEqual(new TextEncoder().encode('来x'));
  });

  it('GBK JSON body 的 CJK 得到 GBK 字节且可还原', () => {
    const body = '{"key":"剑来"}';
    const bytes = encodeToBytes(body, 'gbk');
    expect(new TextDecoder('gbk').decode(bytes)).toBe(body);
    // ASCII 部分单字节不变
    expect(Array.from(bytes.slice(0, 8))).toEqual(Array.from(new TextEncoder().encode('{"key":"')));
  });
});
