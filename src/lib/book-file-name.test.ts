import { describe, expect, it } from 'vitest';
import { bookFilename, findBookFilename, sanitizeBookFilename } from './book-file-name';
import filenameCases from './fixtures/book-filenames.json';

describe('download worker compatible book filenames', () => {
  it.each(filenameCases)('uses the canonical worker name for $title / $author', ({ title, author, expected }) => {
    expect(bookFilename(title, author)).toBe(expected);
    expect(() => encodeURIComponent(bookFilename(title, author))).not.toThrow();
  });
  it.each([
    ['  山/河:故*事?"<>|\\ -- ', '山河故事'],
    ['甲\t乙\n丙\r丁\u0000戊\u007f', '甲乙丙丁戊'],
    ['  山　 海  故事  ', '山 海 故事'],
    ['--- ', ''],
    ['文'.repeat(81), '文'.repeat(80)],
    ['文'.repeat(79) + '-作者', '文'.repeat(79)],
  ])('sanitizes %j using the worker naming rules', (input, expected) => {
    expect(sanitizeBookFilename(input)).toBe(expected);
  });

  it('sanitizes and truncates title and author together, before adding the extension', () => {
    expect(bookFilename('长篇/小说', '测:试作者')).toBe('长篇小说-测试作者.txt');
    expect(bookFilename('文'.repeat(78), '作者')).toBe('文'.repeat(78) + '-作.txt');
    expect(bookFilename('山河', '')).toBe('山河-佚名.txt');
  });

  it('prefers an exact author match even when several books share a title', () => {
    expect(findBookFilename(['山河-甲.txt', '山河-乙.txt'], '山河', '乙')).toBe('山河-乙.txt');
  });

  it('uses an unambiguous title prefix for older author spellings', () => {
    expect(findBookFilename(['山河-旧名.txt', '其他-作者.txt'], '山河', '新名')).toBe('山河-旧名.txt');
  });

  it('prefers the anonymous worker name while retaining exact authorless legacy files', () => {
    expect(findBookFilename(['山河-佚名.txt', '山河-其他作者.txt', '山河.txt'], '山河', '')).toBe('山河-佚名.txt');
    expect(findBookFilename(['山河.txt', '山河-其他作者.txt'], '山河', '')).toBe('山河.txt');
    expect(findBookFilename(['山河.txt'], '山河', '佚名')).toBe('山河.txt');
  });

  it.each([
    [['山河-甲.txt', '山河-乙.txt'], '山河'],
    [['山河志-作者.txt'], '山河'],
    [['山河-作者.json'], '山河'],
    [['-作者.txt'], '/'],
  ])('does not select an ambiguous or unrelated file from %j', (names, title) => {
    expect(findBookFilename(names, title, '未知作者')).toBeNull();
  });
});
