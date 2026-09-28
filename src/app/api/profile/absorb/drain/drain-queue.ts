import { randomUUID } from 'node:crypto';
import { drainableProfileFeedbackUsers, ensureSchema, getSql } from '@/lib/db';
import { absorbPendingProfileFeedback } from '@/lib/profile-absorption';
import { configuredTotalTimeoutMs } from '@/lib/llm';
import { raceDeadline, type RequestDeadline } from '@/lib/deadline';
import type { PersonalBatch, PersonalWriter } from '@/lib/personal-write';

// 单次 drain 最多处理的用户数：每次吸收是一次模型调用（上限 260s），295s 路由内实际只能
// 完成 1 次左右；上限取 20 保证「扫描有界」，超时/未完成者明天的窗口继续（lease/backoff
// 状态在每用户处理中原子落库，不会因为批中断而错乱）。
const DRAIN_USER_LIMIT = 20;

// 单用户模型预算上限。领取前须有完整模型预算及写回预留。
const DRAIN_MODEL_CEILING_MS = 260_000;

// drain 写库没有用户授权事务（cron 无 principal）：直连 getSql 的事务写入器（与
// authorizedTransaction 同构，但没有授权栅栏——cron 身份由 CRON_SECRET 证明）。写入
// 仍按 user_id 定位，且只处理「领取成功」（lease CAS）的行。
const systemWriter: PersonalWriter = (batch: PersonalBatch) =>
  getSql().transaction((tx) => batch(tx) as unknown as never) as unknown as ReturnType<PersonalWriter>;

// R2：路由拥有唯一 deadline，初始化、扫描与整批吸收都从同一预算扣除。
// 领取前要求完整的配置模型预算 + deadline 的写回预留；余量不足就留待下轮。
export async function drainProfileFeedbackQueue(deadline: RequestDeadline): Promise<{
  results: { userId: number; status: string }[];
  stoppedForBudget: boolean;
}> {
  const results: { userId: number; status: string }[] = [];
  const modelBudgetMs = Math.min(DRAIN_MODEL_CEILING_MS, configuredTotalTimeoutMs());
  const hasBudget = () => !deadline.expired && deadline.modelBudgetMs(DRAIN_MODEL_CEILING_MS) >= modelBudgetMs;
  if (!hasBudget()) return { results, stoppedForBudget: true };
  await raceDeadline(deadline.signal, ensureSchema);
  if (!hasBudget()) return { results, stoppedForBudget: true };
  const userIds = await raceDeadline(deadline.signal, () => drainableProfileFeedbackUsers(DRAIN_USER_LIMIT));
  for (const userId of userIds) {
    if (!hasBudget()) {
      logDrainSummary(results, true);
      return { results, stoppedForBudget: true };
    }
    try {
      const result = await raceDeadline(deadline.signal, () => absorbPendingProfileFeedback({
        userId, leaseToken: randomUUID(), write: systemWriter, signal: deadline.signal, modelBudgetMs,
      }));
      results.push({ userId, status: result.status });
      // F2 可观测：非成功状态（failed/conflict/busy 等）逐用户留痕——GET 响应无人轮询
      // （前端 fire-and-forget），没有这行日志失败完全无痕。脱敏：只记 userId 与状态。
      if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'pending') {
        console.error('profile absorb drain user not applied', { userId, status: result.status });
      }
    } catch (error) {
      console.error('profile absorb drain user failed', { userId, name: error instanceof Error ? error.name : typeof error });
      results.push({ userId, status: 'failed' });
      if (deadline.expired) {
        logDrainSummary(results, true);
        return { results, stoppedForBudget: true };
      }
    }
  }
  logDrainSummary(results, false);
  return { results, stoppedForBudget: false };
}

// F2 可观测：轮末汇总一行（有 failed/conflict 或预算中断才打，全成功不打扰日志）。
// GET 恒 200 的响应体没有消费者，这里是 drain 健康态的唯一留痕渠道。
function logDrainSummary(results: { userId: number; status: string }[], stoppedForBudget: boolean): void {
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'conflict');
  if (!failed.length && !stoppedForBudget) return;
  console.error('profile absorb drain summary', {
    drained: results.length,
    failedCount: failed.length,
    failedUserIds: failed.map((r) => r.userId),
    stoppedForBudget,
  });
}
