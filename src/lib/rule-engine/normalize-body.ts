// 输入归一化（设计 v3 §3.1）：判定响应是 JSON 还是 HTML，并处理引擎侧包装。
// 两个引擎侧包装里的 gzip 由运行时 fetch（undici）自动解压，无需代码；
// 本文件只负责 `inte_base64:` 前缀解一层（新笔趣阁2 实测的正文包裹形态）。

/** 新笔趣阁2 一类的正文包裹前缀：`inte_base64:<base64>`。 */
export const INTE_BASE64_PREFIX = 'inte_base64:';

/** 解一层 base64 后的最大字节数（2MB，与 source-fetch 的响应上限同量级，防解压炸弹）。 */
export const MAX_DECODED_BYTES = 2 * 1024 * 1024;

export type NormalizedBody =
  | { kind: 'html'; text: string }
  | { kind: 'json'; text: string; json: unknown };

/**
 * 归一化一段响应体：
 * 1) `inte_base64:` 前缀 → 本地解一层 base64（失败则保持原文）；
 * 2) content-type 含 json，或文本 lstrip 以 `{`/`[` 开头且 JSON.parse 成功 → JSON 输入；
 * 3) 否则 HTML 输入（cheerio.load）。
 */
export function normalizeBody(input: string, contentType?: string): NormalizedBody {
  const text = typeof input === 'string' ? input : '';
  const decoded = text.startsWith(INTE_BASE64_PREFIX) ? decodeBase64Layer(text.slice(INTE_BASE64_PREFIX.length)) : text;
  const lstrip = decoded.replace(/^[\s﻿]+/u, '');
  const declaredJson = typeof contentType === 'string' && /json/i.test(contentType);
  if (declaredJson || lstrip.startsWith('{') || lstrip.startsWith('[')) {
    const parsed = tryParseJson(lstrip);
    if (parsed.ok) return { kind: 'json', text: decoded, json: parsed.value };
  }
  return { kind: 'html', text: decoded };
}

/** `inte_base64:` 一层解包。解不出（非法 base64 / 超限）→ 返回原文，交给上层按 HTML 处理。 */
export function decodeBase64Layer(payload: string): string {
  const compact = payload.replace(/\s+/gu, '');
  if (compact === '') return payload;
  // 先按长度粗筛，避免为大体积输入分配解码缓冲。
  if (Math.floor((compact.length * 3) / 4) > MAX_DECODED_BYTES) return payload;
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (decoded === '') return payload;
    return decoded;
  } catch {
    return payload;
  }
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
