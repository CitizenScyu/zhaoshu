// 数据库配额类错误（Neon HTTP 402）的共用判定与退避状态（41-q402fix）。
//
// 2026-09-25 Neon 月传输额度用尽后，所有查询返回 HTTP 402，各进程照常按普通错误节奏重试：
// T8 worker 每 60s 打一次库、每次写 journal，Vercel 每个请求都真打一次 Neon，且无人知道。
// 本模块被 Vercel（db.ts / 路由包装 / 健康端点）、T8 执行器与 shuyuan 刷新运行器共用，
// 只依赖标准库，不引入 Next。
//
// 驱动错误形态（@neondatabase/serverless 1.1.0 index.mjs 的 execute，读源码核实）：
//   非 2xx 且非 400 的响应一律 `new NeonDbError("Server error (HTTP status " + status + "): " + 响应体文本)`，
//   **不设 code**；生产实测 402 的响应体为 `{"message":"Your account or project has exceeded the quota. …"}`。
// 所以判定只能看 message：驱动措辞 `Server error (HTTP status N)` 在时只认 N=402；无此措辞时看 Neon 文案 `exceeded the … quota`
// （后者也覆盖 WebSocket/pg 协议路径的 `exceeded the compute time quota` 之类变体）。

export const DB_QUOTA_ERROR_CODE = 'DB_QUOTA_EXCEEDED';
/** 配额类错误的默认退避：30 分钟。env DB_QUOTA_BACKOFF_MS 可覆盖（见 dbQuotaBackoffMs）。 */
export const DEFAULT_DB_QUOTA_BACKOFF_MS = 30 * 60_000;
const MIN_BACKOFF_MS = 60_000;
// 上限 4h：T8 执行器在冷却期内睡在 runOnce 里，必须短于 drain 单任务看门狗（340 分钟）。
export const MAX_DB_QUOTA_BACKOFF_MS = 4 * 3_600_000;

/** cron_health 里记「最近一次发现配额错误」的行名（last_success_at 列存的是发现时刻，不是成功时刻）。 */
export const DB_QUOTA_HEALTH_ROW = 'db_quota_exceeded';

const DRIVER_STATUS = /Server error \(HTTP status (\d+)\)/;
const NEON_QUOTA_TEXT = /exceeded the (?:[\w-]+ ){0,3}quota/i;
const MAX_CAUSE_DEPTH = 4;

/** 对外/日志只带固定短文案，原始驱动错误挂在 cause 上（不回显给前端）。 */
export class DbQuotaExceededError extends Error {
  readonly code = DB_QUOTA_ERROR_CODE;
  constructor(options?: { cause?: unknown }) {
    super('database quota exceeded', options);
    this.name = 'DbQuotaExceededError';
  }
}

/**
 * 是否数据库配额类错误。接受字符串：download-worker 把任务中途的异常吞成 reason 文本再返回。
 * 沿 cause / sourceError（NeonDbError 的底层错误字段）有界递归。
 */
export function isDbQuotaError(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || error === null || error === undefined) return false;
  if (typeof error === 'string') {
    // 驱动措辞带状态码时只认 402：别的状态码即使响应体恰含「exceeded the … quota」也不判中
    // （误判一次 = 本实例自停 30 分钟，宁缺勿滥）。无状态码措辞（pg 协议路径）才看 Neon 文案。
    const status = DRIVER_STATUS.exec(error);
    return status ? status[1] === '402' : NEON_QUOTA_TEXT.test(error);
  }
  if (typeof error !== 'object') return false;
  if (error instanceof DbQuotaExceededError) return true;
  const record = error as { code?: unknown; message?: unknown; cause?: unknown; sourceError?: unknown };
  if (record.code === DB_QUOTA_ERROR_CODE) return true;
  if (typeof record.message === 'string' && isDbQuotaError(record.message, depth)) return true;
  return isDbQuotaError(record.cause, depth + 1) || isDbQuotaError(record.sourceError, depth + 1);
}

/** 前端：响应是否为服务端配额 503（withDbQuotaGuard 产出）；是则应停止轮询/重试。 */
export function isDbQuotaResponse(status: number, body: unknown): boolean {
  return status === 503 && typeof body === 'object' && body !== null
    && (body as { code?: unknown }).code === DB_QUOTA_ERROR_CODE;
}

const CLIENT_RETRY_MIN_MS = 30_000;
const CLIENT_RETRY_MAX_MS = 30 * 60_000;

/**
 * 前端：配额 503 之后多久再探一次。取响应 Retry-After（秒数形态）；缺失/非法/HTTP-date 形态用服务端
 * 默认冷却；夹到 [30s, 30min]——下限不比正常轮询更密，上限保证额度恢复后最多半小时跟上。
 */
export function quotaRetryDelayMs(retryAfter: string | null): number {
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : Number.NaN;
  const ms = Number.isSafeInteger(seconds) ? seconds * 1000 : DEFAULT_DB_QUOTA_BACKOFF_MS;
  return Math.min(CLIENT_RETRY_MAX_MS, Math.max(CLIENT_RETRY_MIN_MS, ms));
}

/** env DB_QUOTA_BACKOFF_MS（毫秒）；缺省/非法回落 30 分钟，夹到 [60s, 4h]。 */
export function dbQuotaBackoffMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DB_QUOTA_BACKOFF_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_DB_QUOTA_BACKOFF_MS;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) return DEFAULT_DB_QUOTA_BACKOFF_MS;
  return Math.min(MAX_DB_QUOTA_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, value));
}

export interface DbQuotaStatus {
  state: 'ok' | 'exceeded';
  /** 最近一次发现配额错误的时刻（ISO）；从未发现为 null。 */
  lastSeenAt: string | null;
}

export interface DbQuotaLatch {
  /** 记一次配额错误；返回 true 表示由正常转入冷却（调用方据此只打一行日志）。 */
  note(): boolean;
  /** 冷却中：不应再碰库。 */
  active(): boolean;
  remainingMs(): number;
  /** 冷却到期时刻（ISO）；未冷却为 null。 */
  retryAt(): string | null;
  /** 一次成功访问库：结束冷却，保留 lastSeenAt。 */
  recover(): void;
  status(): DbQuotaStatus;
  /** 取走「发现过、尚未补记进库」的时刻（取一次即清）；库恢复可写后补记用。 */
  takeUnrecorded(): string | null;
}

export function createDbQuotaLatch(options: { backoffMs?: number; now?: () => number } = {}): DbQuotaLatch {
  const now = options.now ?? Date.now;
  const backoffMs = options.backoffMs ?? DEFAULT_DB_QUOTA_BACKOFF_MS;
  let until = 0;
  let lastSeen: number | null = null;
  let unrecorded: number | null = null;
  const active = () => now() < until;
  return {
    note() {
      const wasActive = active();
      const at = now();
      lastSeen = at;
      unrecorded = at;
      until = at + backoffMs;
      return !wasActive;
    },
    active,
    remainingMs: () => Math.max(0, until - now()),
    retryAt: () => (active() ? new Date(until).toISOString() : null),
    recover() { until = 0; },
    status: () => ({
      state: active() ? 'exceeded' : 'ok',
      lastSeenAt: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    }),
    takeUnrecorded() {
      const at = unrecorded;
      unrecorded = null;
      return at === null ? null : new Date(at).toISOString();
    },
  };
}

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

/**
 * 在 cron_health 补记最近一次发现配额错误的时刻（GREATEST：多进程/乱序补记不回拨）。
 * 只应在库已恢复可写时调用——配额期间写必失败，还要再耗一次请求。
 */
export async function recordDbQuotaSeen(sql: SqlTag, seenAtIso: string): Promise<void> {
  await sql`
    INSERT INTO cron_health (name, last_success_at) VALUES (${DB_QUOTA_HEALTH_ROW}, ${seenAtIso}::timestamptz)
    ON CONFLICT (name) DO UPDATE SET last_success_at = GREATEST(cron_health.last_success_at, EXCLUDED.last_success_at)`;
}
