import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, LlmError, MAX_PROFILE_LENGTH, validateProfileContent } from '@/lib/llm';
import {
  profileSystem,
  profileFromSeedsUser,
} from '@/lib/prompts';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import { hasInvalidDatabaseCharacters, sanitizeSeeds } from '@/lib/sanitize';
import { requireApiOwner } from '@/lib/auth';
import type { ProfileSnapshot, SeedBook } from '@/lib/types';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEEDS = 100;

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !hasInvalidDatabaseCharacters(value);
}

async function conflict(
  draft?: { seeds: SeedBook[]; content?: string },
  current?: ProfileSnapshot,
) {
  let profile = current ?? null;
  if (!profile) {
    try {
      profile = await getProfile();
    } catch {
      // 已确认冲突后，即使重读失败也必须把生成稿交还客户端。
      console.error('profile conflict reload failed');
    }
  }
  return NextResponse.json({
    error: '画像已在其他页面更新，请比较后再保存。',
    code: 'PROFILE_CONFLICT', profile, ...(draft ? { draft } : {}),
  }, { status: 409 });
}

export async function GET(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  try {
    await ensureSchema();
    const profile = await getProfile();
    return NextResponse.json(profile);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}

// 保存种子书单（可选同时保存画像正文，供人工修订用）
export async function PUT(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
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
  try {
    await ensureSchema();
    const profile = await getProfile();
    if (profile.updatedAt !== expectedUpdatedAt) return conflict(draft, profile);
    const content = draft.content ?? profile.content;
    const updatedAt = await saveProfile(sanitized, content, expectedUpdatedAt);
    if (!updatedAt) return conflict(draft);
    return NextResponse.json({ ok: true, seeds: sanitized, content, updatedAt });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}

// 从种子书单生成画像
export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof RequestBodyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 413 });
    }
    throw e;
  }
  const expectedUpdatedAt = body?.updatedAt;
  if (!isVersion(expectedUpdatedAt)) {
    return NextResponse.json({ error: '读取画像后请携带原始 updatedAt 版本生成', code: 'PROFILE_VERSION_REQUIRED' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const profile = await getProfile();
    if (profile.updatedAt !== expectedUpdatedAt) return conflict(undefined, profile);
    const sanitized = sanitizeSeeds(profile.seeds);
    if (sanitized.length === 0) {
      return NextResponse.json({ error: '先在下方填入种子书单' }, { status: 400 });
    }
    const raw = await chatRobust(
      profileSystem(),
      profileFromSeedsUser(JSON.stringify(sanitized, null, 2)),
      { temperature: 0.4, signal: req.signal },
    );
    if (req.signal.aborted) throw new LlmError('模型调用已取消。', false);
    const content = validateProfileContent(raw);
    const updatedAt = await saveProfile(sanitized, content, expectedUpdatedAt);
    if (!updatedAt) return conflict({ seeds: sanitized, content });
    return NextResponse.json({ seeds: sanitized, content, updatedAt });
  } catch (e) {
    if (e instanceof LlmError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
