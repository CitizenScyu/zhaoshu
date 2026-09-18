import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAuthSecuritySecret } from './auth-session';
import type { VerifiedCandidate } from './types';

// F01：rerank 只信服务端签发的验证票据，不信客户端回传的 body.verified。
//
// 背景：verify 步骤由服务端跑豆瓣/书源核验，产出的 verified（含 douban.doubanId/rating/
// ratingCount）会被 rerank 落进**共享** books 行（persistRecommendationsForUser 的 upsert）。
// rerank 若直接吃客户端回传的 verified，有 find 权限的成员就能伪造豆瓣元数据污染其他用户
// 看到的条目。这里用 HMAC 票据把「这批结果确实是服务端刚核出来的」变成可验证事实。
//
// 格式（与方案一致）：base64url(payloadJson) + "." + base64url(hmacSha256(key, DOMAIN + base64url(payloadJson)))
// - verified 数组**嵌在票据里**，rerank 直接用票据内的值，不从 body 取，规避客户端 JSON
//   规范化 / 键序差异。
// - DOMAIN 做密钥用途域分隔，避免与限速键 / owner 代际标签复用同一 secret 时的跨用途攻击。
// - key 复用 getAuthSecuritySecret()（AUTH_SECURITY_SECRET ≥32 字节）。
export const VERIFY_TICKET_TTL_MS = 30 * 60 * 1000; // 覆盖用户重试 / 慢模型；见任务书
const TICKET_DOMAIN = 'verify-ticket-v1\0';

export type VerifyTicketPayload = {
  u: number; // userId
  q: string; // query
  c: string; // conditions
  exp: number; // 过期时刻（unix ms）
  v: VerifiedCandidate[]; // 服务端核验结果
};

export type IssueVerifyTicketInput = {
  userId: number;
  query: string;
  conditions: string;
  verified: VerifiedCandidate[];
  now?: number;
};

let warnedFallbackKey = false;

// 票据签名 key。
// - 正常：AUTH_SECURITY_SECRET（账号模式）。
// - 降级：仅当它不可用而 APP_OWNER_TOKEN 存在时，用 owner 口令作 key 并 console.warn 一次。
//   这是给「仅 owner 口令」的 legacy 部署留的可用路径（该模式下没有成员、不存在共享行被
//   成员污染的前提；且 owner 口令对成员不可知，票据仍不可伪造）。
// - 两者都缺：返回 null，调用方**拒绝**（不静默接受 body.verified）。
export function ticketSigningKey(): string | null {
  const secret = getAuthSecuritySecret();
  if (secret) return secret;
  const ownerToken = process.env.APP_OWNER_TOKEN;
  if (ownerToken) {
    if (!warnedFallbackKey) {
      warnedFallbackKey = true;
      console.warn(
        'verify-ticket: AUTH_SECURITY_SECRET 不可用，回退用 APP_OWNER_TOKEN 作为票据签名 key（legacy owner 部署）。',
      );
    }
    return ownerToken;
  }
  return null;
}

function sign(key: string, body: string): string {
  return createHmac('sha256', key).update(TICKET_DOMAIN + body).digest('base64url');
}

// 签发。key 由调用方从 ticketSigningKey() 取得；没有 key 时调用方不得调用本函数。
export function issueVerifyTicket(
  key: string,
  input: IssueVerifyTicketInput,
): string {
  const payload: VerifyTicketPayload = {
    u: input.userId,
    q: input.query,
    c: input.conditions,
    exp: (input.now ?? Date.now()) + VERIFY_TICKET_TTL_MS,
    v: input.verified,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export type VerifyTicketExpectation = {
  userId: number;
  query: string;
  conditions: string;
  now?: number;
};

// 校验：签名 / 过期 / 用户 / 查询 / 条件全绑，任一不符返回 null。
export function readVerifyTicket(
  key: string,
  ticket: string,
  expected: VerifyTicketExpectation,
): VerifyTicketPayload | null {
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const body = ticket.slice(0, dot);
  const provided = ticket.slice(dot + 1);
  const want = sign(key, body);
  const a = Buffer.from(provided);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  if (payload.u !== expected.userId) return null;
  if (payload.q !== expected.query) return null;
  if (payload.c !== expected.conditions) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp <= (expected.now ?? Date.now())) return null;
  if (!Array.isArray(payload.v)) return null;
  return payload as unknown as VerifyTicketPayload;
}
