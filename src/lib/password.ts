import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

// 设计 §1.2：OWASP 推荐的 scrypt 参数；显式给出内存上限，不使用 Node 默认 32 MiB。
export const SCRYPT_PARAMS = {
  N: 131072,
  r: 8,
  p: 1,
  saltBytes: 16,
  keyBytes: 32,
  maxmem: 256 * 1024 * 1024,
} as const;

export const PASSWORD_HASH_PREFIX = 'scrypt$1$';

// 新账户密码边界（设计 §4.1）：15–128 个 Unicode 码点、UTF-8 最多 512 字节。
// 下限属于注册规则（A07 落地）；本模块只统一上界与编码合法性。
export const MIN_PASSWORD_CODEPOINTS = 15;
export const MAX_PASSWORD_CODEPOINTS = 128;
export const MAX_PASSWORD_UTF8_BYTES = 512;

export type PasswordBoundError = 'TOO_LONG_CODEPOINTS' | 'TOO_LONG_UTF8' | 'INVALID_UNICODE';

export function checkPasswordBounds(password: string): PasswordBoundError | null {
  if ([...password].length > MAX_PASSWORD_CODEPOINTS) return 'TOO_LONG_CODEPOINTS';
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_UTF8_BYTES) return 'TOO_LONG_UTF8';
  if (hasLoneSurrogate(password)) return 'INVALID_UNICODE';
  return null;
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function scryptAsync(password: string, salt: Buffer, keyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_PARAMS.maxmem }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

// 解析器只接受已支持的白名单组合，不能按库里的任意巨大参数分配内存。
export type ParsedPasswordHash = { salt: Buffer; key: Buffer };

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  if (typeof stored !== 'string' || stored.length > 256) return null;
  const parts = stored.split('$');
  if (parts.length !== 7) return null;
  const [algorithm, version, n, r, p, saltText, keyText] = parts;
  if (algorithm !== 'scrypt' || version !== '1') return null;
  if (n !== String(SCRYPT_PARAMS.N) || r !== String(SCRYPT_PARAMS.r) || p !== String(SCRYPT_PARAMS.p)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(saltText) || !/^[A-Za-z0-9_-]+$/.test(keyText)) return null;
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  if (salt.length !== SCRYPT_PARAMS.saltBytes || key.length !== SCRYPT_PARAMS.keyBytes) return null;
  return { salt, key };
}

export async function hashPassword(password: string): Promise<string> {
  const boundsError = checkPasswordBounds(password);
  if (boundsError) throw new Error(`password out of bounds: ${boundsError}`);
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const key = await scryptAsync(password, salt, SCRYPT_PARAMS.keyBytes);
  return [
    'scrypt',
    '1',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

// 错误密码、畸形哈希与边界外输入都执行一次 dummy KDF 再返回 false，避免时序差异。
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (typeof password !== 'string' || checkPasswordBounds(password)) {
    await runDummyKdf();
    return false;
  }
  const parsed = typeof stored === 'string' ? parsePasswordHash(stored) : null;
  if (!parsed) {
    await runDummyKdf();
    return false;
  }
  const key = await scryptAsync(password, parsed.salt, SCRYPT_PARAMS.keyBytes);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

const DUMMY_SALT = createHash('sha256').update('novel-finder-dummy-salt-v1').digest().subarray(0, SCRYPT_PARAMS.saltBytes);

export async function runDummyKdf(): Promise<void> {
  await scryptAsync('novel-finder-dummy-password-v1', DUMMY_SALT, SCRYPT_PARAMS.keyBytes);
}
