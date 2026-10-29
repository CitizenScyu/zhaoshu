import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admissionErrorCauseEnabled, applyFailCountPrefix, errorCauseCode, parseFailCount, searchAdmission,
  type AdmissionTransport,
} from './admission';
import type { RawSource } from './compile-smoke';

// errcause1030：conn_fail 的 error 文本附 undici cause 链上的错误码；只改文本尾部，verdict/计数前缀不变。
const host = 'down.example.com';
const source: RawSource = {
  bookSourceUrl: `https://${host}/`, bookSourceName: '断网源',
  searchUrl: `https://${host}/s?q={{key}}`, checkKeyWord: '剑来',
  ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
  ruleContent: { content: '.c' },
};
const failed = (cause?: unknown) => new TypeError('fetch failed', cause === undefined ? undefined : { cause });
const codeError = (code: string, message = 'secret detail https://x.example/?token=1') => Object.assign(new Error(message), { code });
const probe = (error: unknown) => searchAdmission(source, {
  fetchPage: vi.fn<AdmissionTransport>().mockRejectedValue(error),
  declaredHosts: new Set([host]), signal: new AbortController().signal, throttleMs: 0,
});

afterEach(() => { delete process.env.ENGINE_ADMISSION_ERROR_CAUSE; });

describe('errcause1030 errorCauseCode', () => {
  it('取 cause 链上首个错误码，不取 message', () => {
    expect(errorCauseCode(failed(codeError('ENOTFOUND')))).toBe('ENOTFOUND');
    expect(errorCauseCode(failed(codeError('UND_ERR_CONNECT_TIMEOUT')))).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(errorCauseCode(failed(Object.assign(new Error('wrap'), { cause: codeError('CERT_HAS_EXPIRED') })))).toBe('CERT_HAS_EXPIRED');
    expect(errorCauseCode(failed(codeError('ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE')))).toBe('ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE');
  });

  it('AggregateError（多地址连接失败）取 errors 里首个码', () => {
    const aggregate = new AggregateError([codeError('ECONNREFUSED'), codeError('ETIMEDOUT')], 'all failed');
    expect(errorCauseCode(failed(aggregate))).toBe('ECONNREFUSED');
  });

  it('无 cause / 码形不合 / 非 Error → undefined', () => {
    expect(errorCauseCode(failed())).toBeUndefined();
    expect(errorCauseCode(failed(new Error('other side closed')))).toBeUndefined();
    expect(errorCauseCode(failed(codeError('not a code')))).toBeUndefined();
    expect(errorCauseCode(failed({ code: 42 }))).toBeUndefined();
    expect(errorCauseCode('fetch failed')).toBeUndefined();
  });

  it('开关只认 1/true', () => {
    const env = (value?: string) => ({ ENGINE_ADMISSION_ERROR_CAUSE: value }) as unknown as NodeJS.ProcessEnv;
    expect(admissionErrorCauseEnabled(env())).toBe(false);
    expect(admissionErrorCauseEnabled(env('0'))).toBe(false);
    expect(admissionErrorCauseEnabled(env('1'))).toBe(true);
    expect(admissionErrorCauseEnabled(env('true'))).toBe(true);
  });
});

describe('errcause1030 searchAdmission conn_fail 文本', () => {
  it('关：逐字 fetch failed', async () => {
    const result = await probe(failed(codeError('ECONNRESET')));
    expect(result).toMatchObject({ verdict: 'conn_fail', error: 'fetch failed' });
  });

  it('开：附错误码，verdict 不变，cause message 不入文本', async () => {
    process.env.ENGINE_ADMISSION_ERROR_CAUSE = '1';
    const result = await probe(failed(codeError('ECONNRESET')));
    expect(result).toMatchObject({ verdict: 'conn_fail', error: 'fetch failed (ECONNRESET)' });
    expect(result.error).not.toContain('token');
  });

  it('开：无 cause 的错误与超时逐字不变', async () => {
    process.env.ENGINE_ADMISSION_ERROR_CAUSE = '1';
    expect((await probe(failed())).error).toBe('fetch failed');
    const timeout = await probe(new DOMException('准入探测超时', 'TimeoutError'));
    expect(timeout).toMatchObject({ verdict: 'conn_fail', error: '准入探测超时' });
  });

  it('失败计数前缀照常叠加、照常解析', () => {
    const previous = { search_ok: false, rules_hash: 'h', error: 'fail_count:2:fetch failed (ENOTFOUND)' };
    const next = applyFailCountPrefix(
      { search_ok: false, search_verdict: 'conn_fail', error: 'fetch failed (ENOTFOUND)' },
      previous as Parameters<typeof applyFailCountPrefix>[1], 'h',
    );
    expect(next.error).toBe('fail_count:3:fetch failed (ENOTFOUND)');
    expect(parseFailCount(next.error)).toEqual({ count: 3, rest: 'fetch failed (ENOTFOUND)' });
  });
});
