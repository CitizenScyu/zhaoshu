// b64lenient1030：ENGINE_SYNTAX_B64_LENIENT —— 对称解密的非 hex 密文按 hutool Base64Decoder 口径解（非字母表字节跳过）。
// 密钥/明文均为合成值；期望密文用 node:crypto 直接算。
import { createCipheriv } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScope, evaluateField, normalizeBody } from './evaluate';
import { preloadJsSandbox } from './js-sandbox';
import { symmetricCrypt } from './js-util';
import { parseFieldRule } from './parse';
import { engineSyntaxB64LenientEnabled } from './syntax-flags';

const KEY16 = '0123456789abcdef';
const IV16 = 'fedcba9876543210';
const PLAIN = '第一章 正文 synthetic ' + 'x'.repeat(10); // 37 字节 → 48 字节密文 → 64 字符、无 `=`
const cipher = (() => {
  const c = createCipheriv('aes-128-cbc', Buffer.from(KEY16), Buffer.from(IV16));
  return Buffer.concat([c.update(Buffer.from(PLAIN)), c.final()]).toString('base64');
})();
const decrypt = (data: string) => symmetricCrypt('decryptStr', 'AES/CBC/PKCS5Padding', KEY16, IV16, data);
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
// 每隔 5 个字符插一个 JS 转义用的反斜杠、每 20 个字符折一行：hutool 都跳过。
const mangled = cipher.replace(/(.{5})/g, '$1\\').replace(/(.{20})/g, '$1\n');

afterEach(() => vi.unstubAllEnvs());

describe('开关', () => {
  it('engineSyntaxB64LenientEnabled 严格口径', () => {
    expect(engineSyntaxB64LenientEnabled({})).toBe(false);
    expect(engineSyntaxB64LenientEnabled({ ENGINE_SYNTAX_B64_LENIENT: '0' })).toBe(false);
    expect(engineSyntaxB64LenientEnabled({ ENGINE_SYNTAX_B64_LENIENT: 'yes' })).toBe(false);
    expect(engineSyntaxB64LenientEnabled({ ENGINE_SYNTAX_B64_LENIENT: ' On ' })).toBe(true);
    expect(engineSyntaxB64LenientEnabled({ ENGINE_SYNTAX_B64_LENIENT: 'true' })).toBe(true);
  });
});

describe('hutool 口径', () => {
  it('规范 base64 两态相同', () => {
    expect(decrypt(cipher)).toBe(PLAIN);
    vi.stubEnv('ENGINE_SYNTAX_B64_LENIENT', '1');
    expect(decrypt(cipher)).toBe(PLAIN);
    expect(decrypt(Buffer.from(cipher, 'base64').toString('base64url'))).toBe(PLAIN);
  });

  it('非字母表字节（\\、换行、空格、中间的 =、非 ASCII）on 跳过、off 失败', () => {
    const variants = [
      mangled, ` ${cipher}\r\n`, cipher.replace(/^(.{8})/, '$1=='), cipher.replace(/^(.{8})/, '$1中'),
      `${cipher}=`, `${cipher}====`, `${cipher}A`,
    ];
    for (const data of variants) expect(throws(() => decrypt(data))).toBe(true);
    vi.stubEnv('ENGINE_SYNTAX_B64_LENIENT', '1');
    for (const data of variants) expect(decrypt(data)).toBe(PLAIN);
  });

  it('hutool 表外的 {|}~ 与 DEL 照旧失败', () => {
    expect(cipher).toMatch(/^[A-Za-z0-9+/]{64}$/);
    vi.stubEnv('ENGINE_SYNTAX_B64_LENIENT', '1');
    for (const bad of [`${cipher}{`, `|${cipher}`, `${cipher}~`, `${cipher}\u007f`]) expect(throws(() => decrypt(bad))).toBe(true);
  });

  it('全 hex 字符仍按 hex（空串、奇数长失败）', () => {
    vi.stubEnv('ENGINE_SYNTAX_B64_LENIENT', '1');
    expect(throws(() => decrypt(''))).toBe(true);
    expect(throws(() => decrypt('abc'))).toBe(true);
  });
});

describe('求值', () => {
  it('正文 JS 从页面字面量取 `\\/` 转义的密文：on 解出，off 求值失败', async () => {
    await preloadJsSandbox();
    const escaped = cipher.replaceAll('/', '\\/').replace(/^(.{6})/, '$1\\'); // 另插一个孤立反斜杠，保证 off 必失败
    const page = `<html><body><script>d("${escaped}", "k")</script></body></html>`;
    const rule = `<js>var m = src.match(/d\\("([^"]+)",\\s*"([^"]+)"\\)/); java.aesBase64DecodeToString(m[1], "${KEY16}", "AES/CBC/PKCS5Padding", "${IV16}")</js>`;
    const field = parseFieldRule(rule, { field: 'ruleContent.content', jsEnabled: true, jsUtilEnabled: true });
    const scope = () => createScope(normalizeBody(page), 'https://b64.test/c/1.html');
    expect(throws(() => evaluateField(field, scope()))).toBe(true);
    vi.stubEnv('ENGINE_SYNTAX_B64_LENIENT', '1');
    expect(evaluateField(field, scope())).toContain('synthetic xxxxxxxxxx');
  });
});
