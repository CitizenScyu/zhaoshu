// 注册的原子语句（唯一一份真本，路由与 PGlite 真库用例共用同一条模板字面量）。
//
// 设计约束（§4.3 末尾）：Neon HTTP 是非交互事务，必须用一条数据修改 CTE 完成
// 「锁配置行 → 消费邀请码 → 插 member → 插空画像 → 插 session」，资格不满足时所有插入为零行。
//
// 为什么不能拆成两条语句：registration_invites 上的
// CHECK ((used_by IS NULL) = (used_at IS NULL)) 是 condeferrable=false，PostgreSQL 的
// CHECK **不可延迟**——语句一结束就校验，没有「先置 used_at、稍后回填 used_by」的中间态。
// 2026-09-17 真库验收实测：拆两条语句时第一条必然抛 23514，邀请码注册 100% 失败。
//
// 两列必须在同一次 UPDATE 里同时置位，而 used_by 要指向新用户 ⇒ 先取出将要使用的 userId
// （nextval 预分配），再让 claim 同时写 used_at 与 used_by，最后用同一个 id 插用户。
// 这样消费（权威判定）仍然发生在用户插入之前，并发同码注册最多一人成功。

export type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => unknown;

export interface RegistrationStatementParams {
  /** 请求里带了非空邀请码。false 时 claim 不消费任何行。 */
  useInvite: boolean;
  /** 邀请码摘要；useInvite 为 false 时为 null。 */
  codeHash: string | null;
  /** 已规范化（trim + 小写）的用户名。 */
  username: string;
  /** 事务外算好的 scrypt 哈希。 */
  passwordHash: string;
  /** 会话 token 的 SHA-256 摘要。 */
  tokenHash: string;
  /** 会话有效期秒数。 */
  ttlSeconds: number;
}

/** 用调用方给的标签模板执行注册语句（路由传 Neon 事务 tag，真库用例传 $n 记录 tag）。 */
export function buildRegistrationStatement(tag: SqlTag, params: RegistrationStatementParams): unknown {
  return tag`
    WITH cfg AS (
      SELECT members_enabled, registration_mode FROM auth_settings WHERE id = 1 FOR SHARE
    ),
    gate AS (
      SELECT 1 WHERE EXISTS (
        SELECT 1 FROM cfg WHERE members_enabled AND registration_mode IN ('open', 'invite')
      )
    ),
    new_id AS (
      SELECT nextval(pg_get_serial_sequence('users', 'id'))::int AS id FROM gate
    ),
    claim AS (
      UPDATE registration_invites
      SET used_at = now(), used_by = (SELECT id FROM new_id)
      WHERE ${params.useInvite}::boolean
        AND code_hash = ${params.codeHash}
        AND (SELECT registration_mode FROM cfg) = 'invite'
        AND used_at IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND EXISTS (SELECT 1 FROM gate)
        AND (SELECT id FROM new_id) IS NOT NULL
      RETURNING id
    ),
    new_user AS (
      INSERT INTO users (id, username, password_hash, role, created_via_invite_id)
      SELECT (SELECT id FROM new_id), ${params.username}, ${params.passwordHash}, 'member', (SELECT id FROM claim)
      WHERE EXISTS (SELECT 1 FROM gate)
        AND ((SELECT registration_mode FROM cfg) = 'open' OR EXISTS (SELECT 1 FROM claim))
      RETURNING id, username, can_find, can_read, can_download
    ),
    new_profile AS (
      INSERT INTO profile (id) SELECT id FROM new_user ON CONFLICT (id) DO NOTHING RETURNING id
    ),
    new_session AS (
      INSERT INTO sessions (token_hash, user_id, auth_method, owner_credential_tag, expires_at)
      SELECT ${params.tokenHash}, id, 'password', NULL,
             now() + (${params.ttlSeconds}::double precision * interval '1 second')
      FROM new_user
      RETURNING user_id
    )
    SELECT (SELECT members_enabled FROM cfg) AS members_enabled,
           (SELECT registration_mode FROM cfg) AS registration_mode,
           (SELECT count(*) FROM claim)::int AS claimed,
           u.id, u.username, u.can_find, u.can_read, u.can_download
    FROM cfg LEFT JOIN new_user u ON true`;
}
