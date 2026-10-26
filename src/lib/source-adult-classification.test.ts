import { describe, expect, it } from 'vitest';
import { adultStationKeys, classifySourceAdult, isAdultSiteHost } from './source-adult-classification';

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

  // adult1026：生产池 2026-10-26 漏网的站名。
  it.each(['肉宅屋网🎃', 'PO文屋🎃', 'po文屋', '📂十八书屋', '辣肉文', '🎃辣肉文🎃'])(
    'recognizes adult site names found leaking on 2026-10-26: %s', (text) => {
      expect(classifySourceAdult(text, {})).toBe('adult');
    });

  // adult1026：站名正常、域名是成人站（生产池实测样本）。
  it.each([
    'https://m.rouzhaiwu.info', 'https://m.powenwu16.com', 'https://m.powenxue15.com', 'https://www.pofans.com',
    'https://www.18jinshu.com', 'https://www.yiyechunxiao.com', 'https://op-lake-rope.xoxiaoshuo-102.com',
    'https://www.shibashuwu.net', 'https://m.xyuzhaiwu7.com', 'https://www.roushuwu.com#🎃',
    'http://m.nprouwen.org/', 'https://m.yuwangshe.one,{"webView":true}',
  ])('recognizes adult domains behind ordinary names: %s', (bookSourceUrl) => {
    expect(classifySourceAdult('笔趣阁#58', { bookSourceName: '笔趣阁#58', bookSourceUrl })).toBe('adult');
    expect(isAdultSiteHost(new URL(bookSourceUrl.split(/[#,]/)[0]).hostname)).toBe(true);
  });

  // adultbl1026：站键精确黑名单（www./m. 剥净后等于黑名单站或为其子域才命中，不按子串）。
  it.each([
    'https://m.lulushu18.com', 'https://lulushu18.com', 'https://dfu7.com', 'https://www.dfu7.com/',
    'https://m.blpopo.com', 'https://api.blpopo.com', 'https://www.jubu.cc', 'https://www.m.jubu.cc',
  ])('recognizes blacklisted stations: %s', (bookSourceUrl) => {
    expect(classifySourceAdult('普通', { bookSourceUrl })).toBe('adult');
  });

  it.each(['https://m.lulushu18.com.example', 'https://xdfu7.com', 'https://jubu.cc.cn'])(
    'blacklist is exact-station only: %s', (bookSourceUrl) => {
      expect(classifySourceAdult('普通', { bookSourceUrl })).toBe('unmarked');
    });

  it.each([
    'https://www.biquge7.xyz', 'https://m.lulushuwu.com', 'https://www.xiangtxsw.com', 'https://so.ihuaben.com',
    'https://www.sjks88.com', 'https://www.wanwx.com', 'https://www.mgyqw.com', 'https://m.shubl.com',
    'https://www.jjjjxs.com', 'https://www.kxwx.org', '', 'not a url',
  ])('does not flag ordinary domains: %s', (bookSourceUrl) => {
    expect(classifySourceAdult('普通', { bookSourceUrl })).toBe('unmarked');
  });

  it('bookSourceUrl/bookSourceComment of a wrong type are ignored instead of making the row invalid', () => {
    expect(classifySourceAdult('普通', { bookSourceUrl: 1, bookSourceComment: {} })).toBe('unmarked');
  });

  it.each([
    ['同站： 新御宅屋 https://www.layuzhaiwu.xyz', 'adult'],
    ['同站https://www.larouwen .com/ https://www.example.com', 'adult'],
    ['同站 CP文库： https://www.cpwenku.com', 'unmarked'],
    ['免责声明：本源仅供学习，禁止成人内容传播', 'unmarked'],
  ] as const)('reads only the 同站 alias part of bookSourceComment: %s', (bookSourceComment, expected) => {
    expect(classifySourceAdult('耽美小说', { bookSourceComment })).toBe(expected);
  });

  it('adultStationKeys spreads one adult row to its whole station', () => {
    const rows = [
      { url: 'https://444.1006sd.com', name: '🔞猩猩小说' },
      { url: 'https://444.1006sd.com#🎃', name: '🎃猩猩小说🎃' },
      { url: 'https://m.example.com', name: '普通' },
    ];
    const keys = adultStationKeys(rows, (row) => classifySourceAdult(row.name, {}), (row) => new URL(row.url).hostname);
    expect([...keys]).toEqual(['444.1006sd.com']);
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
