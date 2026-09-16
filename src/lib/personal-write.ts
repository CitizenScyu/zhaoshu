import type { neon, NeonQueryFunctionInTransaction } from '@neondatabase/serverless';

export type PersonalSql = ReturnType<typeof neon>;
export type PersonalQuery = NeonQueryFunctionInTransaction<boolean, boolean>;
export type PersonalBatch = (sql: PersonalQuery) => ReturnType<PersonalQuery>[];
export type PersonalWriter = (batch: PersonalBatch) => Promise<Record<string, unknown>[][]>;
export type WriteAuthorization = {
  userId: number;
  role: 'owner' | 'member';
  method: 'owner-header' | 'session';
  tokenHash: string | null;
  ownerTag: string | null;
  expiresAt: string;
};

export class AuthorizationRevokedError extends Error {
  readonly code = 'AUTHORIZATION_CHANGED';
  constructor() { super('授权已改变，请重新验证身份。'); }
}

// DO 内不插值请求数据；输入全部由参数化 set_config 传入且只在本事务有效。
// SHARE 行锁让退出、禁用、降权与写事务有明确顺序：撤销先完成则拒写，
// 写事务先持锁则撤销等待提交。最后再次检查会话有效期与整个请求的截止时间。
function authorizationFence(sql: PersonalQuery) {
  return sql`DO $$
    DECLARE g jsonb := current_setting('nf.write_authorization')::jsonb;
    BEGIN
      IF clock_timestamp() >= (g->>'expiresAt')::timestamptz THEN
        RAISE EXCEPTION 'personal request deadline exceeded' USING ERRCODE = '57014';
      END IF;
      IF g->>'method' NOT IN ('session', 'owner-header') OR
        (g->>'method' = 'owner-header' AND (g->>'role' <> 'owner' OR (g->>'userId')::int <> 1)) THEN
        RAISE EXCEPTION 'personal authorization changed' USING ERRCODE = '42501';
      END IF;
      PERFORM id FROM users WHERE id = (g->>'userId')::int
        AND role = g->>'role' AND disabled_at IS NULL AND can_find FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'personal authorization changed' USING ERRCODE = '42501';
      END IF;
      IF g->>'method' = 'session' THEN
        PERFORM id FROM auth_settings WHERE id = 1
          AND (g->>'role' = 'owner' OR members_enabled) FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal authorization changed' USING ERRCODE = '42501';
        END IF;
        PERFORM token_hash FROM sessions WHERE token_hash = g->>'tokenHash'
          AND user_id = (g->>'userId')::int AND expires_at > clock_timestamp()
          AND ((g->>'role' = 'member' AND auth_method = 'password') OR
            (g->>'role' = 'owner' AND auth_method = 'owner_token' AND owner_credential_tag = g->>'ownerTag'))
          FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal authorization changed' USING ERRCODE = '42501';
        END IF;
      END IF;
    END $$`;
}

export async function authorizedTransaction(
  sql: PersonalSql,
  authorization: WriteAuthorization,
  batch: PersonalBatch,
  signal: AbortSignal,
): Promise<Record<string, unknown>[][]> {
  signal.throwIfAborted();
  const remaining = Date.parse(authorization.expiresAt) - Date.now();
  if (!Number.isSafeInteger(authorization.userId) || authorization.userId < 1) throw new AuthorizationRevokedError();
  if (!Number.isFinite(remaining) || remaining <= 0) throw Object.assign(new Error('request deadline exceeded'), { code: '57014' });
  try {
    const rows = await sql.transaction((tx) => [
      tx`SELECT set_config('statement_timeout', ${String(Math.floor(remaining))}, true),
                set_config('nf.write_authorization', ${JSON.stringify(authorization)}, true)`,
      authorizationFence(tx),
      ...batch(tx),
      authorizationFence(tx),
    ], { isolationLevel: 'ReadCommitted', fetchOptions: { signal } });
    // HTTP abort 无法证明已经提交给 PostgreSQL 的事务被撤销；不返回迟到成功，
    // 服务端仍以事务内授权锁、statement_timeout 及末尾截止时间检查保证写入边界。
    signal.throwIfAborted();
    return rows.slice(2, -1) as Record<string, unknown>[][];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '42501') throw new AuthorizationRevokedError();
    throw error;
  }
}
