// book1028（ENGINE_SYNTAX_BOOK_FIELDS）：legado `book` 书籍成员的取值口径，api.ts 门面与 admission.ts 影子腿共用。
import type { FieldIr } from './types';
import { stripUrlOptions } from './url-options';

/**
 * 本书已求出的书籍成员：legado `book` 上的 name/author（formatBookName/formatBookAuthor 之后）、bookUrl、tocUrl。成员缺 = 该值与
 * legado 可能不同（如 URL 带选项后缀），读它的字段求值失败。已知差异：bookUrl/tocUrl 经绝对化与 host 门，写死 `http://` 的已升
 * https（legado 保留原 scheme）。
 */
export type BookView = Readonly<Partial<Record<'name' | 'author' | 'bookUrl' | 'tocUrl', string>>>;

// legado AppPattern.nameRegex / authorRegex（BookHelp.formatBookName/formatBookAuthor）。Java `\s` 只含 ASCII 空白、
// `.` 不匹配 \n \r \u0085 \u2028 \u2029，这里写成显式字符类；无 MULTILINE，`^` 只锚整串开头。
const BOOK_NAME_REGEX = /[ \t\n\x0B\f\r]+作[ \t\n\x0B\f\r]*者[^\n\r\u0085\u2028\u2029]*|[ \t\n\x0B\f\r]+[^ \t\n\x0B\f\r]+[ \t\n\x0B\f\r]+著/g;
const BOOK_AUTHOR_REGEX = /^[ \t\n\x0B\f\r]*作[ \t\n\x0B\f\r]*者[:： \t\n\x0B\f\r]+|[ \t\n\x0B\f\r]+著/g;

/** Kotlin `trim { it <= ' ' }`：两端去掉码点 ≤ U+0020 的字符（不同于 JS trim 的 Unicode 空白）。 */
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** legado BookHelp.formatBookName：去掉「 作者…」「 某某 著」尾巴后两端去空白。 */
export function formatBookName(name: string): string {
  return javaTrim(name.replace(BOOK_NAME_REGEX, ''));
}

/** legado BookHelp.formatBookAuthor：去掉「作者：」前缀与「 著」后两端去空白。 */
export function formatBookAuthor(author: string): string {
  return javaTrim(author.replace(BOOK_AUTHOR_REGEX, ''));
}

/**
 * URL 字段值进书籍成员：legado 存的是 getString(isUrl=true) 的绝对地址原样（带 `,{选项}` 后缀）。剥过选项后缀的值与之不同，
 * 不进成员（读它的字段求值失败）。`resolved` = 调用方绝对化并过门后的地址，过不了门传 undefined。
 */
export function bookUrlMember(raw: string, resolved: string | undefined, ir: FieldIr | undefined): string | undefined {
  return resolved !== undefined && stripUrlOptions(raw, ir?.urlOptions) === raw ? resolved : undefined;
}

/** 只留非空成员（空串在 Rhino 里也是 truthy 的 Java String，求值门对空串一律失败，这里不放进去）。 */
export function bookView(members: Record<string, string | undefined>): BookView {
  const view: Record<string, string> = {};
  for (const [key, value] of Object.entries(members)) if (value) view[key] = value;
  return view;
}
