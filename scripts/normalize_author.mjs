import { decodeHTML, decodeHTMLStrict } from 'entities';

// 仅 book15.net 的旧 HTML 元数据已核实。普通文本不依赖来源。
// JSONL 可显式声明 author_encoding: "html-v1" / "text-v1"；
// 未来采集端完成解码后必须使用 text-v1，导入器不再解释其中的实体。
// 导出给 import_labels.mjs 的护栏用：这是导入器唯一会做实体解码的来源，
// 护栏判「非不动点行」时必须按它归一，不能依赖既有行自己存的 source_site。
export const HTML_SOURCE = 'book15.net';
const ENCODINGS = new Set(['html-v1', 'text-v1']);
const ENTITY_CANDIDATE = /&(?:#[^&;\s]*;?|[A-Za-z][^&;\s]*;|[A-Za-z][A-Za-z0-9]*)/g;

function invalidCodePoint(point) {
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ||
    (point >= 0xd800 && point <= 0xdfff) || point > 0x10ffff ||
    (point >= 0xfdd0 && point <= 0xfdef) || (point & 0xffff) >= 0xfffe;
}

function invalidCharacters(value) {
  // 按码点遍历：合法 emoji 的代理对不算孤立代理项。
  return [...value].some((char) => invalidCodePoint(char.codePointAt(0)));
}

function inspectEntities(value) {
  let found = false;
  for (const [entity] of value.matchAll(ENTITY_CANDIDATE)) {
    if (entity.startsWith('&#')) {
      found = true;
      if (!entity.endsWith(';')) return { found, issue: 'missing-semicolon' };
      if (!/^&#(?:[0-9]+|[xX][0-9a-fA-F]+);$/.test(entity)) {
        return { found, issue: 'invalid-numeric-entity' };
      }
      const hex = /^&#[xX]/.test(entity);
      const point = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      // HTML 解码器会把无效数值替换为 �、或将 C1 控制符映射为其他字符；
      // 在解码前拒绝这类身份不确定的转换，不能让替换掩盖原始错误。
      if (!Number.isSafeInteger(point) || invalidCodePoint(point) || point === 0xfffd) {
        return { found, issue: 'invalid-numeric-entity' };
      }
    } else if (entity.endsWith(';')) {
      found = true;
      if (decodeHTMLStrict(entity) === entity) return { found, issue: 'unknown-entity' };
    } else if (decodeHTMLStrict(entity + ';') !== entity + ';' || decodeHTML(entity) !== entity) {
      // 宽松解码仅用于发现缺分号的旧式前缀（如 &middotHoffer），
      // 不把它的结果用作作者值。
      return { found: true, issue: 'missing-semicolon' };
    }
    // AT&T / A&B 等不构成已知实体的普通 & 不作推测性处理。
  }
  return { found, issue: null };
}

const REVIEW_REASONS = {
  'unknown-encoding': '作者编码标记未知，保留原值待核验',
  'unknown-entity': '作者含未知 HTML 实体，保留原值待核验',
  'missing-semicolon': '作者疑似 HTML 实体缺少分号，保留原值待核验',
  'invalid-numeric-entity': '作者含非法数值实体或解码错误，保留原值待核验',
  'unconfirmed-source': '作者实体的 HTML 来源未确认，保留原值待核验',
  'multiple-encoding': '作者疑似多层 HTML 编码，保留原值待核验',
  'invalid-characters': '作者含非法控制符、NUL、孤立代理项或非法 Unicode，保留原值待核验',
  'empty-author': '作者为空或纯空白，自动导入无法判定身份（可能与存量非空作者行重复），保留原值待核验',
};

// ready 的 value 才能用于身份键；review/failed 的 value 始终为原输入。
export function normalizeAuthor(value, { sourceSite, encoding } = {}) {
  const review = (reasonCode) => ({
    status: 'review', value, reasonCode, reason: REVIEW_REASONS[reasonCode],
  });
  if (typeof value !== 'string') {
    return { status: 'failed', value, reasonCode: 'invalid-type', reason: 'author 必须是字符串' };
  }
  if (encoding != null && !ENCODINGS.has(encoding)) return review('unknown-encoding');
  if (invalidCharacters(value)) return review('invalid-characters');

  let decoded = value;
  if (encoding !== 'text-v1') {
    const inspection = inspectEntities(value);
    if (inspection.issue) return review(inspection.issue);
    if (inspection.found) {
      if (typeof sourceSite !== 'string' || sourceSite.trim().toLowerCase() !== HTML_SOURCE) {
        return review('unconfirmed-source');
      }
      decoded = decodeHTMLStrict(value);
      // 只解码一层。即使第二层未知或缺分号，也不能自动接受中间结果。
      if (inspectEntities(decoded).found) return review('multiple-encoding');
    }
  }
  // 必须在 trim 之前检查；例如 &Tab; 不能被 trim 静默清除。
  if (invalidCharacters(decoded)) return review('invalid-characters');
  const normalized = decoded.trim();
  // 空作者（含纯空白 / 全角空格 　 / 实体解码后只剩空白）不能自动导入：
  // 身份键是 (title_key, author_key)，author_key='' 与存量同一本书的非空作者行
  // **不冲突** → ON CONFLICT 不触发 → 凭空插入第二行。与 import_one.py 的
  // normalize_author 同归为 review，保留原值交给完整导入器/人工补作者。
  if (!normalized) return review('empty-author');
  if ([...normalized].length > 200) {
    return { status: 'failed', value, reasonCode: 'too-long', reason: '作者超过 200 字（Unicode 码点）' };
  }
  return { status: 'ready', value: normalized, changed: normalized !== value };
}
