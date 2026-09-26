// 书源请求/响应字符集支持（41-postsearch）：只用运行时内建 TextDecoder/TextEncoder，不引依赖。
//
// 解码：TextDecoder 原生支持 'gbk'（gb2312 的超集）与 'gb18030'。
// 编码：TextEncoder 只能产 utf-8，故用 TextDecoder 反查建「字符 → GBK 双字节」表（惰性、一次性）。
//   书名皆 BMP 汉字，GBK 双字节区（含 gb2312 子集）足够；gb18030 的 4 字节区不建表，
//   命中不到的字符回退 UTF-8 字节（生僻字，罕见，见报告 §6 遗留）。

export type SourceCharset = 'utf-8' | 'gbk' | 'gb18030';

// TextDecoder label：gb2312 归一到 gbk（gbk 是其超集，Node 亦将 gb2312→gbk）。
const CHARSET_ALIASES: Record<string, SourceCharset> = {
  'utf-8': 'utf-8', utf8: 'utf-8',
  gbk: 'gbk', gb2312: 'gbk', 'gb-2312': 'gbk', 'x-gbk': 'gbk',
  gb18030: 'gb18030',
};

/** 归一化字符集别名；未知字符集返回 null（调用方按「不支持」处理，不猜）。 */
export function normalizeCharset(raw: unknown): SourceCharset | null {
  if (typeof raw !== 'string') return null;
  return CHARSET_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** 从 Content-Type 头解析字符集；无/未知返回 null。 */
export function charsetFromContentType(contentType: string | null): SourceCharset | null {
  if (!contentType) return null;
  const matched = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return matched ? normalizeCharset(matched[1]) : null;
}

let gbkReverse: Map<string, [number, number]> | null = null;
function gbkMap(): Map<string, [number, number]> {
  if (gbkReverse) return gbkReverse;
  const decoder = new TextDecoder('gbk', { fatal: false });
  const map = new Map<string, [number, number]>();
  const buf = new Uint8Array(2);
  for (let hi = 0x81; hi <= 0xfe; hi += 1) {
    for (let lo = 0x40; lo <= 0xfe; lo += 1) {
      if (lo === 0x7f) continue;
      buf[0] = hi; buf[1] = lo;
      const ch = decoder.decode(buf);
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo]);
    }
  }
  gbkReverse = map;
  return map;
}

// encodeURIComponent 的 unreserved 集合：字母数字与 - _ . ! ~ * ' ( )。
const UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;
const pctByte = (b: number): string => `%${b.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * 把关键词按 charset 百分号编码，供 URL 查询串 / POST body 的 {{key}} 展开使用。
 * utf-8 与 encodeURIComponent 逐字节一致；GBK/gb18030 按双字节表编码，表外字符回退 UTF-8 字节。
 */
export function encodeQueryComponent(text: string, charset: SourceCharset): string {
  if (charset === 'utf-8') return encodeURIComponent(text);
  const map = gbkMap();
  let out = '';
  for (const ch of text) {
    if (ch.length === 1 && UNRESERVED.test(ch)) { out += ch; continue; }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) { out += pctByte(code); continue; } // ASCII 保留字符：单字节
    const bytes = map.get(ch);
    if (bytes) { out += pctByte(bytes[0]) + pctByte(bytes[1]); continue; }
    for (const b of new TextEncoder().encode(ch)) out += pctByte(b); // 表外回退
  }
  return out;
}

/**
 * 把整段文本按 charset 编成字节，用于 POST body 发送。utf-8 直接走 TextEncoder；
 * GBK/gb18030 按双字节表编码（ASCII 单字节透传），表外字符回退 UTF-8 字节。
 * 表单 body（{{key}} 已是 ASCII 百分号编码）任何 charset 下字节相同；JSON body 的 CJK 才靠此得到正确字节。
 */
export function encodeToBytes(text: string, charset: SourceCharset): Uint8Array {
  if (charset === 'utf-8') return new TextEncoder().encode(text);
  const map = gbkMap();
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) { out.push(code); continue; }
    const bytes = map.get(ch);
    if (bytes) { out.push(bytes[0], bytes[1]); continue; }
    for (const b of new TextEncoder().encode(ch)) out.push(b);
  }
  return Uint8Array.from(out);
}
