export type SourceAdultClassification = 'adult' | 'unmarked' | 'invalid';

const ADULT_PHRASE = /成人(?:小说|文学|书源|内容|专区)/;
const ADULT_TOKEN = /(?:^|[\s()\[\]{}<>（）【】《》「」『』,，、|｜;；:：\/／])(?:成人|NSFW|R18|R-18|18\+|18禁)(?=$|[\s()\[\]{}<>（）【】《》「」『』,，、|｜;；:：\/／])/i;
// adultsrc42：元数据没打标但站名即成人站（生产池实测名单：肉文屋/PO18/肉肉屋/欲望社/御宅屋/御书屋/
// 海棠/桃色/7wav 等）。只收站名级专名，不收可能误伤正常源的泛词（如裸「海棠」）。
const ADULT_SITE_PHRASE = /肉文屋|肉色屋|肉书屋|肉肉屋|御宅屋|御书屋|新御宅|欲望社|海棠书屋|海棠书房|海棠文学|桃色小说|po18|7wav/i;

/** Metadata markers only: unmarked is not a content-safety or source-admission verdict. */
export function classifySourceAdult(name: unknown, source: unknown): SourceAdultClassification {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return 'invalid';
  const raw = source as Record<string, unknown>;
  const values = [name, raw.bookSourceName, raw.bookSourceGroup];
  // Validate every field first, so a marker cannot hide corrupt metadata.
  if (values.some((value) => value !== undefined && value !== null && typeof value !== 'string')) return 'invalid';
  return values.some((value) => typeof value === 'string'
    && (value.includes('🈲') || value.includes('🔞') || ADULT_PHRASE.test(value)
      || ADULT_TOKEN.test(value) || ADULT_SITE_PHRASE.test(value)))
    ? 'adult' : 'unmarked';
}
