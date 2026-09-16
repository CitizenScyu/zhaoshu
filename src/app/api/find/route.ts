import { NextRequest, NextResponse } from 'next/server';
import { chatRobust, configuredAttemptTimeoutMs, configuredFallbackModel, configuredTotalTimeoutMs, parseJson, LlmError } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { verifyBatch } from '@/lib/douban';
import { supplementSourceEvidence } from '@/lib/source-verification';
import {
  ensureSchema,
  getExcludedBookKeysForUser,
  getExcludedBookTitlesForUser,
  getProfileForUser,
  persistRecommendationsForUser,
} from '@/lib/db';
import { boundedString, readJsonBody } from '@/lib/http';
import {
  bookKey,
  isRecord,
  MAX_CANDIDATES,
  MAX_RERANKED_ITEMS,
  sanitizeCandidates,
  sanitizeRerankedItems,
  sanitizeVerified,
} from '@/lib/sanitize';
import { withFindAccess, personalError } from '@/lib/personal-request';
import {
  recallSystem,
  recallUser,
  rerankSystem,
  rerankUser,
} from '@/lib/prompts';
import type { VerifiedCandidate } from '@/lib/types';
import { DeadlineExceededError, MODEL_ROUTE_INTERNAL_BUDGET_MS } from '@/lib/deadline';

export const maxDuration = 295;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 1_000;
const MAX_CONDITIONS_LENGTH = 1_000;
// 模型子预算：在内部预算里预留写回，并向一次回调分配剩余时间，避免最后时刻被模型/写回吃光。
// 可用额 = 285s 内部预算 − 12s 写回 reserve = 273s；ceiling 取 260s 留 13s 余量。
// 上游是推理模型，思考链会把单步拉到 190s 上下，旧的 220s 会稳定截断。
const MODEL_CEILING_MS = 260_000;

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

// 剩余预算低于这个值就放弃第二次尝试——一次上游往返至少要留下可用的时间。
const MIN_SECOND_ATTEMPT_MS = 5_000;

// 单步模型调用的恢复路径。只有一次额外尝试，且两次共享同一个截止时间：
// 总耗时绝不超过 budgetMs，重试不重获整份预算（deadline 不变量）。
//
// 第一次尝试拿**满**整步预算，不预切：上游推理模型「正常但慢」是最常见的失败模式
// （实测单步 190s 上下），预切预算会把本来能成功的调用硬切掉，还会顺带耗光
// chatRobust 内部重试的余量。恢复只发生在「第一次没花完整步预算就结束」的情形：
// - 正文解析不出预期结构（parseJson / modelList 在 chatRobust 之外，不会触发它的重试）；
// - 模型调用抛可重试错误（超时、上游 5xx）且剩余预算够。
// 不可重试的模型错误（密钥、取消、内容过滤）重试没有意义，直接上抛。
async function modelStep<T>(
  budgetMs: number,
  call: (totalTimeoutMs: number) => Promise<string>,
  parse: (content: string) => T,
): Promise<T> {
  const stepDeadline = Date.now() + budgetMs;
  const remainingMs = () => stepDeadline - Date.now();

  let content: string;
  try {
    content = await call(budgetMs);
  } catch (error) {
    if (error instanceof LlmError && !error.retryable) throw error;
    const left = remainingMs();
    if (left < MIN_SECOND_ATTEMPT_MS) throw error;
    return parse(await call(left));
  }

  try {
    return parse(content);
  } catch (error) {
    const left = remainingMs();
    if (left < MIN_SECOND_ATTEMPT_MS) throw error;
    return parse(await call(left));
  }
}

// 三步流水线由前端分步调用：recall → verify → rerank
// 每步都独立控制在函数时限内，前端可以展示进度

export async function POST(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    const { userId } = access.principal;
    const deadline = access.deadline;
    const atomicRead = access.run;
    const body = await atomicRead(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    if (!body?.step) return NextResponse.json({ error: 'missing step' }, { status: 400 });
    const step = body.step;
    // 找书的两个模型步骤都带上兜底模型，让主模型卡住时用它顶替原本的「重试」那次机会，
    // 而不是让整次找书失败。降级只在**卡住**那一族失败触发：网关超时（524/408）、单次尝试
    // 的首字节或停滞上限到点、总超时。连接层失败（UPSTREAM_UNREACHABLE）刻意不降级——它
    // 重试极便宜且对所有模型一视同仁，换模型治不住，原地重试才对（判定见 llm.ts fallbackEligible）。
    // 兜底占用 chatRobust 原本的重试名额，所以单步上游调用次数上界不变（见 chatRobust 注释）。
    // 主模型（换上的快模型）路由级失败率 ≈10%：来自独立复测 n=10、CI 1.8–40%，点值无分辨力，
    // 只能当量级；其中约一半是本机→Cloudflare 某边缘 IP 的 TLS 路径问题、与模型无关，生产
    // Vercel 侧是否同样命中尚未验证。每次请求读一次配置，便于运维改 LLM_FALLBACK_MODEL 后
    // 立即生效。其它调用点（profile / feedback）刻意不传，保持既有行为中性。
    const fallbackModel = configuredFallbackModel();
    // 单次尝试上限（首字节 + 流内停滞，取同一个值）：524 要吃满 ~126s，不给单次尝试封顶的话
    // 它一次就能把整步预算啃光、兜底永远轮不到。上限只压主模型那一路，兜底只受共享截止时间约束。
    const attemptTimeoutMs = configuredAttemptTimeoutMs();
    const modelAttemptLimits = { idleTimeoutMs: attemptTimeoutMs, firstByteTimeoutMs: attemptTimeoutMs };
    const ms = () => {
      access.assertActive();
      const value = Math.min(deadline.modelBudgetMs(MODEL_CEILING_MS), configuredTotalTimeoutMs());
      if (value <= 0) throw new DeadlineExceededError(MODEL_ROUTE_INTERNAL_BUDGET_MS);
      return value;
    };
    return access.sse(async (emit) => {
      const fail = (code: string, message: string) => emit({ type: 'error', code, message });
      await atomicRead(ensureSchema);
      if (step === 'recall') {
        const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
        const conditions = boundedString(body.conditions, MAX_CONDITIONS_LENGTH) ?? '';
        if (!query) {
          fail('MISSING_QUERY', 'missing query');
          return;
        }
        emit({ type: 'phase', step: 'recall' });
        const profile = await atomicRead(() => getProfileForUser(userId));
        const excludedKeys = new Set([
          ...profile.seeds.filter((seed) => seed.author?.trim())
            .map((seed) => bookKey(seed.title, seed.author!)),
          ...(await atomicRead(() => getExcludedBookKeysForUser(userId))),
        ]);
        // 作者缺失时只按完整书名排除；仍用同一套 NFKC 规则，不误伤续篇。
        const excludedTitles = new Set(profile.seeds
          .filter((seed) => !seed.author?.trim())
          .map((seed) => bookKey(seed.title, '')));
        // 已读/弃书列表传给提示词做软约束，后端 filter 做硬约束
        const excludedBooks = [
          ...profile.seeds.map((seed) => ({ title: seed.title, author: seed.author ?? '' })),
          ...(await atomicRead(() => getExcludedBookTitlesForUser(userId))),
        ];
        const raw = await atomicRead(() => modelStep(
          ms(),
          async (totalTimeoutMs) => (await chatRobust(
            recallSystem(),
            recallUser(profile.content, query, excludedBooks, conditions),
            { temperature: 0.8, signal: access.signal, onUsage: recordUsageAfterResponse('find_recall'), totalTimeoutMs, fallbackModel, ...modelAttemptLimits },
          )).content,
          (content) => modelList(content, 'candidates', MAX_CANDIDATES),
        ));
        const candidates = sanitizeCandidates(raw)
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
        const infos = await atomicRead(() => verifyBatch(candidates, access.signal, (done) => {
          emit({ type: 'progress', step: 'verify', done, total: candidates.length });
        }));
        const doubanVerified: VerifiedCandidate[] = candidates.map((c, i) => ({
          ...c,
          douban: infos[i],
        }));
        const verified = await atomicRead(() => supplementSourceEvidence(doubanVerified, deadline, access.signal, (sourceDone, sourceTotal) => {
          emit({ type: 'progress', step: 'verify', done: candidates.length, total: candidates.length, provider: 'source', sourceDone, sourceTotal });
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
        const { content: profile } = await atomicRead(() => getProfileForUser(userId));
        const raw = await atomicRead(() => modelStep(
          ms(),
          async (totalTimeoutMs) => (await chatRobust(
            rerankSystem(),
            rerankUser(profile, query, JSON.stringify(verified), conditions),
            { temperature: 0.3, signal: access.signal, onUsage: recordUsageAfterResponse('find_rerank'), totalTimeoutMs, fallbackModel, ...modelAttemptLimits },
          )).content,
          (content) => modelList(content, 'items', MAX_RERANKED_ITEMS),
        ));
        // 用书名+作者关联，避免同名作品回填到错误的豆瓣条目。
        const byBook = new Map(verified.map((v) => [bookKey(v.title, v.author), v]));
        const items = sanitizeRerankedItems(raw)
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
              ...(source.sourceEvidence ? { sourceEvidence: source.sourceEvidence } : {}),
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
          await access.commit((write) => persistRecommendationsForUser(userId, query, items, write));
        } catch (e) {
          persisted = false;
          if (personalError(e).status !== 500) throw e;
          console.error('persist failed');
        }
        emit({ type: 'result', step: 'rerank', items, persisted });
        return;
      }

      fail('UNKNOWN_STEP', `unknown step: ${step}`);
    }, (error) => {
      if (error instanceof LlmError) return { status: 502, code: 'LLM_ERROR', message: error.message };
      if (error instanceof Error && error.message === 'DATABASE_URL is not set') {
        return { status: 503, code: 'DB_NOT_CONFIGURED', message: '数据库未配置（DATABASE_URL）' };
      }
      return personalError(error);
    });
  });
}
