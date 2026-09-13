import { describe, expect, it } from 'vitest';
import { parseRating, parseVotes } from './douban';

// 真实豆瓣详情页片段
const SUBJECT_HTML = `
<div class="rating_wrap clearbox">
  <strong class="rating_num " property="v:average"> 8.5 </strong>
  <span property="v:votes">2617</span>人评价
</div>
`;

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
