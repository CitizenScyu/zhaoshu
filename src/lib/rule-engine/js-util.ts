// jsutil1028（ENGINE_SYNTAX_JS_UTIL）：legado `java.createSymmetricCrypto(...)`（hutool SymmetricCrypto + SymmetricCryptoAndroid）
// 与 `java.toNumChapter`（AppPattern.titleNumPattern + StringUtils.stringToInt）的宿主实现，由 js-sandbox.ts 在沙箱里包装。
// 口径不定的输入（非 UTF-8 明文、奇数长/空 hex、非规范 base64、CBC 缺 IV、Unicode 数字…）一律抛错——沙箱把宿主失败记为致命，
// 宁可整段求值失败，也不产出与 legado 不同的值。

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { engineSyntaxB64LenientEnabled } from './syntax-flags';

export type SymOp = 'decryptStr' | 'encryptBase64' | 'encryptHex';

interface SymSpec {
  cipher: string;
  key: Buffer;
  iv: Buffer | null;
  blockSize: number;
  padding: 'pkcs7' | 'zero' | 'none';
}

/** Java/Kotlin 编码孤立代理项会替换成 `?`，这里不复现。 */
function utf8Bytes(text: string, what: string): Buffer {
  if (/\p{Cs}/u.test(text)) throw new Error(`${what} 含孤立代理项`);
  return Buffer.from(text, 'utf8');
}

/**
 * transformation → Node 密码套件。只收 `AES`/`DES`/`DESede`（大小写原样，hutool KeyUtil 按 startsWith("DES") 区分密钥规格）
 * 单写或 `算法/CBC|ECB/填充`；单写按 JCE 默认 ECB/PKCS5Padding。`ZeroPadding` 是 hutool 的大小写敏感子串替换。
 * DES 取密钥前 8 字节（DESKeySpec）、DESede 前 24 字节（DESedeKeySpec）；Node 24 没有单 DES，用 K‖K‖K 的 3DES 等价实现。
 */
function symSpec(transformation: string, keyText: string, ivText: string): SymSpec {
  const parts = transformation.split('/');
  if (parts.length !== 1 && parts.length !== 3) throw new Error('transformation 形态不支持');
  const [alg, modeText = 'ECB', paddingText = 'PKCS5Padding'] = parts;
  const mode = modeText.toUpperCase();
  if (mode !== 'CBC' && mode !== 'ECB') throw new Error('只支持 CBC/ECB 模式');
  let padding: SymSpec['padding'];
  if (paddingText === 'ZeroPadding') padding = 'zero';
  else if (/^pkcs[57]padding$/i.test(paddingText)) padding = 'pkcs7';
  else if (/^nopadding$/i.test(paddingText)) padding = 'none';
  else throw new Error('填充方式不支持');
  const keyBytes = utf8Bytes(keyText, 'key');
  const ivBytes = ivText === '' ? null : utf8Bytes(ivText, 'iv');
  let cipher: string;
  let key: Buffer;
  let blockSize: number;
  if (alg === 'AES') {
    if (keyBytes.length !== 16 && keyBytes.length !== 24 && keyBytes.length !== 32) throw new Error('AES 密钥长度不对');
    cipher = `aes-${keyBytes.length * 8}-${mode.toLowerCase()}`;
    key = keyBytes;
    blockSize = 16;
  } else if (alg === 'DESede') {
    if (keyBytes.length < 24) throw new Error('DESede 密钥不足 24 字节');
    cipher = mode === 'CBC' ? 'des-ede3-cbc' : 'des-ede3';
    key = keyBytes.subarray(0, 24);
    blockSize = 8;
  } else if (alg === 'DES') {
    if (keyBytes.length < 8) throw new Error('DES 密钥不足 8 字节');
    const k = keyBytes.subarray(0, 8);
    cipher = mode === 'CBC' ? 'des-ede3-cbc' : 'des-ede3';
    key = Buffer.concat([k, k, k]);
    blockSize = 8;
  } else {
    throw new Error('只支持 AES/DES/DESede');
  }
  if (mode === 'CBC' && (ivBytes === null || ivBytes.length !== blockSize)) throw new Error('CBC 需要块长的 IV');
  if (mode === 'ECB' && ivBytes !== null) throw new Error('ECB 不收 IV');
  return { cipher, key, iv: ivBytes, blockSize, padding };
}

/**
 * SymmetricCryptoAndroid.decrypt(String)：全是 hex 字符按 hex 解，否则按 hutool Base64 解。hutool 跳过非法字符、长度另算，
 * 这里只收规范形态（标准或 URL 安全字母表、可省略的末尾 `=`），其余失败；b64lenient1030 开时改按 hutool 口径解。
 */
function decodeCipherText(data: string): Buffer {
  if (/^[0-9A-Fa-f]*$/.test(data)) {
    if (data.length === 0 || data.length % 2 !== 0) throw new Error('hex 密文为空或长度为奇数');
    return Buffer.from(data, 'hex');
  }
  if (engineSyntaxB64LenientEnabled()) return hutoolBase64Decode(data);
  const match = /^([A-Za-z0-9+/_-]+)(={0,2})$/.exec(data);
  if (!match) throw new Error('密文不是规范 base64');
  const [, body, pad] = match;
  const rem = body.length % 4;
  if (rem === 1 || (pad.length > 0 && pad.length !== (4 - rem) % 4) || (pad.length > 0 && rem === 0)) {
    throw new Error('密文不是规范 base64');
  }
  return Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

/** hutool Base64Decoder.DECODE_TABLE（0x00–0x7a）：-1 非字母表，-2 是 `=`；`+`/`-` = 62，`/`/`_` = 63。 */
const HUTOOL_B64_TABLE: readonly number[] = (() => {
  const table = new Array<number>(0x7b).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  table[0x2b] = 62; table[0x2d] = 62; table[0x2f] = 63; table[0x5f] = 63; table[0x3d] = -2;
  return table;
})();
const HUTOOL_PADDING = -2;

/**
 * b64lenient1030：hutool Base64Decoder.decode 逐字移植——串按 UTF-8 取字节逐个查表，非字母表字节（含 `=` 与非 ASCII）跳过，
 * 读到尾补 PADDING；每 4 个值一组，第 2/3/4 个是 PADDING 时不出对应字节。表只到 `z`：`{|}~` 与 DEL 在 hutool 里数组越界抛错，
 * 这里同样失败。
 */
function hutoolBase64Decode(data: string): Buffer {
  const bytes = Buffer.from(data, 'utf8');
  let pos = 0;
  const next = (): number => {
    while (pos < bytes.length) {
      const byte = bytes[pos++];
      if (byte > 0x7f) continue; // Java byte 为负
      if (byte >= HUTOOL_B64_TABLE.length) throw new Error('密文含 hutool 解码表外的字符');
      const value = HUTOOL_B64_TABLE[byte];
      if (value > -1) return value;
    }
    return HUTOOL_PADDING;
  };
  const out: number[] = [];
  while (pos < bytes.length) {
    const s0 = next();
    const s1 = next();
    const s2 = next();
    const s3 = next();
    if (s1 !== HUTOOL_PADDING) out.push(((s0 << 2) | (s1 >>> 4)) & 0xff);
    if (s2 !== HUTOOL_PADDING) out.push((((s1 & 0xf) << 4) | (s2 >>> 2)) & 0xff);
    if (s3 !== HUTOOL_PADDING) out.push((((s2 & 3) << 6) | s3) & 0xff);
  }
  return Buffer.from(out);
}

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * `createSymmetricCrypto(t, key, iv).<op>(data)`：key/iv 按 UTF-8 取字节，iv 为空串 = 不设 IV（legado `iv.isNotEmpty()`）。
 * `check` 只校验规格（createSymmetricCrypto 时调用）。decryptStr 按 UTF-8 严格解码；encryptBase64 = 标准带填充不换行，
 * encryptHex = 小写。ZeroPadding：加密补零到块长（空明文不补），解密在块长整数倍时剥尾部 0x00。
 */
export function symmetricCrypt(op: SymOp | 'check', transformation: string, key: string, iv: string, data: string): string {
  const spec = symSpec(transformation, key, iv);
  if (op === 'check') return '';
  if (op === 'decryptStr') {
    const decipher = createDecipheriv(spec.cipher, spec.key, spec.iv);
    decipher.setAutoPadding(spec.padding === 'pkcs7');
    let plain = Buffer.concat([decipher.update(decodeCipherText(data)), decipher.final()]);
    if (spec.padding === 'zero' && plain.length % spec.blockSize === 0) {
      let end = plain.length;
      while (end > 0 && plain[end - 1] === 0) end -= 1;
      plain = plain.subarray(0, end);
    }
    return UTF8_FATAL.decode(plain);
  }
  let plain = utf8Bytes(data, 'data');
  if (spec.padding === 'zero' && plain.length % spec.blockSize !== 0) {
    plain = Buffer.concat([plain, Buffer.alloc(spec.blockSize - (plain.length % spec.blockSize))]);
  }
  const cipher = createCipheriv(spec.cipher, spec.key, spec.iv);
  cipher.setAutoPadding(spec.padding === 'pkcs7');
  const out = Buffer.concat([cipher.update(plain), cipher.final()]);
  return op === 'encryptHex' ? out.toString('hex') : out.toString('base64');
}

// ---------------------------------------------------------------- toNumChapter

const CHN_MAP: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  [...'零一二三四五六七八九十'].forEach((ch, i) => map.set(ch, i));
  [...'〇壹贰叁肆伍陆柒捌玖拾'].forEach((ch, i) => map.set(ch, i));
  map.set('两', 2);
  map.set('百', 100);
  map.set('佰', 100);
  map.set('千', 1000);
  map.set('仟', 1000);
  map.set('万', 10000);
  map.set('亿', 100000000);
  return map;
})();

/** StringUtils.chineseNumToInt（Kotlin Int 溢出回绕；未知字符 = -1）。「一零二五」分支的正则只匹配单字，永不命中，不复现。 */
function chineseNumToInt(cn: string): number {
  let result = 0;
  let tmp = 0;
  let billion = 0;
  for (let i = 0; i < cn.length; i += 1) {
    const tmpNum = CHN_MAP.get(cn[i]);
    if (tmpNum === undefined) return -1;
    if (tmpNum === 100000000) {
      result = Math.imul((result + tmp) | 0, tmpNum);
      billion = (Math.imul(billion, 100000000) + result) | 0;
      result = 0;
      tmp = 0;
    } else if (tmpNum === 10000) {
      result = Math.imul((result + tmp) | 0, tmpNum);
      tmp = 0;
    } else if (tmpNum >= 10) {
      if (tmp === 0) tmp = 1;
      result = (result + Math.imul(tmpNum, tmp)) | 0;
      tmp = 0;
    } else {
      const prev = i >= 2 && i === cn.length - 1 ? CHN_MAP.get(cn[i - 1])! : 0;
      tmp = prev > 10 ? Math.trunc((tmpNum * prev) / 10) : (Math.imul(tmp, 10) + tmpNum) | 0;
    }
  }
  return (result + tmp + billion) | 0;
}

/** StringUtils.stringToInt：全角转半角、去 `\s`，Integer.parseInt 不成再按中文数字。Integer.parseInt 认的非 ASCII 数字不复现。 */
export function stringToInt(text: string): number {
  let half = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    half += code === 12288 ? ' ' : code >= 65281 && code <= 65374 ? String.fromCharCode(code - 65248) : text[i];
  }
  const num = half.replace(/[ \t\n\x0B\f\r]+/g, '');
  if (/^[+-]?[0-9]+$/.test(num)) {
    const value = Number(num);
    if (value >= -2147483648 && value <= 2147483647) return value;
  } else if (/^[+-]?\p{Nd}+$/u.test(num)) {
    throw new Error('toNumChapter 不复现非 ASCII 数字');
  }
  return chineseNumToInt(num);
}

/** JsExtensions.toNumChapter：首个 `第(.+?)章`（Java `.` 不含行终止符）换成 `第N章`，其余文本丢弃；无匹配原样返回。 */
export function toNumChapter(text: string): string {
  const match = /第((?:(?!\x85).)+?)章/.exec(text);
  return match ? `第${stringToInt(match[1])}章` : text;
}
