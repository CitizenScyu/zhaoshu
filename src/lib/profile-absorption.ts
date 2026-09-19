import type { PersonalWriter } from './personal-write';
import {
  claimProfileFeedbackForUser,
  completeProfileFeedbackForUser,
  ensureProfileForUser,
  getProfileFeedbackQueueForUser,
  getProfileForUser,
  getProfileFeedbackForUser,
  getWithdrawnFeedbackBookTitlesForUser,
  markProfileFeedbackAbsorbedForUser,
  markProfileFeedbackFailedForUser,
} from './db';
import { chatRobust, validateProfileContent } from './llm';
import { recordUsageAfterResponse } from './record-llm-usage';
import { profileAbsorbSystem, profileAbsorbUser } from './prompts';

// F15：把「按用户合并的待吸收反馈」吸收进画像。
//
// 关键约束：
//  1. 写路径（/api/feedback）不调用模型；本函数才是那个可能跑数分钟的模型调用，由独立端点/
//     机会触发，用户不为它同步等待。
//  2. 合并：一次读取该用户全部「最新有效反馈」（F04 口径：每本书只认最新一行，先取最新再判
//     信息量）+ 撤回书目，一次模型调用覆盖队列里所有 pending——并发写两本书的反馈不会各触发
//     一次互相打架的 CAS。
//  3. 可恢复：失败/冲突都保留 pending_feedback_id，水位不推进，下次机会重放；成功才推进，
//     且只在 pending 不再更高时清空。
//  4. 撤回不复活：输入显式带上 withdrawnFeedbackBookTitles（F04 同一查询），异步路径与重建
//     路径对「旧偏好必须移除」的口径一致。
//  5. 空画像起点：没有 profile 行时先补一行（seeds 空），让反馈能建立画像。
//
// F15 残留①②③：吸收入口现在是「领取 → 处理 → 归还」的租约协议：
//  - 领取（claim）是原子 UPDATE CAS：两个并发执行者（浏览器 + drain、双开标签页）只有
//    一个拿到候选，另一个看到 busy/unchanged 直接返回，**不调模型**。
//  - 领取失败（退避未到期）同样直接返回：退防窗口内浏览器刷新不重打模型。
//  - 完成提交（absorbed/failed）都带 lease_token 校验：租约过期被 drain 重领后，浏览器侧
//    迟到的提交写 0 行，不会覆盖 drain 的结果或污染退避档位。
export type ProfileAbsorbStatus = 'pending' | 'busy' | 'applied' | 'unchanged' | 'failed' | 'conflict';

export interface ProfileAbsorbResult {
  status: ProfileAbsorbStatus;
  pendingFeedbackId: number | null;
  updatedAt?: string;
}

const STATUSES: ProfileAbsorbStatus[] = ['pending', 'busy', 'applied', 'unchanged', 'failed', 'conflict'];

function normalizeStatusForIdle(status: string): ProfileAbsorbStatus {
  return (STATUSES as string[]).includes(status) ? status as ProfileAbsorbStatus : 'unchanged';
}

// 执行者身份：同一个函数服务浏览器触发（access.commit 的授权写事务）与 cron drain
// （无用户授权，直连 getSql 的写事务）。leaseToken 由调用方生成；write 由调用方提供
// 对应渠道的事务写入器。退避重领检测：leaseToken 归还后重用即可（claim 会换成新 token）。
export async function absorbPendingProfileFeedback(deps: {
  userId: number;
  leaseToken: string;
  write: PersonalWriter;
  signal: AbortSignal;
  modelBudgetMs: number;
  leaseMs?: number;
}): Promise<ProfileAbsorbResult> {
  const { userId, leaseToken, write, signal, modelBudgetMs, leaseMs } = deps;
  // 领取（F15 残留①）：原子 CAS。拿不到（被并发执行者持有 / 退避未到期 / 没有 pending）
  // 都不调模型。queue 状态单独读一次供「busy」与「退避中」的区分展示。
  const candidate = await claimProfileFeedbackForUser(userId, leaseToken, leaseMs);
  if (candidate == null) {
    const queue = await getProfileFeedbackQueueForUser(userId);
    if (queue?.pendingFeedbackId == null) {
      return { status: normalizeStatusForIdle(queue?.status ?? 'unchanged'), pendingFeedbackId: null };
    }
    // 有 pending 但没领到：并发执行者已持有（busy）或退避未到期（failed——上一轮失败
    // 的退避窗口内，UI 提示「稍后自动重试」比「忙」准确）。
    return { status: (queue.nextEligibleAt ? 'failed' : 'busy'), pendingFeedbackId: queue.pendingFeedbackId };
  }

  // 预算耗尽：不调用模型，保留 pending 供下次机会重放（失败不丢事件）。
  // 这里记一次带退避的失败（租约持有者本人），让退避窗口内不重试。
  if (modelBudgetMs <= 0) {
    await markProfileFeedbackFailedForUser(userId, 'failed', 'DeadlineExceededError', write, leaseToken).catch(() => {});
    return { status: 'failed', pendingFeedbackId: candidate };
  }

  let profile = await getProfileForUser(userId);
  const [feedback, withdrawn] = await Promise.all([
    getProfileFeedbackForUser(userId),
    getWithdrawnFeedbackBookTitlesForUser(userId),
  ]);
  // 空画像起步（F15 ③）：没有 profile 行时先建占位行，拿到有效 updated_at 才能走 CAS 保存。
  if (!profile.updatedAt) {
    await ensureProfileForUser(userId, write);
    profile = await getProfileForUser(userId);
    if (!profile.updatedAt) {
      await markProfileFeedbackFailedForUser(userId, 'failed', 'ProfileRowMissing', write, leaseToken).catch(() => {});
      return { status: 'failed', pendingFeedbackId: candidate };
    }
  }

  // 既无有效反馈、也无撤回信号：这次 pending 对画像零影响，直接推进水位（不调模型）。
  if (!feedback.length && !withdrawn.length) {
    const completion = await markProfileFeedbackAbsorbedForUser(userId, candidate, 'unchanged', write, leaseToken);
    if (!completion.matched) return { status: 'conflict', pendingFeedbackId: candidate };
    const { pendingFeedbackId } = completion;
    return { status: pendingFeedbackId == null ? 'unchanged' : 'pending', pendingFeedbackId };
  }

  try {
    const { content: raw } = await chatRobust(
      profileAbsorbSystem(),
      profileAbsorbUser(profile.content, JSON.stringify(feedback), withdrawn),
      { temperature: 0.3, signal, onUsage: recordUsageAfterResponse('feedback'), totalTimeoutMs: modelBudgetMs },
    );
    const content = validateProfileContent(raw);
    const applied = content !== profile.content;
    // R3：同一事务先锁定租约，画像 CAS 与队列推进一起提交，旧租约不能先写画像。
    const completion = await completeProfileFeedbackForUser(
      userId, candidate, applied ? 'applied' : 'unchanged', content, profile.updatedAt, write, leaseToken,
    );
    if (completion.outcome === 'lostLease') {
      return { status: 'conflict', pendingFeedbackId: candidate };
    }
    if (completion.outcome === 'profileConflict') {
      // 其他写入者先改了画像：不覆盖，保留 pending 下次重放（旧实现这里会永久丢失）。
      await markProfileFeedbackFailedForUser(userId, 'conflict', 'ProfileConflict', write, leaseToken).catch(() => {});
      return { status: 'conflict', pendingFeedbackId: candidate };
    }
    const { pendingFeedbackId, updatedAt } = completion;
    return {
      // 吸收期间若又有新反馈把水位抬高，pendingFeedbackId 非空，状态如实回到 pending。
      status: pendingFeedbackId == null ? (applied ? 'applied' : 'unchanged') : 'pending',
      pendingFeedbackId,
      updatedAt,
    };
  } catch (error) {
    // 反馈本身已保存；这里只记阶段与错误类别，不落模型/数据库原文。保留 pending 供重放。
    console.error('反馈吸收画像失败，反馈已保存，等待重放', {
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown } | null)?.code ?? null,
    });
    await markProfileFeedbackFailedForUser(userId, 'failed', error instanceof Error ? error.name : 'Error', write, leaseToken).catch(() => {});
    return { status: 'failed', pendingFeedbackId: candidate };
  }
}
