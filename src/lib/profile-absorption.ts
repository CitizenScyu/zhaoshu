import type { PersonalWriter } from './personal-write';
import {
  claimProfileFeedbackForUser,
  completeProfileFeedbackForUser,
  ensureProfileForUser,
  getProfileFeedbackQueueForUser,
  getProfileForUser,
  getProfileFeedbackForUser,
  getWithdrawnFeedbackBookTitlesForUserRaw,
  absorbedWatermarkFor,
  feedbackForPrompt,
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
//  2. 合并：一次读取该用户**最多 MAX_PROFILE_FEEDBACK 条**「最新有效反馈」（F04 口径：
//     每本书只认最新一行，先取最新再判信息量）+ 撤回书目，一次模型调用覆盖队列里所有
//     pending——并发写两本书的反馈不会各触发一次互相打架的 CAS。
//     🔴 订正（F41-F1）：这里**不是**「全部」。两类查询都有 LIMIT（MAX_PROFILE_FEEDBACK），
//     超额的反馈要下一轮才喂。因此水位只能推到「本轮实喂上界」（F41-F1），绝不能推到
//     getMaxFeedbackIdForUser 或未经 min 收敛的 pending 上界。
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

  // 队列当前水位先读一次：它既是幂等恢复点（漏提交的重试从这里续），也是本轮查询的
  // afterId 下界。用 absorbed_feedback_id 而不是 candidate——candidate 是 enqueue 记的
  // **全表**上界，直接当查询下界会把未喂行整批跳过（那正是本任务修的漏行 bug）。
  // F41-F1：absorbed 是 GREATEST 语义的单调水位，等于「到目前确已喂过/已宣认的全部反馈」。
  const queueBefore = await getProfileFeedbackQueueForUser(userId);
  const lastCommittedUpperBound = queueBefore?.absorbedFeedbackId ?? 0;

  let profile = await getProfileForUser(userId);
  const [feedback, withdrawnRows] = await Promise.all([
    getProfileFeedbackForUser(userId, lastCommittedUpperBound),
    getWithdrawnFeedbackBookTitlesForUserRaw(userId),
  ]);
  const withdrawn = withdrawnRows.map((row) => row.title);
  // F41-F1：本轮实喂上界 = max(informative 实喂 max id, withdrawn 实喂 max id)。
  // 🔴 为什么改 min → max：informative 查询现在带 afterId（已喂上界）过滤，返回的是
  // 「自已喂上界之后新出现/新改口的 informative 行」；withdrawn 查询不带 afterId，返回的是
  // 「当前全部已撤回书目」。两者回答的是不同问题：
  //   - 若 withdrawn max < informative max：撤回书目id 更小说明它们在 informative 之后
  //     没有新动静，用 max 不会清掉它们（它们 id ≤ max，本来就在"已覆盖"范围内）。
  //   - 若 withdrawn max > informative max：撤回是**更新的证据**，必须告知模型——max 让
  //     水位跟着撤回走，informative 之后的撤回书目不会被 informative 的上界压掉。
  // 用 max 之后：水位 = 「本轮喂过的所有行里最大的 id」，任何 id ≤ 它的 informative 行
  // 都已进过输入（afterId 保证不漏），任何 id ≤ 它的撤回书目也已告知过（查询不带 afterId）。
  const fedUpperBound = absorbedWatermarkFor(feedback, withdrawnRows);
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
  // F41-F1：零行时 `fedUpperBound` 为 0，改用 candidate（pending 上界）。这里推进 candidate
  // **不会跳过未喂行**：本轮查询带 afterId（= 已喂上界）仍返回空，说明「已喂上界之上没有
  // 任何 informative 行」；而 withdrawn 查询不带 afterId 仍返回空，说明也没有撤回信号。
  // 两者皆空 ⇒ 已喂上界之上没有任何可喂的东西，candidate 记的那些行已无需处理。
  // （残留边界：撤回书目也有 LIMIT 50，单用户撤回书目超过 50 本时水位会被钉在第一批，
  //  见报告「已知取舍」§9.6——不在本次改动范围内。）
  const advanceTo = fedUpperBound > 0 ? fedUpperBound : candidate;
  if (!feedback.length && !withdrawn.length) {
    const completion = await markProfileFeedbackAbsorbedForUser(userId, advanceTo, 'unchanged', write, leaseToken);
    if (!completion.matched) return { status: 'conflict', pendingFeedbackId: candidate };
    const { pendingFeedbackId } = completion;
    return { status: pendingFeedbackId == null ? 'unchanged' : 'pending', pendingFeedbackId };
  }

  try {
    const { content: raw } = await chatRobust(
      profileAbsorbSystem(),
      profileAbsorbUser(profile.content, JSON.stringify(feedbackForPrompt(feedback)), withdrawn),
      { temperature: 0.3, signal, onUsage: recordUsageAfterResponse('feedback'), totalTimeoutMs: modelBudgetMs },
    );
    const content = validateProfileContent(raw);
    const applied = content !== profile.content;
    // R3：同一事务先锁定租约，画像 CAS 与队列推进一起提交，旧租约不能先写画像。
    const completion = await completeProfileFeedbackForUser(
      userId, advanceTo, applied ? 'applied' : 'unchanged', content, profile.updatedAt, write, leaseToken,
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
