import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfileFeedbackForUser, getProfileForUser, saveProfileForUser } from '@/lib/db';
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

export async function GET(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    return NextResponse.json(await access.run(() => getProfileForUser(access.principal.userId)));
  });
}

export async function PUT(req: NextRequest) {
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

export async function POST(req: NextRequest) {
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
    const feedback = resetFromSeeds ? [] : await access.run(() => getProfileFeedbackForUser(userId));
    const budgetMs = Math.min(access.deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
    if (budgetMs <= 0) throw new DeadlineExceededError(MODEL_ROUTE_INTERNAL_BUDGET_MS);
    return access.sse(async (send) => {
      const seedsJson = JSON.stringify(sanitized, null, 2);
      const { content: raw } = await access.run(() => chatRobust(
        resetFromSeeds ? profileSystem() : profileRebuildSystem(),
        resetFromSeeds
          ? profileFromSeedsUser(seedsJson)
          : profileRebuildUser(seedsJson, profile.content, JSON.stringify(feedback, null, 2)),
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
      // feedbackCount/resetFromSeeds 是本次重建的构成元信息：resetFromSeeds=true 明确
      // 表示「已忽略反馈积累、按种子覆盖重写」，供调用方提示用户。
      send({ type: 'done', seeds: sanitized, content, updatedAt,
        feedbackCount: feedback.length, resetFromSeeds });
    }, (error) => error instanceof LlmError
      ? { status: 502, code: 'LLM_ERROR', message: error.message } : personalError(error));
  });
}
