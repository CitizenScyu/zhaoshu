import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  issueVerifyTicket,
  readVerifyTicket,
  ticketSigningKey,
  VERIFY_TICKET_TTL_MS,
} from './verify-ticket';
import type { VerifiedCandidate } from './types';

const SECRET = 'unit-test-security-secret-0123456789abcdef';
const verified: VerifiedCandidate[] = [{
  title: '票据书', author: '作者甲', category: '仙侠', wordCount: '100万字', why: '理由',
  source: 'llm',
  douban: { status: 'verified', found: true, doubanId: '123', rating: 8, ratingCount: 100 },
}];
const expectOk = { userId: 7, query: '找书', conditions: '' };

afterEach(() => vi.unstubAllEnvs());

describe('verify-ticket 签发票据', () => {
  it('签发后能解出同样的 payload', () => {
    const ticket = issueVerifyTicket(SECRET, { ...expectOk, verified, now: 1_000_000 });
    const payload = readVerifyTicket(SECRET, ticket, { ...expectOk, now: 1_000_001 });
    expect(payload).not.toBeNull();
    expect(payload!.u).toBe(7);
    expect(payload!.q).toBe('找书');
    expect(payload!.exp).toBe(1_000_000 + VERIFY_TICKET_TTL_MS);
    expect(payload!.v[0].douban.doubanId).toBe('123');
  });

  it('payload 是 base64url，票据形如 body.sig（一个点）', () => {
    const ticket = issueVerifyTicket(SECRET, { ...expectOk, verified });
    const [body, sig, ...rest] = ticket.split('.');
    expect(rest).toHaveLength(0);
    expect(sig.length).toBeGreaterThan(0);
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toMatchObject({ u: 7, q: '找书', c: '' });
  });

  it.each([
    ['用户不符', { userId: 8 }],
    ['查询不符', { query: '别的需求' }],
    ['条件不符', { conditions: '仅本次' }],
  ])('%s 时拒绝', (_label, overrides) => {
    const ticket = issueVerifyTicket(SECRET, { ...expectOk, verified, now: 1_000_000 });
    expect(readVerifyTicket(SECRET, ticket, { ...expectOk, ...overrides, now: 1_000_001 })).toBeNull();
  });

  it('过期票据被拒', () => {
    const ticket = issueVerifyTicket(SECRET, { ...expectOk, verified, now: 1_000_000 });
    expect(readVerifyTicket(SECRET, ticket, { ...expectOk, now: 1_000_000 + VERIFY_TICKET_TTL_MS })).toBeNull();
  });

  it('换 key / 篡改 / 坏格式一律被拒', () => {
    const ticket = issueVerifyTicket(SECRET, { ...expectOk, verified });
    expect(readVerifyTicket('another-secret-0123456789abcdefxxxx', ticket, expectOk)).toBeNull();
    expect(readVerifyTicket(SECRET, ticket.slice(0, -1) + (ticket.endsWith('A') ? 'B' : 'A'), expectOk)).toBeNull();
    for (const bad of ['', '.', 'abc', 'abc.', '.sig', 'not-base64.sig', `${'A'.repeat(8)}.${'B'.repeat(8)}`]) {
      expect(readVerifyTicket(SECRET, bad, expectOk), bad).toBeNull();
    }
  });
});

describe('verify-ticket 签名 key 解析', () => {
  it('优先用 AUTH_SECURITY_SECRET', () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', SECRET);
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-token-fallback');
    expect(ticketSigningKey()).toBe(SECRET);
  });

  it('security secret 缺失时回退 APP_OWNER_TOKEN', () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', 'short');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-token-fallback');
    expect(ticketSigningKey()).toBe('owner-token-fallback');
  });

  it('两者都缺时返回 null（调用方必须拒绝，不得静默放行）', () => {
    vi.stubEnv('AUTH_SECURITY_SECRET', '');
    vi.stubEnv('APP_OWNER_TOKEN', '');
    expect(ticketSigningKey()).toBeNull();
  });

  it('回退路径只告警一次', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('AUTH_SECURITY_SECRET', '');
    vi.stubEnv('APP_OWNER_TOKEN', 'owner-token-fallback');
    const fresh = await import('./verify-ticket');
    expect(fresh.ticketSigningKey()).toBe('owner-token-fallback');
    expect(fresh.ticketSigningKey()).toBe('owner-token-fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
