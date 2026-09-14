import { describe, expect, it } from 'vitest';
import {
  bookKey,
  cleanString,
  finiteScore,
  isRecord,
  sanitizeCandidates,
  sanitizeRerankedItems,
  sanitizeSeeds,
  sanitizeVerified,
} from './sanitize';

describe('cleanString', () => {
  it('trims and returns a bounded string', () => {
    expect(cleanString('  hi  ')).toBe('hi');
  });

  it('returns empty string for non-strings', () => {
    expect(cleanString(42)).toBe('');
    expect(cleanString(null)).toBe('');
    expect(cleanString({})).toBe('');
  });

  it('returns empty string when over the limit', () => {
    expect(cleanString('x'.repeat(501))).toBe('');
    expect(cleanString('x'.repeat(500))).toHaveLength(500);
  });

  it('honours a custom max length', () => {
    expect(cleanString('abcdef', 3)).toBe('');
    expect(cleanString('abc', 3)).toBe('abc');
  });
});

describe('untrusted field validation', () => {
  it.each([null, [], 'text', 1, true])('does not treat %j as an object', (value) => {
    expect(isRecord(value)).toBe(false);
  });

  it.each([String.fromCharCode(0), '\ud800', '\udc00'])('rejects database-illegal text %j', (bad) => {
    expect(cleanString('正文' + bad)).toBe('');
    expect(sanitizeCandidates([{ title: 'T', author: 'A', why: bad }])).toEqual([]);
    expect(sanitizeRerankedItems([{ title: 'T', author: 'A', matchScore: 0, reason: bad }])).toEqual([]);
    expect(sanitizeRerankedItems([{ title: 'T', author: 'A', matchScore: 0, hitLikes: [bad] }])).toEqual([]);
    expect(sanitizeSeeds([{ title: 'T', author: bad }])).toEqual([]);
  });

  it('preserves valid unicode, newlines and surrogate pairs', () => {
    expect(cleanString('  正文😀\n下一行  ')).toBe('正文😀\n下一行');
  });

  it.each([null, undefined, '', ' \t\n ', false, true, [], {}, '0x10', 'Infinity', NaN, Infinity])(
    'does not coerce %j into a score', (value) => {
      expect(finiteScore(value)).toBeNull();
      expect(sanitizeRerankedItems([{ title: 'T', author: 'A', matchScore: value }])).toEqual([]);
    },
  );

  it.each([0, '0', ' 0 ', '0.0'])('preserves a real zero score %j', (value) => {
    expect(finiteScore(value)).toBe(0);
    expect(sanitizeRerankedItems([{ title: 'T', author: 'A', matchScore: value }])[0].matchScore).toBe(0);
  });
});

describe('bookKey', () => {
  it('normalizes case and whitespace', () => {
    expect(bookKey('  Foo ', 'BAR')).toBe(bookKey('foo', ' bar '));
  });

  it('separates title and author so the pair is unambiguous', () => {
    expect(bookKey('ab', 'c')).not.toBe(bookKey('a', 'bc'));
  });

  it('does not collide across title/author boundaries', () => {
    // 逗号分隔的实现会让这两组相等;NUL 分隔不会
    expect(bookKey('a,b', 'c')).not.toBe(bookKey('a', 'b,c'));
  });

  it('applies NFKC so full-width and half-width forms match', () => {
    expect(bookKey('ＡＢＣ', 'ｘ')).toBe(bookKey('abc', 'x'));
  });
});

describe('sanitizeCandidates', () => {
  it('keeps well-formed candidates and forces source=llm', () => {
    const out = sanitizeCandidates([
      { title: ' 诡秘之主 ', author: '爱潜水的乌贼', category: '西幻', wordCount: '约400万字', why: '设定强' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: '诡秘之主',
      author: '爱潜水的乌贼',
      category: '西幻',
      source: 'llm',
    });
  });

  it('drops entries missing title or author', () => {
    const out = sanitizeCandidates([
      { title: '', author: 'A' },
      { title: 'B' },
      { author: 'C' },
      null,
      'not an object',
    ]);
    expect(out).toEqual([]);
  });

  it('returns [] for a non-array', () => {
    expect(sanitizeCandidates(null)).toEqual([]);
    expect(sanitizeCandidates({ title: 'x' })).toEqual([]);
  });

  it('caps the list at 12 entries', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, author: 'a' }));
    expect(sanitizeCandidates(many)).toHaveLength(12);
  });

  it('truncates over-long fields to empty strings', () => {
    const out = sanitizeCandidates([{ title: 'x'.repeat(201), author: 'a' }]);
    expect(out).toEqual([]);
  });
});

describe('sanitizeVerified', () => {
  const base = {
    title: 'T',
    author: 'A',
    douban: { status: 'verified', found: true, doubanId: '123', rating: 8.5, ratingCount: 2617, url: 'u' },
  };

  it('keeps a verified entry', () => {
    const out = sanitizeVerified([base]);
    expect(out).toHaveLength(1);
    expect(out[0].douban).toMatchObject({
      status: 'verified',
      found: true,
      doubanId: '123',
      rating: 8.5,
      ratingCount: 2617,
    });
  });

  it('downgrades an unknown status to unavailable and clears found', () => {
    const out = sanitizeVerified([{ ...base, douban: { status: 'weird', found: true } }]);
    expect(out[0].douban.status).toBe('unavailable');
    expect(out[0].douban.found).toBe(false);
  });

  it('does not trust found=true when status is not verified', () => {
    const out = sanitizeVerified([{ ...base, douban: { status: 'not_found', found: true } }]);
    expect(out[0].douban.status).toBe('not_found');
    expect(out[0].douban.found).toBe(false);
  });

  it('nulls non-finite numeric ratings', () => {
    const out = sanitizeVerified([{ ...base, douban: { status: 'verified', found: true, rating: 'high', ratingCount: null } }]);
    expect(out[0].douban.rating).toBeNull();
    expect(out[0].douban.ratingCount).toBeNull();
  });

  it('drops entries without a douban object', () => {
    expect(sanitizeVerified([{ title: 'T', author: 'A' }])).toEqual([]);
  });
});

describe('sanitizeRerankedItems', () => {
  const item = {
    title: 'T',
    author: 'A',
    category: 'c',
    matchScore: '88.6',
    hitLikes: [' 爽文 ', '', 42],
    risks: 'r',
    reason: 'why',
  };

  it('coerces a numeric string matchScore and rounds it', () => {
    const out = sanitizeRerankedItems([item]);
    expect(out[0].matchScore).toBe(89);
  });

  it('clamps matchScore into 0..100', () => {
    expect(sanitizeRerankedItems([{ ...item, matchScore: 250 }])[0].matchScore).toBe(100);
    expect(sanitizeRerankedItems([{ ...item, matchScore: -5 }])[0].matchScore).toBe(0);
  });

  it('filters blank/non-string hitLikes', () => {
    expect(sanitizeRerankedItems([item])[0].hitLikes).toEqual(['爽文']);
  });

  it('drops items without a finite matchScore', () => {
    expect(sanitizeRerankedItems([{ ...item, matchScore: 'N/A' }])).toEqual([]);
  });

  it('only carries hallucinationRisk when strictly true', () => {
    expect('hallucinationRisk' in sanitizeRerankedItems([item])[0]).toBe(false);
    expect(sanitizeRerankedItems([{ ...item, hallucinationRisk: true }])[0].hallucinationRisk).toBe(true);
    expect('hallucinationRisk' in sanitizeRerankedItems([{ ...item, hallucinationRisk: 'yes' }])[0]).toBe(false);
  });
});

describe('sanitizeSeeds', () => {
  it('keeps only seeds with a title and defaults kind to love', () => {
    const out = sanitizeSeeds([
      { title: ' 书 ', author: '' },
      { title: '', author: 'A' },
      { title: '弃书', kind: 'drop', reason: ' 太水 ' },
      { title: 'x'.repeat(201) },
      null,
    ]);
    expect(out).toEqual([
      { title: '书', author: undefined, kind: 'love', reason: undefined },
      { title: '弃书', author: undefined, kind: 'drop', reason: '太水' },
    ]);
  });

  it('returns [] for a non-array', () => {
    expect(sanitizeSeeds('nope')).toEqual([]);
  });
});

describe('bounded unique book lists', () => {
  const first = {
    title: 'ＡＢＣ', author: 'Ｘ', why: '原始理由', matchScore: 80,
    douban: { status: 'not_found', found: false },
  };
  const duplicate = { ...first, title: ' abc ', author: 'x', why: '重复理由' };
  const otherAuthor = { ...first, title: 'abc', author: 'y' };

  it('deduplicates NFKC-equivalent candidates and keeps a different author', () => {
    const result = sanitizeCandidates([first, duplicate, otherAuthor]);
    expect(result.map(({ title, author }) => [title, author])).toEqual([['ＡＢＣ', 'Ｘ'], ['abc', 'y']]);
    expect(result[0].why).toBe('原始理由');
  });

  it('deduplicates verified and reranked books using the same pair key', () => {
    for (const sanitize of [sanitizeVerified, sanitizeRerankedItems]) {
      const result = sanitize([first, duplicate, otherAuthor]);
      expect(result.map(({ title, author }) => [title, author])).toEqual([['ＡＢＣ', 'Ｘ'], ['abc', 'y']]);
    }
  });

  it('bounds reranked books and nested hitLikes', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...first, title: String(i), hitLikes: Array.from({ length: 100 }, () => '萌点'),
    }));
    const result = sanitizeRerankedItems(many);
    expect(result).toHaveLength(10);
    expect(result.every((item) => item.hitLikes.length === 10)).toBe(true);
  });

  it('rejects invalid verification metadata while preserving a zero rating', () => {
    expect(sanitizeVerified([{ ...first, douban: [] }])).toEqual([]);
    expect(sanitizeVerified([{ ...first, douban: { note: '\ud800' } }])).toEqual([]);
    const [invalid] = sanitizeVerified([{ ...first, douban: { rating: 11, ratingCount: -1 } }]);
    expect(invalid.douban).toMatchObject({ rating: null, ratingCount: null });
    const [zero] = sanitizeVerified([{ ...first, douban: { rating: 0, ratingCount: 0 } }]);
    expect(zero.douban).toMatchObject({ rating: 0, ratingCount: 0 });
  });
});
