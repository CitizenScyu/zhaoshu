import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfileFeedbackQueueForUser } from '@/lib/db';
import { configuredTotalTimeoutMs } from '@/lib/llm';
import { withFindAccess } from '@/lib/personal-request';
import { MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';
import { absorbPendingProfileFeedback } from '@/lib/profile-absorption';

// F15：画像吸收的独立入口。反馈写路径不再同步跑模型；这里按用户合并执行一次吸收，
// 用户侧通过它（或下次机会）拿到 pending → applied/unchanged/failed/conflict 的最终状态。
export const maxDuration = 295;

// 与其他模型路由同口径：285s 内部预算里预留 12s 写回，ceiling 取 260s 留余量。
const MODEL_CEILING_MS = 260_000;

export async function POST(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    const budgetMs = Math.min(access.deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
    // F15 租约：领取 token 每次请求新生成；吸收路径内部先 claim 再调模型（拿不到租约
    // 不调模型），完成提交校验 token 未易主。见 profile-absorption.ts 注释。
    const result = await access.commit((write) => absorbPendingProfileFeedback({
      userId: access.principal.userId, leaseToken: randomUUID(), write, signal: access.signal, modelBudgetMs: budgetMs,
    }));
    return NextResponse.json({ ok: true, ...result });
  });
}

// 只读的队列状态：不调用模型，供用户侧显示「反馈已保存，画像待更新/已更新」。
export async function GET(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    const queue = await access.run(() => getProfileFeedbackQueueForUser(access.principal.userId));
    return NextResponse.json({
      ok: true,
      status: queue?.status ?? 'unchanged',
      pending: queue?.pendingFeedbackId != null,
      pendingFeedbackId: queue?.pendingFeedbackId ?? null,
      attempts: queue?.attempts ?? 0,
      // F15 退避可观测：退避窗口内 UI 可显示「稍后自动重试」；drain 每日兜底会接住。
      nextEligibleAt: queue?.nextEligibleAt ?? null,
    });
  });
}
