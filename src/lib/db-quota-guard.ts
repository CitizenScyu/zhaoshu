// Vercel 侧的数据库配额闸（41-q402fix）：一个请求咽喉 + 一个响应咽喉。
//
// 请求咽喉 quotaAwareFetch：db.ts 把它设为 neonConfig.fetchFunction（驱动所有 HTTP 查询都经它发出）。
//   - 本实例冷却期内**不发网络请求**，直接合成 402 —— 驱动照常抛 `Server error (HTTP status 402)`，
//     上层所有代码路径与真 402 完全一致，只是不再每个请求都真打一次 Neon；
//   - 真响应 402 ⇒ 布置冷却，由正常转入时打一行结构化日志；2xx ⇒ 结束冷却；
//   - 同时给当前请求（AsyncLocalStorage 作用域）打「撞到配额」标记。
// 响应咽喉 withDbQuotaGuard：包住每个路由处理器（route-guard.test.ts 扫描全部 route.ts 钉死）。
//   本请求撞到配额且响应 ≥500、或处理器抛出配额错误 ⇒ 统一改回 503 + DB_QUOTA_EXCEEDED + Retry-After；
//   2xx/4xx 与已开始的流式响应不动。各路由自己的 catch 回什么（500 INTERNAL、业务 503、未 catch）都被收口，
//   驱动原文（带 Neon 响应体）不会回到前端。

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createDbQuotaLatch, DB_QUOTA_ERROR_CODE, dbQuotaBackoffMs, isDbQuotaError, type DbQuotaLatch,
} from './db-quota';

/** 本实例（进程）的配额冷却闸；健康端点读它的 status()。 */
export const dbQuotaLatch: DbQuotaLatch = createDbQuotaLatch({ backoffMs: dbQuotaBackoffMs() });

const requestScope = new AsyncLocalStorage<{ quotaHit: boolean }>();

/** 当前请求作用域内是否撞到过配额（作用域外恒 false）。 */
export function requestHitDbQuota(): boolean {
  return requestScope.getStore()?.quotaHit === true;
}

function markQuotaHit(): void {
  const scope = requestScope.getStore();
  if (scope) scope.quotaHit = true;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// 本地合成的 402：响应体不含任何上游文本，驱动据此抛出的错误与真 402 同形（isDbQuotaError 判中）。
function localQuotaResponse(): Response {
  return new Response(JSON.stringify({ message: 'database quota exceeded (local backoff)' }), {
    status: 402, headers: { 'content-type': 'application/json' },
  });
}

export function createQuotaAwareFetch(
  latch: DbQuotaLatch,
  baseFetch: FetchLike = (input, init) => fetch(input, init),
): FetchLike {
  return async (input, init) => {
    if (latch.active()) {
      markQuotaHit();
      return localQuotaResponse();
    }
    const response = await baseFetch(input, init);
    if (response.status === 402) {
      markQuotaHit();
      if (latch.note()) {
        console.error('db quota exceeded', {
          event: 'db_quota_exceeded', component: 'vercel', retryAt: latch.retryAt(),
        });
      }
    } else if (response.ok) {
      latch.recover();
    }
    return response;
  };
}

/** db.ts 装进 neonConfig.fetchFunction 的实例（绑定本实例闸）。 */
export const quotaAwareFetch = createQuotaAwareFetch(dbQuotaLatch);

/** 统一的配额 503：固定文案与错误码，Retry-After = 冷却剩余秒数（至少 60s），不缓存。 */
export function dbQuotaResponse(latch: DbQuotaLatch = dbQuotaLatch): Response {
  const retryAfter = Math.max(60, Math.ceil(latch.remainingMs() / 1000));
  return Response.json(
    { error: '数据库额度已用尽，服务暂不可用，请稍后再试', code: DB_QUOTA_ERROR_CODE },
    { status: 503, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * 路由处理器包装：签名原样透传（Next 的路由类型检查照常生效）。
 * 用法：`async function handleGET(...) {...}` + `export const GET = withDbQuotaGuard(handleGET);`
 */
export function withDbQuotaGuard<A extends unknown[], R extends Response>(
  handler: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R | Response> {
  return async (...args: A) => {
    const scope = { quotaHit: false };
    try {
      const response = await requestScope.run(scope, () => handler(...args));
      return scope.quotaHit && response.status >= 500 ? dbQuotaResponse() : response;
    } catch (error) {
      if (scope.quotaHit || isDbQuotaError(error)) return dbQuotaResponse();
      throw error;
    }
  };
}
