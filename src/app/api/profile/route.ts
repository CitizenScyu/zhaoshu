import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, LlmError } from '@/lib/llm';
import {
  profileSystem,
  profileFromSeedsUser,
} from '@/lib/prompts';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import { sanitizeSeeds } from '@/lib/sanitize';
import { requireApiOwner } from '@/lib/auth';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEEDS = 100;

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
      return NextResponse.json({ error: e.message }, { status: 413 });
    }
    throw e;
  }
  const seeds = body?.seeds;
  if (!body || !Array.isArray(seeds) || seeds.length > MAX_SEEDS) {
    return NextResponse.json({ error: `seeds must be an array of at most ${MAX_SEEDS}` }, { status: 400 });
  }
  if (typeof body.content === 'string' && boundedString(body.content, 5_000) === null) {
    return NextResponse.json({ error: 'content is too long' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const { content: existing } = await getProfile();
    const sanitized = sanitizeSeeds(seeds);
    if (sanitized.length !== seeds.length) {
      return NextResponse.json({ error: '每本种子书都必须填写书名' }, { status: 400 });
    }
    await saveProfile(
      sanitized,
      typeof body.content === 'string' ? (boundedString(body.content, 5_000) ?? '') : existing,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}

// 从种子书单生成画像
export async function POST(req: NextRequest) {
  const unauthorized = requireApiOwner(req);
  if (unauthorized) return unauthorized;
  try {
    await ensureSchema();
    const { seeds } = await getProfile();
    const sanitized = sanitizeSeeds(seeds);
    if (sanitized.length === 0) {
      return NextResponse.json({ error: '先在下方填入种子书单' }, { status: 400 });
    }
    const raw = await chatRobust(
      profileSystem(),
      profileFromSeedsUser(JSON.stringify(sanitized, null, 2)),
      { temperature: 0.4 },
    );
    await saveProfile(sanitized, raw.trim());
    return NextResponse.json({ content: raw.trim() });
  } catch (e) {
    if (e instanceof LlmError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error(e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
