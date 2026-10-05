import { describe, expect, it } from 'vitest';
import { classifySourceAdult } from './source-adult-classification';

describe('source adult metadata classification', () => {
  it.each(['🈲', '🔞'])('recognizes %s anywhere in each independent metadata position', (marker) => {
    const marked = `普通前缀${marker}普通后缀`;
    expect(classifySourceAdult(marked, {})).toBe('adult');
    expect(classifySourceAdult('普通名称', { bookSourceName: marked })).toBe('adult');
    expect(classifySourceAdult('普通名称', { bookSourceGroup: marked })).toBe('adult');
  });

  it.each([
    '成人', '普通 | 成人 | 小说', '【成人】', '成人小说精选', '成人文学', '成人书源', '成人内容', '成人专区',
    'NSFW', '(nsfw)', '普通，R18；小说', 'r-18', '普通【18+】', '18禁', '普通 / R18 / 小说',
  ])('recognizes explicit phrases or delimited tokens: %s', (text) => {
    expect(classifySourceAdult(text, {})).toBe('adult');
  });

  it.each([
    '', '普通小说', '漫画', '听书', '外文', '成人教育', '成人高考', '成人礼',
    '成年人读物', 'NSFWish', 'VR18', 'R18x', 'R-180', '118+', '18++', '18禁令',
  ])('does not infer markers from ordinary categories or token substrings: %s', (text) => {
    expect(classifySourceAdult(text, { bookSourceName: text, bookSourceGroup: text })).toBe('unmarked');
  });

  it('allows missing, null and empty string metadata without changing the source object', () => {
    const source = Object.freeze({ bookSourceName: null, bookSourceGroup: '', ruleSearch: Object.freeze({ name: '.title' }) });
    expect(classifySourceAdult(undefined, {})).toBe('unmarked');
    expect(classifySourceAdult(null, source)).toBe('unmarked');
    expect(source).toEqual({ bookSourceName: null, bookSourceGroup: '', ruleSearch: { name: '.title' } });
  });

  it.each([undefined, null, [], 'source', 1, true])('rejects a non-object or array source: %s', (source) => {
    expect(classifySourceAdult('🔞', source)).toBe('invalid');
  });

  it.each([false, 0, [], {}])('invalid fields take precedence over markers in any other position: %j', (bad) => {
    expect(classifySourceAdult(bad, { bookSourceName: '🔞', bookSourceGroup: '普通' })).toBe('invalid');
    expect(classifySourceAdult('🈲', { bookSourceName: bad })).toBe('invalid');
    expect(classifySourceAdult('普通', { bookSourceName: '成人小说', bookSourceGroup: bad })).toBe('invalid');
  });
});
