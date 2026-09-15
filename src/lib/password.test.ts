import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_CODEPOINTS,
  PASSWORD_HASH_PREFIX,
  checkPasswordBounds,
  hashPassword,
  parsePasswordHash,
  runDummyKdf,
  verifyPassword,
} from './password';

// 异步 scrypt（N=2^17）单项约几百毫秒；beforeAll 共享哈希值并放宽用例超时，避免并发负载下误报。
const KDF_TEST_TIMEOUT = 20000;

const asciiPassword = 'correct horse battery staple!';
const chinesePassword = '三体 人的全部尊严在于思想';
const spacesPassword = '  leading and trailing spaces kept  ';

let asciiHash: string;
let chineseHash: string;
let spacesHash: string;

beforeAll(async () => {
  [asciiHash, chineseHash, spacesHash] = await Promise.all([
    hashPassword(asciiPassword),
    hashPassword(chinesePassword),
    hashPassword(spacesPassword),
  ]);
}, KDF_TEST_TIMEOUT);

describe('password hashing', () => {
  it('produces the documented version string with whitelisted parameters', () => {
    expect(asciiHash.startsWith(`${PASSWORD_HASH_PREFIX}131072$8$1$`)).toBe(true);
    const parts = asciiHash.split('$');
    expect(parts).toHaveLength(7);
    expect(parsePasswordHash(asciiHash)).not.toBeNull();
  });

  it('hashes and verifies ASCII, Chinese, and space-containing passwords', async () => {
    expect(await verifyPassword(asciiPassword, asciiHash)).toBe(true);
    expect(await verifyPassword(chinesePassword, chineseHash)).toBe(true);
    expect(await verifyPassword(spacesPassword, spacesHash)).toBe(true);
  }, KDF_TEST_TIMEOUT);

  it('does not trim or normalize password bytes', async () => {
    expect(await verifyPassword(spacesPassword.trim(), spacesHash)).toBe(false);
    expect(await verifyPassword(spacesPassword, spacesHash)).toBe(true);
  }, KDF_TEST_TIMEOUT);

  it('rejects a wrong password', async () => {
    expect(await verifyPassword('Correct horse battery staple!', asciiHash)).toBe(false);
    expect(await verifyPassword('', asciiHash)).toBe(false);
  }, KDF_TEST_TIMEOUT);

  it('uses a fresh random salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword(asciiPassword), hashPassword(asciiPassword)]);
    expect(a).not.toBe(b);
    expect(a.split('$')[5]).not.toBe(b.split('$')[5]);
    expect(await verifyPassword(asciiPassword, a)).toBe(true);
    expect(await verifyPassword(asciiPassword, b)).toBe(true);
  }, KDF_TEST_TIMEOUT);

  it('accepts the maximum-length password and rejects longer input', async () => {
    const longChinese = '书'.repeat(MAX_PASSWORD_CODEPOINTS);
    const longHash = await hashPassword(longChinese);
    expect(await verifyPassword(longChinese, longHash)).toBe(true);
    await expect(hashPassword('书'.repeat(MAX_PASSWORD_CODEPOINTS + 1))).rejects.toThrow('out of bounds');
  }, KDF_TEST_TIMEOUT);
});

describe('password input bounds', () => {
  it('enforces the codepoint and UTF-8 byte upper limits separately', () => {
    expect(checkPasswordBounds('书'.repeat(MAX_PASSWORD_CODEPOINTS))).toBeNull();
    expect(checkPasswordBounds('书'.repeat(MAX_PASSWORD_CODEPOINTS + 1))).toBe('TOO_LONG_CODEPOINTS');
    // 128 个码点 × 最多 4 字节 = 512 字节：码点上限内 UTF-8 上限刚好不可逾越，
    // 字节检查是防码点上限未来放宽时的纵深防御。
    expect(checkPasswordBounds('a'.repeat(128))).toBeNull();
    expect(checkPasswordBounds('😀'.repeat(128))).toBeNull();
    expect(Buffer.byteLength('😀'.repeat(128), 'utf8')).toBe(512);
  });

  it('rejects lone surrogates as invalid unicode', () => {
    expect(checkPasswordBounds('valid 密码 pass')).toBeNull();
    expect(checkPasswordBounds('bad \ud800 surrogate')).toBe('INVALID_UNICODE');
    expect(checkPasswordBounds('\udfff')).toBe('INVALID_UNICODE');
  });
});

describe('password hash parsing whitelist', () => {
  it.each([
    ['wrong algorithm', 'bcrypt$1$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['unsupported version', 'scrypt$2$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['bigger N than supported', 'scrypt$1$1048576$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['different r', 'scrypt$1$131072$16$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['different p', 'scrypt$1$131072$8$2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['too many fields', 'scrypt$1$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$extra'],
    ['too few fields', 'scrypt$1$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA'],
    ['salt not base64url', 'scrypt$1$131072$8$1$***not-base64***$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['salt wrong length', 'scrypt$1$131072$8$1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['key wrong length', 'scrypt$1$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA'],
    ['empty string', ''],
  ])('rejects malformed hash (%s)', (_label, stored) => {
    expect(parsePasswordHash(stored)).toBeNull();
  });

  it('caps the stored hash length before parsing', () => {
    expect(parsePasswordHash(`${PASSWORD_HASH_PREFIX}131072$8$1$${'A'.repeat(400)}`)).toBeNull();
  });
});

describe('verification hardening', () => {
  it('returns false instead of throwing for malformed or missing hashes', async () => {
    expect(await verifyPassword(asciiPassword, null)).toBe(false);
    expect(await verifyPassword(asciiPassword, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(asciiPassword, 'scrypt$1$999$8$1$AAAA$AAAA')).toBe(false);
  }, KDF_TEST_TIMEOUT);

  it('spends comparable time on a dummy KDF when the hash is unusable', async () => {
    const before = performance.now();
    await runDummyKdf();
    const dummyMs = performance.now() - before;

    const start = performance.now();
    await verifyPassword(asciiPassword, null);
    const rejectMs = performance.now() - start;
    expect(rejectMs).toBeGreaterThan(dummyMs * 0.25);
  }, KDF_TEST_TIMEOUT);
});
