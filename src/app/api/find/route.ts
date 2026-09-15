import { NextRequest, NextResponse } from 'next/server';
import { chatRobust, configuredTotalTimeoutMs, parseJson, LlmError } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { verifyBatch } from '@/lib/douban';
import {
  ensureSchema,
  getExcludedBookKeys,
  getExcludedBookTitles,
  getProfile,
  persistRecommendations,
} from '@/lib/db';
import { boundedString, readJsonBody, RequestBodyError } from '@/lib/http';
import {
  bookKey,
  isRecord,
  MAX_CANDIDATES,
  MAX_RERANKED_ITEMS,
  sanitizeCandidates,
  sanitizeRerankedItems,
  sanitizeVerified,
} from '@/lib/sanitize';
import { requireApiOwner } from '@/lib/auth';
import {
  recallSystem,
  recallUser,
  rerankSystem,
  rerankUser,
} from '@/lib/prompts';
import type { VerifiedCandidate } from '@/lib/types';
import { createDeadline, DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS, raceDeadline } from '@/lib/deadline';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 1_000;
const MAX_CONDITIONS_LENGTH = 1_000;
// 模型子预算：在内部预算里预留写回，并向一次回调分配剩余时间，避免最后时刻被模型/写回吃光。
const MODEL_CEILING_MS = 220_000;

// 模型输出始终从 unknown 收窄；数量异常也属于上游错误，不能当成内部 500。
function modelList(raw: string, field: 'candidates' | 'items', max: number): unknown[] {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    throw new LlmError('模型返回的 JSON 根节点必须是对象，请重试。', false);
  }
  const list = parsed[field];
  if (!Array.isArray(list) || list.length === 0 || list.length > max) {
    throw new LlmError('模型返回的书单字段或数量无效，请重试。', false);
  }
  return list;
}

// 三步流水线由前端分步调用：recall → verify → rerank
// 每步都独立控制在函数时限内，前端可以展示进度

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
  if (!body?.step) {
    return NextResponse.json({ error: 'missing step' }, { status: 400 });
  }
  const step = body.step as string;
  const deadline = createDeadline(MODEL_ROUTE_INTERNAL_BUDGET_MS);
  // 模型子预算：预留写回、受 ceiling 约束，并尊重运维配置的总时限（生产默认 280s > 273s，deadline 生效）
  const ms = () => Math.min(deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
  const atomicRead = <T>(task: () => Promise<T>): Promise<T> =>
    raceDeadline(deadline.signal, task);

  // 找书三步各是一个 SSE 流：阶段/进度实时推帧，首字节尽早到浏览器，避免本地代理
  // 60s 无首字节掐空闲连接（与 9.3 profile 同根因）。结束帧带最终结果，错误帧带可识别 code。
  const encoder = new TextEncoder();
  const send = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: unknown) => controller.enqueue(encoder.encode(send(data)));
      const fail = (code: string, message: string) => emit({ type: 'error', code, message });
      try {
        await atomicRead(ensureSchema);
        if (step === 'recall') {
          const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
          const conditions = boundedString(body.conditions, MAX_CONDITIONS_LENGTH) ?? '';
          if (!query) {
            fail('MISSING_QUERY', 'missing query');
            return;
          }
          emit({ type: 'phase', step: 'recall' });
          const profile = await atomicRead(getProfile);
          const excludedKeys = new Set([
            ...profile.seeds.filter((seed) => seed.author?.trim())
              .map((seed) => bookKey(seed.title, seed.author!)),
            ...(await atomicRead(getExcludedBookKeys)),
          ]);
          // 作者缺失时只按完整书名排除；仍用同一套 NFKC 规则，不误伤续篇。
          const excludedTitles = new Set(profile.seeds
            .filter((seed) => !seed.author?.trim())
            .map((seed) => bookKey(seed.title, '')));
          // 已读/弃书列表传给提示词做软约束，后端 filter 做硬约束
          const excludedBooks = [
            ...profile.seeds.map((seed) => ({ title: seed.title, author: seed.author ?? '' })),
            ...(await atomicRead(getExcludedBookTitles)),
          ];
          const { content: raw } = await chatRobust(
            recallSystem(),
            recallUser(profile.content, query, excludedBooks, conditions),
            { temperature: 0.8, signal: req.signal, onUsage: recordUsageAfterResponse('find_recall'), totalTimeoutMs: ms() },
          );
          const candidates = sanitizeCandidates(modelList(raw, 'candidates', MAX_CANDIDATES))
            .filter((candidate) =>
              !excludedKeys.has(bookKey(candidate.title, candidate.author)) &&
              !excludedTitles.has(bookKey(candidate.title, '')));
          if (candidates.length === 0) {
            fail('LLM_ERROR', '召回结果为空，换个说法试试');
            return;
          }
          emit({ type: 'result', step: 'recall', candidates });
          return;
        }

        if (step === 'verify') {
          const candidates = sanitizeCandidates(body.candidates);
          if (candidates.length === 0) {
            fail('MISSING_CANDIDATES', 'missing candidates');
            return;
          }
          emit({ type: 'phase', step: 'verify', total: candidates.length });
          const infos = await verifyBatch(candidates, deadline.signal, (done) => {
            emit({ type: 'progress', step: 'verify', done, total: candidates.length });
          });
          const verified: VerifiedCandidate[] = candidates.map((c, i) => ({
            ...c,
            douban: infos[i],
          }));
          emit({ type: 'result', step: 'verify', verified });
          return;
        }

        if (step === 'rerank') {
          const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
          const conditions = boundedString(body.conditions, MAX_CONDITIONS_LENGTH) ?? '';
          const verified = sanitizeVerified(body.verified);
          if (!query || verified.length === 0) {
            fail('MISSING_QUERY_OR_VERIFIED', 'missing query or verified');
            return;
          }
          emit({ type: 'phase', step: 'rerank', total: verified.length });
          const { content: profile } = await atomicRead(getProfile);
          const { content: raw } = await chatRobust(
            rerankSystem(),
            rerankUser(profile, query, JSON.stringify(verified), conditions),
            { temperature: 0.3, signal: req.signal, onUsage: recordUsageAfterResponse('find_rerank'), totalTimeoutMs: ms() },
          );
          // 用书名+作者关联，避免同名作品回填到错误的豆瓣条目。
          const byBook = new Map(verified.map((v) => [bookKey(v.title, v.author), v]));
          const items = sanitizeRerankedItems(modelList(raw, 'items', MAX_RERANKED_ITEMS))
            .filter((it) => byBook.has(bookKey(it.title, it.author)))
            .map((it) => {
              const source = byBook.get(bookKey(it.title, it.author))!;
              return {
                ...it,
                // 使用输入作品的原始拼写，不因模型的等价写法产生新的数据库身份。
                title: source.title,
                author: source.author,
                // why/元数据以召回阶段的原始输出为准，不信重排的转述
                why: source.why,
                category: source.category,
                wordCount: source.wordCount,
                douban: source.douban,
              };
            })
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, MAX_RERANKED_ITEMS);
          if (items.length === 0) {
            fail('LLM_ERROR', '重排结果为空，换个说法试试');
            return;
          }

          // 持久化：books + recommendations（写回阶段用同一份预算，预算耗尽则停写）
          let persisted = true;
          try {
            deadline.assert();
            await persistRecommendations(query, items);
          } catch (e) {
            persisted = false;
            if (!(e instanceof DeadlineExceededError)) console.error('persist failed:', e);
          }
          emit({ type: 'result', step: 'rerank', items, persisted });
          return;
        }

        fail('UNKNOWN_STEP', `unknown step: ${step}`);
      } catch (e) {
        if (e instanceof LlmError) {
          fail('LLM_ERROR', e.message);
        } else if (e instanceof DeadlineExceededError) {
          fail(e.code, '请求预算已耗尽，请稍后重试。');
        } else if (e instanceof Error && e.message === 'DATABASE_URL is not set') {
          fail('DB_NOT_CONFIGURED', '数据库未配置（DATABASE_URL）');
        } else {
          console.error(e);
          fail('INTERNAL', 'internal error');
        }
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
}
