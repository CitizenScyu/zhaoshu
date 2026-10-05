export type SourceAdultClassification = 'adult' | 'unmarked' | 'invalid';

const ADULT_PHRASE = /成人(?:小说|文学|书源|内容|专区)/;
const ADULT_TOKEN = /(?:^|[\s()\[\]{}<>（）【】《》「」『』,，、|｜;；:：\/／])(?:成人|NSFW|R18|R-18|18\+|18禁)(?=$|[\s()\[\]{}<>（）【】《》「」『』,，、|｜;；:：\/／])/i;

/** Metadata markers only: unmarked is not a content-safety or source-admission verdict. */
export function classifySourceAdult(name: unknown, source: unknown): SourceAdultClassification {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return 'invalid';
  const raw = source as Record<string, unknown>;
  const values = [name, raw.bookSourceName, raw.bookSourceGroup];
  // Validate every field first, so a marker cannot hide corrupt metadata.
  if (values.some((value) => value !== undefined && value !== null && typeof value !== 'string')) return 'invalid';
  return values.some((value) => typeof value === 'string'
    && (value.includes('🈲') || value.includes('🔞') || ADULT_PHRASE.test(value) || ADULT_TOKEN.test(value)))
    ? 'adult' : 'unmarked';
}
