import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfileFeedbackForUser, getProfileForUser, getWithdrawnFeedbackBookTitlesForUserRaw, markProfileFeedbackAbsorbedUncheckedForUser, saveProfileForUser, absorbedWatermarkFor, feedbackForPrompt } from '@/lib/db';
import { chatRobust, configuredTotalTimeoutMs, LlmError, MAX_PROFILE_LENGTH, validateProfileContent } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import {
  profileSystem,
  profileFromSeedsUser,
  profileRebuildSystem,
  profileRebuildUser,
} from '@/lib/prompts';
import { boundedString, readJsonBody } from '@/lib/http';
import { hasInvalidDatabaseCharacters, sanitizeSeeds } from '@/lib/sanitize';
import { withFindAccess, personalError, type PersonalRequest } from '@/lib/personal-request';
import { DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';
import type { ProfileSnapshot, SeedBook } from '@/lib/types';
import { removedSeedBooks } from '@/lib/profile-seeds';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEEDS = 100;
// 生成画像的模型子预算：在内部预算里预留写回，不足即不调用模型。
// 可用额 = 285s 内部预算 − 12s 写回 reserve = 273s；ceiling 取 260s 留 13s 余量。
// 上游是推理模型，思考链会把单步拉到 190s 上下，旧的 220s 会稳定截断。
const MODEL_CEILING_MS = 260_000;

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !hasInvalidDatabaseCharacters(value);
}

async function conflict(access: PersonalRequest, draft?: { seeds: SeedBook[]; content?: string }, current?: ProfileSnapshot) {
  let profile = current ?? null;
  if (!profile) {
    try { profile = await access.run(() => getProfileForUser(access.principal.userId)); }
    catch { /* 重读失败仍交还本人的生成稿。 */ }
  }
  return NextResponse.json({ error: '画像已在其他页面更新，请比较后再保存。',
    code: 'PROFILE_CONFLICT', profile, ...(draft ? { draft } : {}),
  }, { status: 409 });
}

async function handleGET(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    return NextResponse.json(await access.run(() => getProfileForUser(access.principal.userId)));
  });
}

async function handlePUT(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const seeds = body?.seeds;
    if (!body || !Array.isArray(seeds) || seeds.length > MAX_SEEDS) {
      return NextResponse.json({ error: `seeds must be an array of at most ${MAX_SEEDS}` }, { status: 400 });
    }
    if (typeof body.content === 'string' && boundedString(body.content, MAX_PROFILE_LENGTH) === null) {
      return NextResponse.json({ error: 'content is too long' }, { status: 400 });
    }
    if (typeof body.content === 'string' && hasInvalidDatabaseCharacters(body.content)) {
      return NextResponse.json({ error: 'content contains invalid characters' }, { status: 400 });
    }
    const expectedUpdatedAt = body.updatedAt;
    if (!isVersion(expectedUpdatedAt)) {
      return NextResponse.json({ error: '读取画像后请携带原始 updatedAt 版本保存', code: 'PROFILE_VERSION_REQUIRED' }, { status: 400 });
    }
    const sanitized = sanitizeSeeds(seeds);
    if (sanitized.length !== seeds.length) {
      return NextResponse.json({ error: '每本种子书都必须填写书名' }, { status: 400 });
    }
    const draft = {
      seeds: sanitized,
      ...(typeof body.content === 'string' ? { content: boundedString(body.content, MAX_PROFILE_LENGTH) ?? '' } : {}),
    };
    const { userId } = access.principal;
    await access.run(ensureSchema);
    const profile = await access.run(() => getProfileForUser(userId));
    if (profile.updatedAt !== expectedUpdatedAt) return conflict(access, draft, profile);
    const removed = removedSeedBooks(profile.seeds, sanitized);
    if (removed.length && body.confirmSeedRemoval !== true) {
      return NextResponse.json({
        error: '种子书单包含移除项，请核对后确认保存。', code: 'PROFILE_SEEDS_CONFIRM_REQUIRED',
        removedTitles: removed.map((seed) => seed.title), profile, draft,
      }, { status: 409 });
    }
    const content = draft.content ?? profile.content;
    const updatedAt = await access.commit((write) => saveProfileForUser(userId, sanitized, content, expectedUpdatedAt, write));
    if (!updatedAt) return conflict(access, draft);
    return NextResponse.json({ ok: true, seeds: sanitized, content, updatedAt });
  });
}

async function handlePOST(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const expectedUpdatedAt = body?.updatedAt;
    if (!isVersion(expectedUpdatedAt)) return NextResponse.json({
      error: '读取画像后请携带原始 updatedAt 版本生成', code: 'PROFILE_VERSION_REQUIRED',
    }, { status: 400 });
    // resetFromSeeds：显式选择「只按种子从零重写」的旧行为，会覆盖反馈积累。
    // 缺省（false）= 在现有画像 + 本人最新有效反馈之上重建（F04 默认）。
    if (body?.resetFromSeeds !== undefined && typeof body.resetFromSeeds !== 'boolean') {
      return NextResponse.json({ error: 'resetFromSeeds must be a boolean' }, { status: 400 });
    }
    const resetFromSeeds = body?.resetFromSeeds === true;
    const { userId } = access.principal;
    await access.run(ensureSchema);
    const profile = await access.run(() => getProfileForUser(userId));
    if (profile.updatedAt !== expectedUpdatedAt) return conflict(access, undefined, profile);
    const sanitized = sanitizeSeeds(profile.seeds);
    if (!sanitized.length) return NextResponse.json({ error: '先在下方填入种子书单' }, { status: 400 });
    // 默认重建才读反馈；resetFromSeeds 走旧的纯种子路径，不读反馈（也不并入旧画像）。
    // withdrawn：曾 informative、最新已撤回的书名——旧画像里可能还留着这些偏好，
    // 必须把「已撤回」这一信号显式喂给模型，否则它会按「仍被证据支持」把旧结论留下。
    // F15：重建也走「与反馈吸收同一份最新反馈」的路径，因此重建成功后要把队列水位推到
    // 「本次重建已喂进去的反馈上界」，避免同一批反馈在异步吸收里再跑一次。
    // F41-F1：上界必须是**实喂上界**（两类里 id 更大的未喂行不得被清），不能是
    // getMaxFeedbackIdForUser——反馈查询有 LIMIT 50，全表 max id 几乎必然大于本次真喂
    // 进去的行。用它推水位会把第 51+ 本书标成已消费，而它们从未进过模型输入。
    const feedback = resetFromSeeds ? [] : await access.run(() => getProfileFeedbackForUser(userId));
    const withdrawnTitles = resetFromSeeds
      ? []
      : await access.run(() => getWithdrawnFeedbackBookTitlesForUserRaw(userId));
    const withdrawn = withdrawnTitles.map((row) => row.title);
    // 重建路径两类都是全量读：informative 只有 LIMIT 50 之内被真正喂给模型，
    // withdrawn 超过 50 的部分没有被告知 ⇒ 取 min，别把未覆盖的部分标成已吸收。
    const absorbedUpTo = resetFromSeeds ? 0 : absorbedWatermarkFor(feedback, withdrawnTitles, 'min');
    const budgetMs = Math.min(access.deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
    if (budgetMs <= 0) throw new DeadlineExceededError(MODEL_ROUTE_INTERNAL_BUDGET_MS);
    return access.sse(async (send) => {
      const seedsJson = JSON.stringify(sanitized, null, 2);
      const { content: raw } = await access.run(() => chatRobust(
        resetFromSeeds ? profileSystem() : profileRebuildSystem(),
        resetFromSeeds
          ? profileFromSeedsUser(seedsJson)
          : profileRebuildUser(seedsJson, profile.content, JSON.stringify(feedbackForPrompt(feedback), null, 2), withdrawn),
        { temperature: 0.4, signal: access.signal, onUsage: recordUsageAfterResponse('profile'),
          totalTimeoutMs: budgetMs, onToken: (delta) => send({ type: 'token', content: delta }) },
      ));
      const content = validateProfileContent(raw);
      const updatedAt = await access.commit((write) => saveProfileForUser(userId, sanitized, content, expectedUpdatedAt, write));
      if (!updatedAt) {
        let current: ProfileSnapshot | null = null;
        try { current = await access.run(() => getProfileForUser(userId)); }
        catch { /* 保留本人草稿，不读 owner 或其他用户画像。 */ }
        send({ type: 'conflict', code: 'PROFILE_CONFLICT', profile: current, draft: { seeds: sanitized, content } });
        return;
      }
      // 重建已把最新有效反馈并入画像 → 推进队列水位（best-effort：失败只会让同一批反馈
      // 被异步吸收重跑一次，幂等，不影响重建结果）。F41-F1：absorbedUpTo 是实喂上界
      // （两类的 min），在读取反馈后立即算出——重建期间新写入的反馈 id 更高，不会被清。
      if (absorbedUpTo > 0) {
        await access.commit((write) => markProfileFeedbackAbsorbedUncheckedForUser(
          userId, absorbedUpTo, content === profile.content ? 'unchanged' : 'applied', write,
        )).catch(() => {});
      }
      // feedbackCount/resetFromSeeds 是本次重建的构成元信息：resetFromSeeds=true 明确
      // 表示「已忽略反馈积累、按种子覆盖重写」，供调用方提示用户。
      send({ type: 'done', seeds: sanitized, content, updatedAt,
        feedbackCount: feedback.length, resetFromSeeds });
    }, (error) => error instanceof LlmError
      ? { status: 502, code: 'LLM_ERROR', message: error.message } : personalError(error));
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
export const PUT = withDbQuotaGuard(handlePUT);
export const POST = withDbQuotaGuard(handlePOST);
