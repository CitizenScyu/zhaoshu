import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, LlmError } from '@/lib/llm';
import {
  profileSystem,
  profileFromSeedsUser,
} from '@/lib/prompts';
import type { SeedBook } from '@/lib/types';

export const maxDuration = 300;

export async function GET() {
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
  const body = await req.json().catch(() => null);
  const seeds = body?.seeds;
  if (!Array.isArray(seeds)) {
    return NextResponse.json({ error: 'seeds must be an array' }, { status: 400 });
  }
  try {
    await ensureSchema();
    const { content: existing } = await getProfile();
    await saveProfile(
      sanitizeSeeds(seeds),
      typeof body.content === 'string' && body.content.trim() ? body.content.trim() : existing,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }
}

// 从种子书单生成画像
export async function POST(req: NextRequest) {
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

function sanitizeSeeds(seeds: unknown): SeedBook[] {
  return (seeds as SeedBook[])
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      author: s.author?.trim() || undefined,
      kind: s.kind === 'drop' ? 'drop' : 'love',
      reason: s.reason?.trim() || undefined,
    }));
}
