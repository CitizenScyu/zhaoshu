// urlopt1028：URL 字段值的 legado `url,{选项}` 后缀（ENGINE_URL_OPTIONS，默认 off）。
// legado BookChapter/NetworkUtils.getAbsoluteURL 在 paramPattern `\s*,\s*(?=\{)` 处切开、只绝对化前半、选项原样接回，
// 取页时 AnalyzeUrl 再读选项（GSON 读不出则整段忽略）。引擎的章节/翻页 URL 是纯地址（取页只走 GET），所以开关开时
// 只收「去掉选项后取页语义不变」的选项：webView 当普通请求、未知键/origin/非 POST 的 method 与 body 忽略；
// 改变请求的（POST、headers、非 utf-8 charset、js/type/serverID、webView 配 webJs）与口径不定的（重复键、整数字段非整数）
// 一律不收，值原样交回 host 门（与 off 态逐字同：单引号/空白形态被门拒；双引号形态过门但选项被百分号编码进路径，取到的不是正文）。
import { gsonAsString, gsonPlainInteger, parseGsonLenient, type GsonValue } from '@/lib/gson-lenient';

/** legado AnalyzeUrl.paramPattern。 */
const URL_OPTION_SPLIT = /\s*,\s*(?=\{)/;

/** 值会被当 URL 取页、且 legado 保留选项后缀的字段。 */
export const URL_OPTION_FIELDS = [
  'ruleSearch.bookUrl', 'ruleBookInfo.tocUrl', 'ruleToc.chapterUrl', 'ruleToc.nextTocUrl', 'ruleContent.nextContentUrl',
] as const;

/** 取正文页的字段：legado 取正文时另带 ruleContent.webJs/sourceRegex 进 WebView，源里写了这两项就不收。 */
const CONTENT_STAGE_FIELDS: ReadonlySet<string> = new Set(['ruleToc.chapterUrl', 'ruleContent.nextContentUrl']);

/** 规则原文可能产出选项后缀（字面 `,{` 或 webView 键；宁宽勿漏，只多翻 revision）。 */
const URL_OPTION_HINT = /,\s*\{|webView/;

const REJECT_KEYS = ['js', 'type', 'serverID'] as const;
const INT_KEYS = ['retry', 'webViewDelayTime'] as const;

function ruleText(rules: Record<string, unknown>, group: string, key: string): string {
  const fields = rules[group];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return '';
  const value = (fields as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 该源哪些 URL 字段在开关开时剥选项（语义版本位与 compileSource 共用，纯静态，看规则原文）：
 * 字段原文像会产出选项后缀；取正文页的字段另要求源没写 ruleContent.webJs/sourceRegex。
 */
export function urlOptionFields(rules: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const contentWebView = ruleText(rules, 'ruleContent', 'webJs').trim() !== '' || ruleText(rules, 'ruleContent', 'sourceRegex').trim() !== '';
  for (const name of URL_OPTION_FIELDS) {
    const [group, key] = name.split('.');
    if (!URL_OPTION_HINT.test(ruleText(rules, group, key))) continue;
    if (contentWebView && CONTENT_STAGE_FIELDS.has(name)) continue;
    found.add(name);
  }
  return found;
}

function emptyHeaders(v: GsonValue | undefined): boolean {
  if (v === undefined || v.kind === 'null') return true;
  if (v.kind === 'object') return v.entries.size === 0;
  if (v.kind !== 'string') return false;
  if (v.value.trim() === '') return true;
  const parsed = parseGsonLenient(v.value);
  return parsed?.kind === 'object' && parsed.entries.size === 0;
}

/**
 * 剥掉值末尾的 legado 选项：无选项 → 原值；选项读不出或不是对象 → 前半（legado 整段忽略）；
 * 去掉后取页语义不变 → 前半；否则 null（调用方用原值，与 off 同）。
 */
export function urlOptionHead(value: string): string | null {
  const split = URL_OPTION_SPLIT.exec(value);
  if (!split) return value;
  const head = value.slice(0, split.index);
  const parsed = parseGsonLenient(value.slice(split.index + split[0].length));
  if (!parsed || parsed.kind !== 'object') return head;
  if (parsed.duplicate) return null;
  const field = (key: string): GsonValue | undefined => parsed.entries.get(key);
  for (const key of REJECT_KEYS) if (gsonAsString(field(key)) !== null) return null;
  for (const key of INT_KEYS) {
    const v = field(key);
    if (v === undefined || v.kind === 'null') continue;
    const ok = v.kind === 'number' ? gsonPlainInteger(v) && Math.abs(Number(v.raw)) <= 0x7fffffff
      : v.kind === 'string' && /^-?\d{1,9}$/.test(v.value);
    if (!ok) return null;
  }
  const method = gsonAsString(field('method'));
  if (method !== null && method.toUpperCase() === 'POST') return null;
  if (!emptyHeaders(field('headers'))) return null;
  const charset = gsonAsString(field('charset'));
  if (charset !== null && charset !== '' && !/^utf-?8$/i.test(charset)) return null;
  // UrlOption.useWebView：null/""/false/"false" 为假；为真时 webJs 会在页面里执行，取页结果不同。
  const webView = gsonAsString(field('webView'));
  const webJs = gsonAsString(field('webJs'));
  if (webView !== null && webView !== '' && webView !== 'false' && webJs !== null && webJs.trim() !== '') return null;
  return head;
}

/** 字段值进 host 门前的预处理：字段挂了 urlOptions 才剥（compile.ts 按 urlOptionFields 挂），否则原值。 */
export function stripUrlOptions(value: string, apply: boolean | undefined): string {
  if (!apply) return value;
  return urlOptionHead(value) ?? value;
}
