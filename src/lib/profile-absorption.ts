import type { PersonalWriter } from './personal-write';
import {
  ensureProfileForUser,
  getProfileForUser,
  getProfileFeedbackForUser,
  getProfileFeedbackQueueForUser,
  getWithdrawnFeedbackBookTitlesForUser,
  markProfileFeedbackAbsorbedForUser,
  markProfileFeedbackFailedForUser,
  saveProfileForUser,
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

export type ProfileAbsorbStatus = 'pending' | 'applied' | 'unchanged' | 'failed' | 'conflict';

export interface ProfileAbsorbResult {
  status: ProfileAbsorbStatus;
  pendingFeedbackId: number | null;
  updatedAt?: string;
}

const STATUSES: ProfileAbsorbStatus[] = ['pending', 'applied', 'unchanged', 'failed', 'conflict'];

function normalizeStatusForIdle(status: string): ProfileAbsorbStatus {
  return (STATUSES as string[]).includes(status) ? status as ProfileAbsorbStatus : 'unchanged';
}

export async function absorbPendingProfileFeedback(deps: {
  userId: number;
  write: PersonalWriter;
  signal: AbortSignal;
  modelBudgetMs: number;
}): Promise<ProfileAbsorbResult> {
  const { userId, write, signal, modelBudgetMs } = deps;
  const queue = await getProfileFeedbackQueueForUser(userId);
  // 没有队列行、或没有待处理事件：无可吸收，返回上一次的结果供用户侧显示。
  if (!queue) return { status: 'unchanged', pendingFeedbackId: null };
  if (queue.pendingFeedbackId == null) {
    return { status: normalizeStatusForIdle(queue.status), pendingFeedbackId: null };
  }
  const candidate = queue.pendingFeedbackId;

  // 预算耗尽：不调用模型，保留 pending 供下次机会重放（失败不丢事件）。
  if (modelBudgetMs <= 0) {
    await markProfileFeedbackFailedForUser(userId, 'failed', 'DeadlineExceededError', write).catch(() => {});
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
      await markProfileFeedbackFailedForUser(userId, 'failed', 'ProfileRowMissing', write).catch(() => {});
      return { status: 'failed', pendingFeedbackId: candidate };
    }
  }

  // 既无有效反馈、也无撤回信号：这次 pending 对画像零影响，直接推进水位（不调模型）。
  if (!feedback.length && !withdrawn.length) {
    const pendingFeedbackId = await markProfileFeedbackAbsorbedForUser(userId, candidate, 'unchanged', write);
    return { status: pendingFeedbackId == null ? 'unchanged' : 'pending', pendingFeedbackId };
  }

  try {
    const { content: raw } = await chatRobust(
      profileAbsorbSystem(),
      profileAbsorbUser(profile.content, JSON.stringify(feedback), withdrawn),
      { temperature: 0.3, signal, onUsage: recordUsageAfterResponse('feedback'), totalTimeoutMs: modelBudgetMs },
    );
    const content = validateProfileContent(raw);
    const updatedAt = await saveProfileForUser(userId, profile.seeds, content, profile.updatedAt, write);
    if (!updatedAt) {
      // 其他写入者先改了画像：不覆盖，保留 pending 下次重放（旧实现这里会永久丢失）。
      await markProfileFeedbackFailedForUser(userId, 'conflict', 'ProfileConflict', write).catch(() => {});
      return { status: 'conflict', pendingFeedbackId: candidate };
    }
    // 种子原样回传，"内容变了"就是这次真的改动了画像；CAS 命中不等于画像变了（模型可能原样返回）。
    const applied = content !== profile.content;
    const pendingFeedbackId = await markProfileFeedbackAbsorbedForUser(userId, candidate, applied ? 'applied' : 'unchanged', write);
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
    await markProfileFeedbackFailedForUser(userId, 'failed', error instanceof Error ? error.name : 'Error', write).catch(() => {});
    return { status: 'failed', pendingFeedbackId: candidate };
  }
}
