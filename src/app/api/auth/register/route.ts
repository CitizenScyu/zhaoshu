import type { NextRequest } from 'next/server';
import { authAccountsEnabled } from '@/lib/auth';
import { authError, authJson } from '@/lib/auth-http';
import {
  GLOBAL_RATE_LIMIT_KEY,
  LOGIN_GLOBAL_RATE_LIMIT,
  REGISTER_SOURCE_RATE_LIMIT,
  bumpAuthRateLimit,
  decideRateLimit,
  rateLimitKeyHash,
  requestSourceIdentifier,
} from '@/lib/auth-rate-limit';
import {
  DEFAULT_SESSION_TTL_SECONDS,
  REMEMBER_SESSION_TTL_SECONDS,
  cleanupExpiredAuthRows,
  ensureAuthSchema,
  generateSessionToken,
  getAuthSecuritySecret,
  getSessionCookieName,
  hashSessionToken,
  sessionCookieOptions,
} from '@/lib/auth-session';
import { isJsonContentType, verifySameOriginWrite } from '@/lib/csrf';
import { getSql } from '@/lib/db';
import { MAX_INVITE_CODE_LENGTH, hashInviteCode } from '@/lib/invite-codes';
import { MIN_PASSWORD_CODEPOINTS, checkPasswordBounds, hashPassword } from '@/lib/password';
import { buildRegistrationStatement, type SqlTag } from '@/lib/register-statement';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// 用户名 + 密码 + 邀请码合计上限 4 KiB（设计 §4.1）。
const MAX_REGISTER_BODY_CHARS = 4096;
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

// 邀请码不存在 / 过期 / 作废 / 已使用，对匿名调用者一律同一句话（设计 §4.4：不开放验码接口，
// 不给枚举留判据）。注册关闭也单独给码，界面才能区分「开关关了」和「码不对」。
const INVITE_MESSAGE = '邀请码无效或已不可用';

function invalidInvite() {
  return authError(403, 'INVITATION_INVALID', INVITE_MESSAGE);
}

type RegisterRow = {
  members_enabled: boolean;
  registration_mode: string;
  claimed: number;
  id: number | null;
  username: string | null;
  can_find: boolean | null;
  can_read: boolean | null;
  can_download: boolean | null;
};

// 原子注册（设计 §4.3 第 3-4 步 + §4.3 末尾对 Neon 非交互事务的约束）：
//
// 一条参数化数据修改 CTE 内完成「锁配置行 → 消费邀请码 → 插 member → 插空画像 → 插 session」。
// 数据修改 CTE 只共享同一快照，所以每一步都通过 RETURNING 的**输出**串联，绝不回读基表；
// 资格判断不满足时所有 INSERT 都是零行，用户名冲突则由唯一索引让整条语句回滚（不耗码）。
// 邀请码的 used_at 与 used_by 必须在同一次 UPDATE 里同时置位：registration_invites 的
// CHECK ((used_by IS NULL) = (used_at IS NULL)) 是 condeferrable=false，PostgreSQL 的 CHECK
// 不可延迟，拆成「先置 used_at、再回填 used_by」两条语句时第一条就抛 23514。
// 因此先 nextval 预分配 userId，claim 同时写 used_at 与 used_by，再用同一个 id 插用户；
// 消费（权威判定）仍发生在插用户之前，并发同码注册最多一人成功。语句本体见 lib/register-statement.ts。
//
// 配置行 FOR SHARE：owner 的「关闭注册」与本次提交按行锁排序，先提交的关闭生效。
async function handlePOST(req: NextRequest) {
  if (!authAccountsEnabled()) {
    return authError(503, 'ACCOUNTS_DISABLED', 'account features are not enabled');
  }
  const csrfFailure = verifySameOriginWrite(req);
  if (csrfFailure) return csrfFailure;
  if (!isJsonContentType(req)) {
    return authError(415, 'UNSUPPORTED_MEDIA_TYPE', 'expected application/json');
  }
  const raw = await req.text();
  if (raw.length > MAX_REGISTER_BODY_CHARS) {
    return authError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return authError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const { username, password, inviteCode, remember } = (body ?? {}) as {
    username?: unknown;
    password?: unknown;
    inviteCode?: unknown;
    remember?: unknown;
  };
  if (typeof username !== 'string' || typeof password !== 'string') {
    return authError(400, 'INVALID_BODY', 'username and password are required');
  }
  if (remember !== undefined && typeof remember !== 'boolean') {
    return authError(400, 'INVALID_BODY', 'remember must be a boolean');
  }
  if (inviteCode !== undefined && (typeof inviteCode !== 'string' || inviteCode.length > MAX_INVITE_CODE_LENGTH)) {
    return authError(400, 'INVALID_INVITE_CODE', 'inviteCode must be a string');
  }
  const normalizedUsername = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return authError(400, 'INVALID_USERNAME', 'username format is invalid');
  }
  // owner 是保留名（表上的 CHECK 也钉死了它）。这里显式拒绝，别让它掉进通用的 503。
  if (normalizedUsername === 'owner') {
    return authError(409, 'USERNAME_TAKEN', '用户名不可用');
  }
  // 下限只对新账户生效（15 码点），不套用到兼容 owner 口令。
  if ([...password].length < MIN_PASSWORD_CODEPOINTS) {
    return authError(400, 'INVALID_PASSWORD', `密码至少需要 ${MIN_PASSWORD_CODEPOINTS} 个字符`);
  }
  const boundsError = checkPasswordBounds(password);
  if (boundsError) {
    return authError(400, 'INVALID_PASSWORD', 'password format is invalid');
  }

  const secret = getAuthSecuritySecret();
  if (!secret) {
    return authError(503, 'AUTH_SECURITY_SECRET_REQUIRED', 'authentication service unavailable');
  }
  const sql = getSql();
  try {
    await ensureAuthSchema();
  } catch {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }

  // 先限速（计 KDF 前的预占）再算 scrypt：无效邀请码同样计数（设计 §4.4）。
  const source = requestSourceIdentifier(req);
  const buckets = [
    { window: REGISTER_SOURCE_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, REGISTER_SOURCE_RATE_LIMIT.scope, source) },
    { window: LOGIN_GLOBAL_RATE_LIMIT, keyHash: rateLimitKeyHash(secret, LOGIN_GLOBAL_RATE_LIMIT.scope, GLOBAL_RATE_LIMIT_KEY) },
  ];
  try {
    for (const bucket of buckets) {
      const decision = decideRateLimit(await bumpAuthRateLimit(sql, bucket.window, bucket.keyHash), bucket.window.limit);
      if (!decision.allowed) {
        return authError(429, 'RATE_LIMITED', 'too many authentication attempts', {
          'Retry-After': String(decision.retryAfterSeconds),
        });
      }
    }
  } catch {
    return authError(503, 'AUTH_RATE_LIMIT_UNAVAILABLE', 'authentication service unavailable');
  }

  // 哈希在任何数据库锁之外，绝不在等待 KDF 时持有行锁（设计 §4.3 第 2 步）。
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch {
    return authError(400, 'INVALID_PASSWORD', 'password format is invalid');
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const ttlSeconds = remember === true ? REMEMBER_SESSION_TTL_SECONDS : DEFAULT_SESSION_TTL_SECONDS;
  const useInvite = typeof inviteCode === 'string' && inviteCode.trim().length > 0;
  const codeHash = useInvite ? hashInviteCode(inviteCode as string) : null;

  let row: RegisterRow | undefined;
  try {
    // 只有一条语句：registration_invites 的 CHECK ((used_by IS NULL) = (used_at IS NULL))
    // 不可延迟，used_at / used_by 必须在同一次 UPDATE 里同时置位（见 lib/register-statement.ts）。
    const results = (await sql.transaction((tx) => [
      buildRegistrationStatement(tx as unknown as SqlTag, {
        useInvite,
        codeHash,
        username: normalizedUsername,
        passwordHash,
        tokenHash,
        ttlSeconds,
      }) as ReturnType<typeof tx>,
    ])) as unknown as [RegisterRow[]];
    row = results[0]?.[0];
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    // 23505 = 唯一索引冲突。注册路径上只可能是 users.username（邀请码摘要是查询条件不是插入值，
    // 会话 token 是 256 位随机值），但**只有约束名明确等于 users_username_key 才回 409**。
    // 约束名为空（null/undefined）或别的一律按服务端故障处理：注册路径上出现未知的唯一键冲突
    // 本身就是异常，冒充成「用户名已被占用」会把排查引向完全错误的方向（任务书：其他 23505 → 503）。
    if (code === '23505') {
      const constraint = error && typeof error === 'object' && 'constraint' in error ? error.constraint : null;
      if (constraint === 'users_username_key') {
        return authError(409, 'USERNAME_TAKEN', '用户名不可用');
      }
      console.error('registration hit an unexpected unique violation', { constraint: constraint ?? null });
      return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
    }
    // 23514 = CHECK 违约。用户侧输入早已逐项校验过，这里再犯就是服务端缺陷（例如曾经的
    // 「两列不一致」写法），如实报 503 而不是伪装成用户名冲突。
    if (code === '23514') {
      console.error('registration rejected by a database CHECK constraint', {
        constraint: error && typeof error === 'object' && 'constraint' in error ? error.constraint : null,
      });
    }
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }

  // 配置行不存在时上面的 CTE 返回空结果集，等同于「注册关闭」（缺配置默认关闭）。
  if (!row) return authError(403, 'REGISTRATION_CLOSED', '注册当前未开放');
  if (!row.members_enabled) {
    return authError(403, 'MEMBERS_DISABLED', '成员功能当前未启用');
  }
  if (row.registration_mode === 'closed') {
    return authError(403, 'REGISTRATION_CLOSED', '注册当前未开放');
  }
  if (row.registration_mode === 'invite' && row.claimed === 0) {
    return invalidInvite();
  }
  if (row.id === null) {
    return authError(503, 'AUTH_DB_UNAVAILABLE', 'authentication service unavailable');
  }

  try {
    await cleanupExpiredAuthRows(sql);
  } catch {
    // 顺带清理失败不影响注册结果。
  }

  const response = authJson({
    user: {
      id: row.id,
      username: row.username,
      role: 'member',
      canFind: row.can_find,
      canRead: row.can_read,
      canDownload: row.can_download,
      authMethod: 'session',
    },
  }, { status: 201 });
  response.cookies.set(getSessionCookieName(), token, sessionCookieOptions(remember === true));
  return response;
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
