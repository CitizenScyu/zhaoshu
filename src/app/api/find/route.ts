import { NextRequest, NextResponse } from 'next/server';
import { chatRobust, configuredAttemptTimeoutMs, configuredFallbackModel, configuredTotalTimeoutMs, parseJson, LlmError } from '@/lib/llm';
import { recordUsageAfterResponse } from '@/lib/record-llm-usage';
import { verifyBatch } from '@/lib/douban';
import { supplementSourceEvidence } from '@/lib/source-verification';
import {
  ensureSchema,
  canonicalBookKey,
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
import { issueVerifyTicket, readVerifyTicket, ticketSigningKey } from '@/lib/verify-ticket';
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
// 票据随整个请求体一起受 MAX_BODY_BYTES(64KB) 约束，这里再按同一上限做字段级封顶：
// 票据是 base64url(...)+'.'+base64url(...)，无空格，boundedString 的 trim 不影响它。
// 实测大小见 docs/../gpt-f01-report.md 第 2 节。
const MAX_VERIFY_TICKET_LENGTH = MAX_BODY_BYTES;
// 模型子预算：在内部预算里预留写回，并向一次回调分配剩余时间，避免最后时刻被模型/写回吃光。
// 可用额 = 285s 内部预算 − 12s 写回 reserve = 273s；ceiling 取 260s 留 13s 余量。
// 上游是推理模型，思考链会把单步拉到 190s 上下，旧的 220s 会稳定截断。
const MODEL_CEILING_MS = 260_000;

// 模型输出始终从 unknown 收窄；形状偏了也尽量收容——整份正文是已付费的输出，
// 丢掉它要赔上整步预算重跑，而真正的形状校验在下游（见下）。
function modelList(raw: string, field: 'candidates' | 'items', max: number): unknown[] {
  const parsed = parseJson(raw);
  // 根直接是数组是不同模型族常见的「少包一层」写法（兜底模型尤其容易），收容它；
  // 其余非对象根（字符串/数字/null）仍是上游格式错误，文案与 retryable 语义不变。
  if (!Array.isArray(parsed) && !isRecord(parsed)) {
    throw new LlmError('模型返回的 JSON 根节点必须是对象，请重试。', false);
  }
  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else {
    list = parsed[field];
    // 字段**缺失**时再尽力一次：若对象里**恰好只有一个**「值为非空数组」的属性，就认它是书单。
    // 覆盖的是「兜底模型用了别的字段名」这一族（task-50 推断的两个候选之一，正文不入库所以
    // 无法证实是哪一族）。条件刻意收窄到「恰好一个」：多个数组属性时无法判断哪个是书单，
    // 猜错会把无关数据当成候选。字段存在但不是数组（含 null）**不**走这条路——那是形态错误，
    // 不是命名差异。
    if (list === undefined) {
      const arrays = Object.values(parsed).filter((value) => Array.isArray(value) && value.length > 0);
      if (arrays.length === 1) list = arrays[0];
    }
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new LlmError('模型返回的书单字段或数量无效，请重试。', false);
  }
  // 数量超限截断而不是抛：下游 sanitizeCandidates / sanitizeRerankedItems 第一行就是
  // slice(0, MAX_CANDIDATES / MAX_RERANKED_ITEMS)。在这里为「数量」再抛一次是重复且更严格的
  // 校验，代价是丢掉整份输出并触发整步重跑（2026-09-17 那次 260.3s 失败）。空数组仍抛错——
  // 空不是「可收容」的形状。
  return list.length > max ? list.slice(0, max) : list;
}

// 剩余预算低于这个值就放弃第二次尝试——一次上游往返至少要留下可用的时间。
const MIN_SECOND_ATTEMPT_MS = 5_000;

// 软约束清单进 prompt 的条数上限（T57R-5）。excludedBooks 是喂给模型的**软约束**——
// 真正的排除由 excludedKeys / excludedTitles 两条硬过滤做（下面 filter 那两行，**不受本上限影响**，
// 排除集合始终完整）。但书架与反馈记录只增不减，不设上限的话这个列表会随用量线性膨胀、
// 把 prompt 越撑越大（每本一行，几百本时单这一段就几百行），而那属于纯浪费的输入 token。
// 取 50：正常用户的书架规模远小于它（实测样本里是个位数到几十），真超限时说明确实需要收敛；
// 截断后由 recallUser 追加一句「另有 X 本已排除」，避免模型把没列出的书当成没排除。
// 调这个数不影响任何控制流，只影响 prompt 长度。
const EXCLUDED_BOOKS_PROMPT_LIMIT = 50;

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

// 喂给重排模型的候选投影（task-55 T55-6）：why 与 sourceEvidence 在重排输出之后
// 一律用召回原件覆盖（见下面 byBook 回填），回传全文只是把 prompt 撑大——12 本候选的
// 合成样本上这两项占输入 JSON 的 45%。重排真正要看的信号是身份（title/author）、
// 题材字数与豆瓣外部证据，全部保留。
function rerankInput(verified: VerifiedCandidate[]) {
  return verified.map(({ title, author, category, wordCount, douban }) => ({
    title, author, category, wordCount, douban,
  }));
}

export async function POST(req: NextRequest) {
  return withFindAccess(req, MODEL_ROUTE_INTERNAL_BUDGET_MS, async (access) => {
    const { userId } = access.principal;
    const deadline = access.deadline;
    const atomicRead = access.run;
    const body = await atomicRead(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    if (!body?.step) return NextResponse.json({ error: 'missing step' }, { status: 400 });
    const step = body.step;

    // F01：rerank 的输入只认服务端签发的验证票据，不认 body.verified。
    // 票据在 verify 步由服务端签发（把 verified 嵌进 payload 并绑定 u/q/c/exp），这里只验票：
    // 缺失 / 篡改 / 过期 / 绑定不符 / 为他人签发 → 403，且**在进入 SSE 之前**就拒绝，
    // 不给伪造的 verified 任何到达模型或写库的机会。提前算好的 verified 复用给下面的 SSE 回调。
    let rerankVerified: VerifiedCandidate[] | null = null;
    if (step === 'rerank') {
      const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
      const conditions = boundedString(body.conditions, MAX_CONDITIONS_LENGTH) ?? '';
      const key = ticketSigningKey();
      if (!key) {
        // 无签名 key（既无 AUTH_SECURITY_SECRET 也无 APP_OWNER_TOKEN）：拒绝而不是放行。
        return NextResponse.json(
          { error: '验证票据服务不可用，请联系维护者。', code: 'VERIFY_TICKET_UNAVAILABLE' },
          { status: 503 },
        );
      }
      const ticket = boundedString(body.ticket, MAX_VERIFY_TICKET_LENGTH) ?? '';
      const payload = ticket ? readVerifyTicket(key, ticket, { userId, query, conditions }) : null;
      if (!payload) {
        return NextResponse.json(
          { error: '缺少或无效的验证票据，请重新执行验证步骤。', code: 'VERIFY_TICKET_INVALID' },
          { status: 403 },
        );
      }
      const verified = sanitizeVerified(payload.v);
      if (!query || verified.length === 0) {
        return NextResponse.json({ error: 'missing query or verified', code: 'MISSING_QUERY_OR_VERIFIED' }, { status: 400 });
      }
      rerankVerified = verified;
    }
    // 找书的两个模型步骤都带上兜底模型，让主模型卡住时用它顶替原本的「重试」那次机会，
    // 而不是让整次找书失败。降级只在**卡住**那一族失败触发：网关超时（524/408）、单次尝试
    // 的首字节或停滞上限到点、总超时。连接层失败（UPSTREAM_UNREACHABLE）刻意不降级——它
    // 重试极便宜且对所有模型一视同仁，换模型治不住，原地重试才对（判定见 llm.ts fallbackEligible）。
    // 兜底占用 chatRobust 原本的重试名额，所以单步上游调用次数上界不变（见 chatRobust 注释）。
    // 🔴 2026-09-17 起有一个例外：首字节超时（响应头 45s 内没到）会先**原地重发主模型一次**
    // 才降级，所以 chatRobust 内部最多 3 次上游调用、本步 modelStep 最多 2 次 → **单步最坏 6 次**
    // （此前 4 次）。重发拿的是共享 deadline 的剩余预算、仍带 45s 单次上限，所以整步墙钟不变，
    // 兜底可用预算从 ~215s 降到 ~170s（仍高于 opus 中位 115.8s）。判定见 llm.ts chatRobust。
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
        // 排除集合一次取回（P2-1）：keys 与书单两份消费都从这一次查询派生，
        // 不再对同一个 excludedBooksForUserQuery 各发一次往返。
        const excludedDbRows = await atomicRead(() => getExcludedBookTitlesForUser(userId));
        const excludedKeys = new Set([
          ...profile.seeds.filter((seed) => seed.author?.trim())
            .map((seed) => bookKey(seed.title, seed.author!)),
          ...excludedDbRows.map((row) => canonicalBookKey(row.title, row.author)),
        ]);
        // 作者缺失时只按完整书名排除；仍用同一套 NFKC 规则，不误伤续篇。
        const excludedTitles = new Set(profile.seeds
          .filter((seed) => !seed.author?.trim())
          .map((seed) => bookKey(seed.title, '')));
        // 已读/弃书列表传给提示词做软约束，后端 filter 做硬约束（后者不做任何截断）。
        // ⚠️ 种子书只是排在**最前**，并不豁免：MAX_SEEDS=100（profile/route.ts），种子 >50 时
        // 尾部那些同样会被截掉、同样计进「另有 X 本」。要保种子必进提示词，得给它们单独留额度，
        // 本轮不做（种子是用户显式锚点，但硬过滤仍然兜得住它们）。
        // ⚠️ 库查询 excludedBooksForUserQuery 没有 ORDER BY，所以这个顺序是「种子书在前 +
        // 库返回顺序」，不是严格时间序；上限只保证**大小**，不宣称「最近 N 本」。要按最近排序
        // 得改 user-data.ts 的查询（超出本任务的文件域）。
        const excludedBooksAll = [
          ...profile.seeds.map((seed) => ({ title: seed.title, author: seed.author ?? '' })),
          ...excludedDbRows,
        ];
        const excludedBooks = excludedBooksAll.slice(0, EXCLUDED_BOOKS_PROMPT_LIMIT);
        const excludedBooksOmitted = excludedBooksAll.length - excludedBooks.length;
        const raw = await atomicRead(() => modelStep(
          ms(),
          async (totalTimeoutMs) => (await chatRobust(
            recallSystem(),
            recallUser(profile.content, query, excludedBooks, conditions, excludedBooksOmitted),
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
        const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
        const conditions = boundedString(body.conditions, MAX_CONDITIONS_LENGTH) ?? '';
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
        // 签发票据：把 verified 嵌进 payload，绑 u/q/c/exp。key 不可用时不发票（rerank 会拒绝），
        // 保留 verified 字段以免前端大改；ticket 为新增字段。
        const key = ticketSigningKey();
        const ticket = key ? issueVerifyTicket(key, { userId, query, conditions, verified }) : null;
        emit({ type: 'result', step: 'verify', verified, ...(ticket ? { ticket } : {}) });
        return;
      }

      if (step === 'rerank') {
        const query = boundedString(body.query, MAX_QUERY_LENGTH) ?? '';
        const conditions = boundedString(body.conditions, MAX_CONDITIONS_LENGTH) ?? '';
        // 只信上面预检从票据解出的 verified；body.verified 完全不参与。
        const verified = rerankVerified!;
        emit({ type: 'phase', step: 'rerank', total: verified.length });
        const { content: profile } = await atomicRead(() => getProfileForUser(userId));
        const raw = await atomicRead(() => modelStep(
          ms(),
          async (totalTimeoutMs) => (await chatRobust(
            rerankSystem(),
            rerankUser(profile, query, JSON.stringify(rerankInput(verified)), conditions),
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
        // 身份归一在 user-data.ts 的查询构造器里做（写库边界唯一一处），
        // 回传给客户端的仍是召回阶段的原始拼写——这条契约由 route.test.ts 钉住。
        let persisted = true;
        try {
          deadline.assert();
          const written = await access.commit((write) => persistRecommendationsForUser(userId, query, items, write));
          // F09：写入行数与期望本数不符（身份/连接问题导致静默漏写）不得回报成功。
          if (written !== items.length) {
            persisted = false;
            console.error('persist row count mismatch', { expected: items.length, written });
          }
        } catch (e) {
          persisted = false;
          if (personalError(e).status !== 500) throw e;
          console.error('persist failed', e instanceof Error ? { message: e.message, name: e.name } : e);
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
