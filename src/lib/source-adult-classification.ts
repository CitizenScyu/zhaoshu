import { stationKeyOfHost } from './source-policy';

export type SourceAdultClassification = 'adult' | 'unmarked' | 'invalid';

const ADULT_PHRASE = /成人(?:小说|文学|书源|内容|专区)/;
const ADULT_TOKEN = /(?:^|[\s()\[\]{}<>（）【】《》「」『』,，、|｜;；:：\/／])(?:成人|NSFW|R18|R-18|18\+|18禁)(?=$|[\s()\[\]{}<>（）【】《》「」『』,，、|｜;；:：\/／])/i;
// adultsrc42：元数据没打标但站名即成人站（生产池实测名单：肉文屋/PO18/肉肉屋/欲望社/御宅屋/御书屋/
// 海棠/桃色/7wav 等）。只收站名级专名，不收可能误伤正常源的泛词（如裸「海棠」）。
// adult1026：站名同样未打标、但站名本身是成人站名（生产池 2026-10-26 实测：肉宅屋网、PO文屋、十八书屋、辣肉文）。
const ADULT_SITE_PHRASE = /肉文屋|肉色屋|肉书屋|肉肉屋|肉宅屋|御宅屋|御书屋|新御宅|欲望社|海棠书屋|海棠书房|海棠文学|桃色小说|十八书屋|辣肉文|po文屋|po18|7wav/i;
// adult1026：站名被改成正常名（如「笔趣阁#58」「安月书屋」「PO文学🎃」）但域名仍是成人站（生产池 2026-10-26 实测）。
// 按 hostname 标签内子串匹配；只收成人站专有拼音/品牌，不收 xiaoshuo/shuwu 这类泛词。
const ADULT_HOST_TOKEN = /rouzhaiwu|yuzhaiwu|rouwen|roushuwu|powenwu|powenxue|pofans|po18|18jinshu|shibashuwu|xoxiaoshuo|yiyechunxiao|yuwangshe|haitangshuwu/i;
// adultbl1026：域名无专有拼音、靠 token 抓不到的成人站，按站键（www./m. 剥净，含子域）拉黑。2026-10-26 用户确认名单。
const ADULT_STATION_KEYS: ReadonlySet<string> = new Set(['lulushu18.com', 'dfu7.com', 'blpopo.com', 'jubu.cc']);
// bookSourceComment 里「同站：<站名/网址>」声明的是同一个站的别名：别名命中成人站名或成人域名即同判。
// 只看「同站」之后的一段，不扫整段注释（注释里常有免责声明、作者群号等无关文字）。
const SAME_SITE_NOTE = /同站[:：\s]*([^\n]{0,120})/g;

function hostOfSourceUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try { return new URL(value.trim().split(/[#,\s]/)[0]).hostname.toLowerCase(); } catch { return ''; }
}

/** 域名本身是成人站（不看元数据）。供池侧按 host 判定与测试复用。 */
export function isAdultSiteHost(hostname: string): boolean {
  return hostname !== '' && (ADULT_HOST_TOKEN.test(hostname) || onAdultStation(stationKeyOfHost(hostname)));
}

/** 站键等于黑名单站或是其子域（api.blpopo.com 命中；xdfu7.com / jubu.cc.cn 不命中）。 */
function onAdultStation(key: string): boolean {
  for (const station of ADULT_STATION_KEYS) {
    if (key === station || key.endsWith(`.${station}`)) return true;
  }
  return false;
}

function sameSiteNoteIsAdult(comment: unknown): boolean {
  if (typeof comment !== 'string') return false;
  for (const match of comment.matchAll(SAME_SITE_NOTE)) {
    const note = match[1];
    if (ADULT_SITE_PHRASE.test(note) || ADULT_HOST_TOKEN.test(note.replace(/\s+/g, ''))) return true;
  }
  return false;
}

/** Metadata markers only: unmarked is not a content-safety or source-admission verdict. */
export function classifySourceAdult(name: unknown, source: unknown): SourceAdultClassification {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return 'invalid';
  const raw = source as Record<string, unknown>;
  const values = [name, raw.bookSourceName, raw.bookSourceGroup];
  // Validate every field first, so a marker cannot hide corrupt metadata.
  if (values.some((value) => value !== undefined && value !== null && typeof value !== 'string')) return 'invalid';
  const marked = values.some((value) => typeof value === 'string'
    && (value.includes('🈲') || value.includes('🔞') || ADULT_PHRASE.test(value)
      || ADULT_TOKEN.test(value) || ADULT_SITE_PHRASE.test(value)));
  // bookSourceUrl / bookSourceComment 是辅助信号：类型不对只是不参与判定，不把整条判 invalid。
  return marked || isAdultSiteHost(hostOfSourceUrl(raw.bookSourceUrl)) || sameSiteNoteIsAdult(raw.bookSourceComment)
    ? 'adult' : 'unmarked';
}

/**
 * 同站传染（adult1026）：同一站键（www./m./apex 归一）下任一源判 adult，整站所有源都按 adult 处理。
 * 生产实例：444.1006sd.com 的「🔞猩猩小说」被滤，同 host 的「🎃猩猩小说🎃」漏网。
 * 只返回站键集合，调用方用自己的站键函数比对（与池侧同站去重同一口径）。
 */
export function adultStationKeys<T>(
  rows: readonly T[], classify: (row: T) => SourceAdultClassification, stationKey: (row: T) => string,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (classify(row) !== 'adult') continue;
    const key = stationKey(row);
    if (key !== '') keys.add(key);
  }
  return keys;
}
