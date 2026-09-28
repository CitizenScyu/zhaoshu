import { drainProfileFeedbackQueue } from './drain-queue';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authJson } from '@/lib/auth-http';
import { recordCronSuccess } from '@/lib/source-health';
import { MODEL_ROUTE_INTERNAL_BUDGET_MS, createDeadline } from '@/lib/deadline';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// F15 残留③：待吸收反馈的每日兜底 drain。浏览器触发丢失（关页/刷新失败）或吸收失败后，
// 这里保证最终一致：pending 且租约过期/退避到期的行，每天一次被同一吸收路径消化。
// 复用 download/reclaim 的 cron 模式（CRON_SECRET Bearer，fail closed；未配置 403）。
//
// R1：独立每日 cron（Hobby 当前每项目 100 条、每条每天一次，官方文档核实于 2026-09-19）。
// 不再挂到 reclaim 的 after：普通函数导入不会继承本路由的 maxDuration。
export const maxDuration = 295;

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

async function handleGET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return authJson({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  const deadline = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
  try {
    const { results, stoppedForBudget } = await drainProfileFeedbackQueue(deadline);
    // S5-1：留一次「本轮 drain 跑完」的时间戳，供匿名健康端点 /api/health/sources 判活。
    // 队列为空时 drain 不写任何行，「本轮跑没跑」在库里原本无迹可寻。注意：这里记的是
    // 路由未 5xx（cron 成功），与逐用户吸收是否成功无关（后者由 results/stoppedForBudget 表达）。
    await recordCronSuccess('drain');
    return authJson({ ok: true, drained: results.length, results, stoppedForBudget });
  } catch (e) {
    console.error('profile absorb drain failed', e instanceof Error ? { name: e.name } : e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  } finally {
    deadline.dispose();
  }
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
