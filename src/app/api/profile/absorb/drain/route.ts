import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authJson } from '@/lib/auth-http';
import { drainableProfileFeedbackUsers, ensureSchema, getSql } from '@/lib/db';
import { absorbPendingProfileFeedback } from '@/lib/profile-absorption';
import { configuredTotalTimeoutMs } from '@/lib/llm';
import { MODEL_ROUTE_INTERNAL_BUDGET_MS, createDeadline, raceDeadline } from '@/lib/deadline';
import type { PersonalBatch, PersonalWriter } from '@/lib/personal-write';

// F15 残留③：待吸收反馈的每日兜底 drain。浏览器触发丢失（关页/刷新失败）或吸收失败后，
// 这里保证最终一致：pending 且租约过期/退避到期的行，每天一次被同一吸收路径消化。
// 复用 download/reclaim 的 cron 模式（CRON_SECRET Bearer，fail closed；未配置 403）。
//
// 🔴 Vercel Hobby 限「每项目 2 个 cron、每天一次」，第三条 cron 会让部署直接失败
// （b89f575 的教训）。因此 vercel.json 不加条目，改由 /api/download/reclaim 在自身
// 回收完成后内联调用本模块的 drainProfileFeedbackQueue()——同一天 21:00 窗口顺带兜底，
// 且两者身份（CRON_SECRET）与预算（各自 maxDuration）独立，互不阻塞。
// 单独保留 GET 入口：付费层放开 cron 数后可直接挂条目（schedule 建议 "30 21 * * *"）。
export const maxDuration = 295;

// 单次 drain 最多处理的用户数：每次吸收是一次模型调用（上限 260s），295s 路由内实际只能
// 完成 1 次左右；上限取 20 保证「扫描有界」，超时/未完成者明天的窗口继续（lease/backoff
// 状态在每用户处理中原子落库，不会因为批中断而错乱）。
const DRAIN_USER_LIMIT = 20;

// drain 的每个用户吸收预算：不与浏览器请求共享 deadline，自建一个（模型 ceiling 与
// absorb 路由同口径 260s）。
const DRAIN_MODEL_CEILING_MS = 260_000;

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 与 /api/shuyuan、/api/download/reclaim 的 cron 路径同款：只认 CRON_SECRET 的 Bearer 头，
// 未配置则 fail closed。
function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

// drain 写库没有用户授权事务（cron 无 principal）：直连 getSql 的事务写入器（与
// authorizedTransaction 同构，但没有授权栅栏——cron 身份由 CRON_SECRET 证明）。写入
// 仍按 user_id 定位，且只处理「领取成功」（lease CAS）的行。
const systemWriter: PersonalWriter = (batch: PersonalBatch) =>
  getSql().transaction((tx) => batch(tx) as unknown as never) as unknown as ReturnType<PersonalWriter>;

// drain 的核心：扫描 → 逐用户走与浏览器触发同一条吸收路径。
// 单独导出供 /api/download/reclaim 内联复用（Hobby 2-cron 上限内共享每日窗口）；
// best-effort：内部逐用户吞错并记录，一个用户失败不影响后续用户，也不让调用方 500。
export async function drainProfileFeedbackQueue(): Promise<{ userId: number; status: string }[]> {
  await ensureSchema();
  const userIds = await drainableProfileFeedbackUsers(DRAIN_USER_LIMIT);
  const results: { userId: number; status: string }[] = [];
  for (const userId of userIds) {
    // 每用户独立预算：一个用户吃满 260s 不拖垮后面的用户（当前路由时长内实际只能
    // 完成约 1 个，但结构上不把「顺序用户」变成「共享超时」）。
    const deadline = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
    try {
      const budgetMs = Math.min(deadline.modelBudgetMs(DRAIN_MODEL_CEILING_MS), configuredTotalTimeoutMs());
      const result = await raceDeadline(deadline.signal, () => absorbPendingProfileFeedback({
        userId, leaseToken: randomUUID(), write: systemWriter, signal: deadline.signal, modelBudgetMs: budgetMs,
      }));
      results.push({ userId, status: result.status });
    } catch (error) {
      // 单用户失败（含预算耗尽）：吸收路径内部已记 failed/退避，这里只汇总继续。
      console.error('profile absorb drain user failed', { userId, name: error instanceof Error ? error.name : typeof error });
      results.push({ userId, status: 'failed' });
    } finally {
      deadline.dispose();
    }
  }
  return results;
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return authJson({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    const results = await drainProfileFeedbackQueue();
    // 返回形状与 absorb POST 一致，便于日志核对；不含任何用户数据。
    return authJson({ ok: true, drained: results.length, results });
  } catch (e) {
    console.error('profile absorb drain failed', e instanceof Error ? { name: e.name } : e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}

