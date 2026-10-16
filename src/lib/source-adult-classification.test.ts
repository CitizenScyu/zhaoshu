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

  // adultsrc42：生产池未打标成人站的站名级专名（肉文屋/PO18/肉肉屋/欲望社/御宅屋/御书屋/海棠/桃色/7wav）。
  it.each([
    '肉文屋1', '肉色屋网', '肉书屋🎃#2', '👔 肉肉屋②', '肉肉屋②',
    'PO18 #一程1101', 'po18文学', 'PO18文学🎃#8', 'PO18 脸红心跳🎃',
    '欲望社', '新欲望社🎃', '欲望社🎃#2',
    '新御宅屋', '新御宅🎃', '🔰 新御宅屋', '🎃新御宅屋🎃', '新御书屋',
    '海棠书屋🎃', '海棠书房🎃', '海棠文学',
    '📂桃色小说', '7wav',
  ])('recognizes unmarked adult site names (adultsrc42): %s', (text) => {
    expect(classifySourceAdult(text, {})).toBe('adult');
    expect(classifySourceAdult(undefined, { bookSourceName: text })).toBe('adult');
  });

  // 同名泛词不得误伤：只收「海棠+书屋/书房/文学」这类站名组合，裸「海棠」「御宅」「PO 文学」不算。
  it.each([
    '海棠', '海棠花儿', '御宅族小说', 'PO文学3', 'PO全本🎃', '书耽中文', '夫妻小说', '桃桃书',
  ])('does not over-match near misses (adultsrc42): %s', (text) => {
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
