import { load } from 'cheerio';
import { charsetFromContentType, normalizeCharset, type SourceCharset } from './source-charset';

export const SOURCE_HTML_CHARSET_BYTES = 1024;

/** 只检查前1024字节中真实head里的完整meta；省略head、片段、未知编码保持原回退。 */
export function charsetFromHtmlPrefix(bytes: Uint8Array): SourceCharset | null {
  // 支持的三种编码均兼容ASCII标记；一字节映射一字符以保持原位置，不预先解码正文。
  const prefix = String.fromCharCode(...bytes.subarray(0, SOURCE_HTML_CHARSET_BYTES));
  const $ = load(prefix, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const head = $('html > head').first();
  const location = head[0]?.sourceCodeLocation;
  if (!location?.startTag) return null;
  const headEnd = location.endTag?.startOffset ?? prefix.length;
  for (const meta of head.children('meta').toArray()) {
    const tag = meta.sourceCodeLocation?.startTag;
    // parse5可能把</head>后的meta移回head，必须同时验证原文边界。
    if (!tag || tag.startOffset < location.startTag.endOffset || tag.endOffset > headEnd ||
        tag.endOffset > prefix.length || prefix[tag.endOffset - 1] !== '>') continue;
    const charset = normalizeCharset(meta.attribs.charset) ?? (
      meta.attribs['http-equiv']?.trim().toLowerCase() === 'content-type'
        ? charsetFromContentType(meta.attribs.content ?? null) : null
    );
    if (charset) return charset;
  }
  return null;
}
