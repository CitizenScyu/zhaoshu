import { createHash, randomBytes } from 'node:crypto';
import type { neon } from '@neondatabase/serverless';

// 邀请码：192 位随机值 + 固定前缀；原文只在生成响应里出现一次，库里只存 SHA-256 摘要
// （设计 §4.3）。随机熵足够高，摘要可以直接做唯一键查找，不需要再加盐或慢哈希。
// 前缀让小写化/去空格之外的误输入更容易被发现；base64url 区分大小写，所以校验时
// **只 trim、不折大小写**，折了就会把有效码改成无效码。
export const INVITE_CODE_PREFIX = 'nf-';
export const INVITE_CODE_BYTES = 24;
export const MAX_INVITE_BATCH = 10;
export const DEFAULT_INVITE_TTL_DAYS = 7;
export const MAX_INVITE_TTL_DAYS = 365;
export const MAX_INVITE_CODE_LENGTH = 80;

export type RegistrationMode = 'closed' | 'open' | 'invite';

export function isRegistrationMode(value: unknown): value is RegistrationMode {
  return value === 'closed' || value === 'open' || value === 'invite';
}

export function normalizeInviteCode(value: string): string {
  return value.trim();
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(normalizeInviteCode(code), 'utf8').digest('hex');
}

/** 新邀请码：{原文, 摘要, 短提示}。原文由调用方一次性返回给 owner，绝不入库。 */
export function generateInviteCode(): { code: string; codeHash: string; codeHint: string } {
  const code = `${INVITE_CODE_PREFIX}${randomBytes(INVITE_CODE_BYTES).toString('base64url')}`;
  return { code, codeHash: hashInviteCode(code), codeHint: code.slice(-4) };
}

export interface InviteCodeSummary {
  id: number;
  codeHint: string;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  usedByUsername: string | null;
  status: 'active' | 'used' | 'revoked' | 'expired';
}

type InviteRow = {
  id: number;
  code_hint: string;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  revoked_at: string | null;
  used_by_username: string | null;
};

// 状态由数据库时间与列组合推出，不信任客户端时钟；revoked 优先于 expired，used 最高。
function inviteStatus(row: InviteRow, now: number): InviteCodeSummary['status'] {
  if (row.used_at !== null) return 'used';
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && Date.parse(row.expires_at) <= now) return 'expired';
  return 'active';
}

export function toInviteSummary(row: InviteRow, now: number = Date.now()): InviteCodeSummary {
  return {
    id: row.id,
    codeHint: row.code_hint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    usedByUsername: row.used_by_username,
    status: inviteStatus(row, now),
  };
}

export async function listInviteCodes(sql: ReturnType<typeof neon>, limit = 100): Promise<InviteCodeSummary[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200);
  const rows = await sql`
    SELECT i.id, i.code_hint, i.created_at::text AS created_at, i.expires_at::text AS expires_at,
           i.used_at::text AS used_at, i.revoked_at::text AS revoked_at,
           u.username AS used_by_username
    FROM registration_invites i
    LEFT JOIN users u ON u.id = i.used_by
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ${bounded}` as InviteRow[];
  const now = Date.now();
  return rows.map((row) => toInviteSummary(row, now));
}

export interface CreatedInviteCode {
  code: string;
  codeHint: string;
  expiresAt: string | null;
}

// 批量生成（上限 10）。用一条多行 INSERT，避免部分成功；返回的原文只在这里出现。
export async function createInviteCodes(
  sql: ReturnType<typeof neon>,
  count: number,
  ttlDays: number | null,
  createdBy: number,
): Promise<CreatedInviteCode[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INVITE_BATCH) {
    throw new Error(`invite batch must be between 1 and ${MAX_INVITE_BATCH}`);
  }
  if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_INVITE_TTL_DAYS)) {
    throw new Error(`invite ttl must be between 1 and ${MAX_INVITE_TTL_DAYS} days or null`);
  }
  const generated = Array.from({ length: count }, () => generateInviteCode());
  const hashes = generated.map((item) => item.codeHash);
  const hints = generated.map((item) => item.codeHint);
  const ttl = ttlDays === null ? null : ttlDays;
  const rows = await sql`
    INSERT INTO registration_invites (code_hash, code_hint, created_by, expires_at)
    SELECT hash, hint, ${createdBy}::int,
           CASE WHEN ${ttl}::int IS NULL THEN NULL
                ELSE now() + (${ttl}::int * interval '1 day') END
    FROM unnest(${hashes}::text[], ${hints}::text[]) AS input(hash, hint)
    RETURNING code_hash, expires_at::text AS expires_at` as { code_hash: string; expires_at: string | null }[];
  const byHash = new Map(rows.map((row) => [row.code_hash, row.expires_at]));
  return generated.map((item) => ({
    code: item.code,
    codeHint: item.codeHint,
    expiresAt: byHash.get(item.codeHash) ?? null,
  }));
}

export type RevokeResult = 'revoked' | 'used' | 'already_revoked' | 'not_found';

// 幂等作废：只作用于未使用、未作废的码；已使用的码不影响已注册账户（设计 §4.3）。
export async function revokeInviteCode(sql: ReturnType<typeof neon>, id: number): Promise<RevokeResult> {
  const updated = await sql`
    UPDATE registration_invites SET revoked_at = now()
    WHERE id = ${id}::int AND used_at IS NULL AND revoked_at IS NULL
    RETURNING id` as { id: number }[];
  if (updated.length > 0) return 'revoked';
  const rows = await sql`
    SELECT used_at, revoked_at FROM registration_invites WHERE id = ${id}::int` as { used_at: string | null; revoked_at: string | null }[];
  const row = rows[0];
  if (!row) return 'not_found';
  if (row.used_at !== null) return 'used';
  if (row.revoked_at !== null) return 'already_revoked';
  // UPDATE 与 SELECT 之间被并发改动：按已作废处理，外部语义仍是幂等。
  return 'already_revoked';
}

export interface RegistrationSettings {
  membersEnabled: boolean;
  registrationMode: RegistrationMode;
  updatedAt: string | null;
}

export async function readRegistrationSettings(sql: ReturnType<typeof neon>): Promise<RegistrationSettings> {
  const rows = await sql`
    SELECT members_enabled, registration_mode, updated_at::text AS updated_at
    FROM auth_settings WHERE id = 1` as { members_enabled: boolean; registration_mode: string; updated_at: string | null }[];
  const row = rows[0];
  // 读不到或脏值一律按最保守的「关闭」处理，注册入口不能靠默认值放开。
  const mode = row && isRegistrationMode(row.registration_mode) ? row.registration_mode : 'closed';
  return {
    membersEnabled: row?.members_enabled === true,
    registrationMode: mode,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function writeRegistrationSettings(
  sql: ReturnType<typeof neon>,
  settings: { membersEnabled: boolean; registrationMode: RegistrationMode },
): Promise<string | null> {
  if (!isRegistrationMode(settings.registrationMode)) throw new Error('invalid registration mode');
  const rows = await sql`
    INSERT INTO auth_settings (id, members_enabled, registration_mode, updated_at)
    VALUES (1, ${settings.membersEnabled}, ${settings.registrationMode}, now())
    ON CONFLICT (id) DO UPDATE SET members_enabled = EXCLUDED.members_enabled,
      registration_mode = EXCLUDED.registration_mode, updated_at = now()
    RETURNING updated_at::text AS updated_at` as { updated_at: string | null }[];
  return rows[0]?.updated_at ?? null;
}
