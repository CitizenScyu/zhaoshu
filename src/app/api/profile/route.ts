import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getProfile, saveProfile } from '@/lib/db';
import { chatRobust, configuredTotalTimeoutMs, LlmError, MAX_PROFILE_LENGTH, validateProfileContent } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import {
  profileSystem,
  profileFromSeedsUser,
} from '@/lib/prompts';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import { hasInvalidDatabaseCharacters, sanitizeSeeds } from '@/lib/sanitize';
import { requireApiOwner } from '@/lib/auth';
import { createDeadline, DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS, raceDeadline } from '@/lib/deadline';
import type { ProfileSnapshot, SeedBook } from '@/lib/types';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEEDS = 100;
// 生成画像的模型子预算：在内部预算里预留写回，不足即不调用模型
const MODEL_CEILING_MS = 220_000;

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

// 从种子书单生成画像。
// LLM 生成改为流式：把首字节尽早推给浏览器，避免浏览器→Vercel 之间无首字节的空闲连接
// 被本地代理/中间网关在 60s 掐断（线上实测非流式 38.9s 单请求即触发）。结束帧带最终
// seeds/content/updatedAt，沿用 CAS 版本与 409 冲突语义；把最严苛的错误（模型输出非法/超时/
// 预算耗尽）升级成一个 JSON 的 `event:error` 事件，客户端据此在正常路径统一结算。
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
  const deadline = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
  const atomicRead = <T>(task: () => Promise<T>): Promise<T> =>
    raceDeadline(deadline.signal, task);
  try {
    await atomicRead(ensureSchema);
    const profile = await atomicRead(getProfile);
    if (profile.updatedAt !== expectedUpdatedAt) return conflict(undefined, profile);
    const sanitized = sanitizeSeeds(profile.seeds);
    if (sanitized.length === 0) {
      return NextResponse.json({ error: '先在下方填入种子书单' }, { status: 400 });
    }
    // 模型子预算：预留写回；前置读库耗时越多，留给模型越少，绝不重获整份预算
    const budgetMs = Math.min(deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
    if (budgetMs <= 0) {
      return NextResponse.json(
        { error: '请求预算已耗尽，请稍后重试。', code: 'DEADLINE_EXCEEDED' },
        { status: 504 },
      );
    }

    // 流式响应体：下行是真 SSE。
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (data: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        try {
          const { content: raw } = await chatRobust(
            profileSystem(),
            profileFromSeedsUser(JSON.stringify(sanitized, null, 2)),
            {
              temperature: 0.4,
              signal: req.signal,
              onUsage: recordUsageAfterResponse('profile'),
              totalTimeoutMs: budgetMs,
              onToken: (delta) => send({ type: 'token', content: delta }),
            },
          );
          if (req.signal.aborted) throw new LlmError('模型调用已取消。', false);
          const content = validateProfileContent(raw);
          deadline.assert();
          let updatedAt: string | null;
          try {
            updatedAt = await saveProfile(sanitized, content, expectedUpdatedAt);
          } catch (e) {
            console.error(e);
            throw e;
          }
          if (!updatedAt) {
            // 并发冲突：把冲突信息交给客户端（含本次生成稿，供比较后重存）。
            let current: ProfileSnapshot | null = null;
            try {
              current = await getProfile();
            } catch {
              console.error('profile conflict reload failed');
            }
            send({ type: 'conflict', code: 'PROFILE_CONFLICT', profile: current, draft: { seeds: sanitized, content } });
            return;
          }
          send({ type: 'done', seeds: sanitized, content, updatedAt });
        } catch (e) {
          send({ type: 'error', code: errorCode(e), message: errorMessage(e) });
        } finally {
          deadline.dispose();
          try {
            controller.close();
          } catch {
            // 已取消或已关闭，忽略。
          }
        }
      },
      cancel() {
        deadline.dispose();
        req.signal.throwIfAborted();
        return undefined;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    // 读库/校验/写回之外的处理阶段异常（如内部错误）：真流式已启动则只能靠事件收尾。
    console.error(e);
    if (e instanceof DeadlineExceededError) {
      return NextResponse.json(
        { error: '请求预算已耗尽，请稍后重试。', code: e.code },
        { status: 504 },
      );
    }
    if (e instanceof LlmError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  } finally {
    deadline.dispose();
  }
}

function errorCode(e: unknown): string {
  if (e instanceof DeadlineExceededError) return 'DEADLINE_EXCEEDED';
  if (e instanceof LlmError) return 'LLM_ERROR';
  return 'INTERNAL';
}

function errorMessage(e: unknown): string {
  if (e instanceof LlmError) return e.message;
  return '生成失败，请稍后重试。';
}
