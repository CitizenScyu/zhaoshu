// 引擎源正文的 HTML→纯文本（41-HTMLFIX）。
//
// 只用于正文层（engineFetchContent 的 ruleContent.content 产出），不改变 evaluateText 的
// `@html` 语义——简介等其它字段的 @html 仍返回原始 HTML。对齐 Legado 正文格式化（HtmlFormatter）
// 的段落语义：块级标签转段落换行、script/style 连内容删除、实体解码、纯文本恒等。
//
// 纯文本恒等靠「疑似 HTML」检测：只有出现真实标签（`<` 后紧跟字母或 `/`+字母）才转换；
// 正文里合法出现的 `<`（如「1<2」）不成标签，整段原样返回，逐字节不变。

// 块级/换行标签：闭合处转段落换行。覆盖 Legado HtmlFormatter 的块级集合。
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'tr', 'blockquote', 'pre', 'section', 'article', 'header', 'footer',
  'ul', 'ol', 'table', 'hr', 'dl', 'dt', 'dd',
]);

/** 是否含真实标签（`<` 后紧跟标签名起始）。纯文本（含「1<2」）为 false。 */
function looksLikeHtml(text: string): boolean {
  return /<[a-zA-Z/!]/.test(text);
}

/** HTML 实体解码：命名实体（正文常见集）+ 十进制/十六进制数字实体。 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  };
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return body.toLowerCase() in named ? named[body.toLowerCase()] : whole;
  });
}

/**
 * 把正文 HTML 转成纯文本。对不含真实标签的输入（含「1<2」这类裸 `<`）逐字节恒等。
 * 段落约定与仓内正文一致：块级标签闭合处换行，段落之间单换行分隔（MULTI_JOIN 口径）。
 */
export function contentHtmlToText(html: string): string {
  if (!looksLikeHtml(html)) return html;
  let text = html;
  // script/style 连同内容整段删除（大小写不敏感，允许标签属性）。
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // 块级标签（开/闭/自闭合）→ 段落换行。
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (whole, name: string) => (
    BLOCK_TAGS.has(name.toLowerCase()) ? '\n' : ''
  ));
  // 其余标签只剥标签、保留文字（含注释）。
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  // 行内半角空白收尾（半角空格/制表/U+00A0）；行首全角缩进「　　」(U+3000) 原样保留。
  // 连续空行压成一个；只修整整体尾部——行首缩进（含首行全是缩进的段落）必须保留。
  const HALF_WIDTH_EDGE = /^[ \t ]+|[ \t ]+$/g;
  const lines = text.split('\n').map((line) => line.replace(HALF_WIDTH_EDGE, ''));
  return lines.join('\n').replace(/\n{2,}/g, '\n').replace(/\n+$/g, '').replace(/^\n+/g, '');
}
