'use client';

import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { Candidate, RerankedItem, VerifiedCandidate, FeedbackStatus } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';
import FeedbackForm from '@/components/FeedbackForm';
import ReadBookLink from '@/components/ReadBookLink';
import { isRecord } from '@/lib/sanitize';
import { EMPTY_HISTORY, historyKeyFor, historySnapshot, rememberQuery, subscribeHistory } from '@/lib/recent-queries';
import { createElapsedTicker, recallProgressSuffix, retryLabel, retryStep, showRetry, type FindPhase, type FindStep } from '@/lib/find-progress';
// SSE 消费与落定判定放在纯模块里：本仓 vitest 只收 *.test.ts 且没有 jsdom，写在 JSX 闭包里的
// 超时/落定判定测不到（见 find-sse.test.ts）。
import { FIND_FETCH_TIMEOUT_MS, fetchFindResult, persistWarning, type SseEvent } from '@/lib/find-sse';
// 精确找书（task-77）：模式、状态机、文案全部在纯模块里，本文件只做 JSX 与请求编排。
import {
  EMPTY_EXACT_STATE,
  canSubmitExact,
  exactEmptyMessage,
  exactFallbackQuery,
  exactReducer,
  exactResultNote,
  initialShelfPhase,
  parseExactResponse,
  shelfButtonLabel,
  shelfOutcome,
  showExactEmpty,
  type ExactBook,
  type FindMode,
  type ShelfPhase,
} from '@/lib/find-exact';

// 找书三步的后端下行是真 SSE（phase/progress 实时帧、result 结束帧、error 错误帧）；
// 消费、超时与落定判定都在 @/lib/find-sse，本文件只负责编排与渲染。

// 示例池：每次进入页面随机抽几条，避免永远是同样几句
const EXAMPLE_POOL = [
  '类似《诡秘之主》的克苏鲁+升级流，主角要冷静理性',
  '慢热权谋文，文笔好，不要无脑爽',
  '单女主都市日常，轻松治愈，别有系统',
  '历史文，考据扎实，主角不圣母',
  '无限流团队作战，不要个人英雄主义',
  '仙侠文，世界观宏大，主角不圣母',
  '硬核科幻末世，拒绝恋爱脑',
  '脑洞大的诡异怪谈，单元剧结构',
  '克苏鲁风种田文，节奏慢没关系',
  '轻松吐槽流，类似大王饶命的味儿',
];

const HISTORY_SHOW = 4; // 同时展示的最近条数
const CHIP_TOTAL = 6; // chips 总数上限（最近 + 随机示例）

type Phase = FindPhase;

export default function FindTab() {
  const { apiFetch, user } = useOwner();
  const userId = user?.id ?? 0;
  // 默认仍是口味推荐：精确找书是新增入口，不改变现有用户习惯。
  const [mode, setMode] = useState<FindMode>('taste');
  // 最近搜索按身份分开；旧全局键只迁给已确认的 owner。
  const historyKey = useMemo(() => historyKeyFor(userId), [userId]);
  const [query, setQuery] = useState('');
  const [onlyThisTime, setOnlyThisTime] = useState(false); // 「仅本次有效」checkbox：默认不勾=长期
  const [verifyTotal, setVerifyTotal] = useState(0);
  const [verifyDone, setVerifyDone] = useState(0);
  const [sourceProgress, setSourceProgress] = useState<{ done: number; total: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [results, setResults] = useState<RerankedItem[]>([]);
  const [error, setError] = useState('');
  const [persistNote, setPersistNote] = useState(''); // result 帧 persisted=false：结果没存下来，必须说给用户
  const [recallSeconds, setRecallSeconds] = useState(0); // recall 阶段已等待秒数
  const [retryFrom, setRetryFrom] = useState<FindStep | null>(null); // 失败后可从哪一步起重试
  const request = useRef<AbortController | null>(null);
  // 中间产物与本次查询参数：verify 结束帧的 verified 不进 state，只放 ref 供 rerank 重试接力；
  // ticket 是服务端签发的验证票据（F01），rerank 必须回传它，服务端只认票据里的 verified。
  const verifiedRef = useRef<VerifiedCandidate[]>([]);
  const ticketRef = useRef('');
  const runCtxRef = useRef<{ q: string; conditions: string } | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [apiFetch]);

  // recall 阶段后端不发阶段推进事件，用前端计时器报「已等待 Xs」；phase 一变或组件卸载就清理，
  // 本仓出过卸载后 timer 还在跑的缺陷。
  useEffect(() => {
    if (phase !== 'recall') return;
    const ticker = createElapsedTicker({
      now: () => Date.now(),
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      onTick: setRecallSeconds,
    });
    ticker.start();
    return () => ticker.stop();
  }, [phase]);
  const history = useSyncExternalStore(subscribeHistory, () => historySnapshot(historyKey), () => EMPTY_HISTORY);

  const recent = history.slice(0, HISTORY_SHOW);
  // 示例补位：与历史不重复，用最近一次查询做种子轮转——纯函数可在渲染期安全计算，
  // 每搜一个新的需求，示例就换一批
  const pool = EXAMPLE_POOL.filter((ex) => !history.includes(ex));
  const seed = recent[0] ? [...recent[0]].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
  const rotate = pool.length > 0 ? seed % pool.length : 0;
  const examples = [...pool.slice(rotate), ...pool.slice(0, rotate)].slice(
    0,
    Math.max(2, CHIP_TOTAL - recent.length),
  );

  async function run() {
    const q = query.trim();
    if (!q || phase === 'recall' || phase === 'verify' || phase === 'rerank') return;
    rememberQuery(historyKey, q);
    // 勾选「仅本次有效」：本次输入走 conditions 通道（soft 约束、不写入长期画像/不入记忆）；
    // 未勾 = 长期通道（conditions 传空），行为同现状。
    runCtxRef.current = { q, conditions: onlyThisTime ? q : '' };
    await runFrom('recall');
  }

  // 失败重试：从失败那一步重来。recall/verify 已成功的产物直接从 state/ref 接力，
  // 不再为前面的步骤重复付 LLM 钱；全新查询仍从 recall 起。
  function retry() {
    if (!retryFrom || phase === 'recall' || phase === 'verify' || phase === 'rerank') return;
    void runFrom(retryFrom);
  }

  async function runFrom(start: FindStep) {
    const ctx = runCtxRef.current;
    if (!ctx) return;
    const { q, conditions } = ctx;
    const stepBody = (step: FindStep, extra: Record<string, unknown> = {}) => JSON.stringify({
      step, query: q, conditions, ...extra,
    });

    setError('');
    setRetryFrom(null);
    setPersistNote('');
    setPhase(start);
    let recalled: Candidate[] = start === 'recall' ? [] : candidates;
    let verified: VerifiedCandidate[] = start === 'rerank' ? verifiedRef.current : [];
    if (start === 'recall') {
      setCandidates([]);
      setResults([]);
      setRecallSeconds(0);
      verifiedRef.current = [];
      ticketRef.current = '';
    }
    if (start !== 'rerank') {
      setVerifyTotal(0);
      setVerifyDone(0);
      setSourceProgress(null);
    }
    const controller = new AbortController();
    request.current = controller;
    let at: FindStep = start; // 当前在跑哪一步：失败时据此决定重试起点

    try {
      // 1) recall：消费流，拿到 candidates。
      if (start === 'recall') {
        recalled = await fetchStepResult<Candidate[]>(
          controller.signal,
          () => apiFetch('/api/find', {
            signal: controller.signal, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: stepBody('recall'),
          }),
          'candidates',
        );
        setCandidates(recalled);
      }

      // 2) verify：实时 progress 帧更新进度；结束帧返回 verified 与服务端签发的 ticket。
      // ticket 必须保存：rerank 只回传票据，服务端不再信 body.verified（F01）。
      if (start !== 'rerank') {
        at = 'verify';
        setPhase('verify');
        const verifyEvent = await fetchFindResult(
          controller.signal,
          () => apiFetch('/api/find', {
            signal: controller.signal, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: stepBody('verify', { candidates: recalled }),
          }),
          FIND_FETCH_TIMEOUT_MS,
          onFindProgress,
        );
        if (!Array.isArray(verifyEvent.verified)) throw new Error('找书结果不完整，请重试');
        verified = verifyEvent.verified as VerifiedCandidate[];
        ticketRef.current = typeof verifyEvent.ticket === 'string' ? verifyEvent.ticket : '';
        verifiedRef.current = verified;
      }

      // 3) rerank：结束帧带 items（+persisted）。persisted=false 不丢结果，但书没存下来，
      // 必须让用户看见——否则写库失败被当成找书成功。请求只带 ticket，服务端用票内的 verified。
      at = 'rerank';
      setPhase('rerank');
      const resultEvent = await fetchFindResult(
        controller.signal,
        () => apiFetch('/api/find', {
          signal: controller.signal, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stepBody('rerank', { ticket: ticketRef.current }),
        }),
        FIND_FETCH_TIMEOUT_MS,
        onFindProgress,
      );
      if (!Array.isArray(resultEvent.items)) throw new Error('找书结果不完整，请重试');
      setResults(resultEvent.items as RerankedItem[]);
      setPersistNote(persistWarning(resultEvent) ?? '');
      setPhase('done');
    } catch (e) {
      if (controller.signal.aborted) return;
      // SSE 断线/超时/后端 error 帧都带可识别 code，提示里给用户可操作重试入口。
      const code = (e as Error & { code?: string }).code;
      const base = e instanceof Error ? e.message : '未知错误';
      setError(code ? `${base}（${code}）` : base);
      setRetryFrom(retryStep(at, { candidates: recalled.length, verified: verified.length }));
      setPhase('error');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  // 发送一步并取得它的 result 帧；同时把实时 progress/phase 帧喂给页面进度。
  // 超时/断流的落地判定都在 @/lib/find-sse 里（见 find-sse.test.ts）。
  async function fetchStepResult<T>(
    signal: AbortSignal,
    doFetch: () => Promise<Response>,
    field: 'candidates' | 'verified' | 'items',
  ): Promise<T> {
    const event = await fetchFindResult(signal, doFetch, FIND_FETCH_TIMEOUT_MS, onFindProgress);
    if (!Array.isArray(event[field])) throw new Error('找书结果不完整，请重试');
    return event[field] as T;
  }

  // 进度帧 → 页面进度。verify 的 x/y 与书源补验的进度都从这里进来。
  function onFindProgress(event: SseEvent) {
    if (event.type === 'progress' && event.step === 'verify') {
      setVerifyTotal(typeof event.total === 'number' ? event.total : 0);
      setVerifyDone(typeof event.done === 'number' ? event.done : 0);
      if (event.provider === 'source') setSourceProgress({
        done: typeof event.sourceDone === 'number' ? event.sourceDone : 0,
        total: typeof event.sourceTotal === 'number' ? event.sourceTotal : 0,
      });
    } else if (event.type === 'phase' && event.step === 'verify') {
      setVerifyTotal(typeof event.total === 'number' ? event.total : 0);
    }
  }

  const busy = phase === 'recall' || phase === 'verify' || phase === 'rerank';
  const steps: { key: Phase; label: string }[] = [
    { key: 'recall', label: `召回${candidates.length ? ` ${candidates.length} 本` : ''}${recallProgressSuffix(phase, recallSeconds)}` },
    { key: 'verify', label: sourceProgress ? `书源补验 ${sourceProgress.done}/${sourceProgress.total}` : `豆瓣验证${verifyTotal ? ` ${verifyDone}/${verifyTotal}` : ''}` },
    { key: 'rerank', label: '按画像重排' },
  ];

  return (
    <div>
      {/* 模式切换。两个面板都用 hidden 保持挂载：切回来时上一次的结果还在（同 page.tsx 的 tab）。
          精确找书是**独立入口**，不改动右边口味推荐的任何语义。 */}
      <div role="tablist" aria-label="找书模式" className="flex flex-wrap items-center gap-2 mb-5">
        {([['taste', '口味推荐'], ['exact', '精确找书']] as [FindMode, string][]).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            className={`chip ${mode === key ? 'chip-dai' : 'hover:text-[var(--cinnabar)]'} transition-colors`}
            style={mode === key ? { fontWeight: 700 } : undefined}
            onClick={() => setMode(key)}
          >
            {label}
          </button>
        ))}
        <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          {mode === 'taste'
            ? '描述你想看什么，模型按你的画像推荐。'
            : '按书名直搜，命中就是这一本，不打模型。'}
        </span>
      </div>

      <div hidden={mode !== 'taste'}>
      {/* 查询区 */}
      <div className="flex flex-col gap-3">
        <textarea
          className="paper-input text-[15px] leading-7 resize-none"
          rows={2}
          aria-label="找书需求"
          placeholder="想看什么？越具体越好：题材、流派、主角性格、雷点……"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
          }}
        />
        <div className="flex items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyThisTime}
              onChange={(e) => setOnlyThisTime(e.target.checked)}
              className="accent-[var(--cinnabar)]"
            />
            <span>仅本次有效</span>
          </label>
          <span style={{ color: 'var(--ink-faint)' }}>
            勾选后本次需求只用于本轮匹配，不写入长期画像/不进入记忆；默认长期记录。
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {recent.length > 0 && (
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>最近</span>
          )}
          {recent.map((q) => (
            <button key={q} className="chip hover:text-[var(--cinnabar)] transition-colors" onClick={() => setQuery(q)}>
              {q.length > 22 ? `${q.slice(0, 22)}…` : q}
            </button>
          ))}
          {examples.map((ex) => (
            <button key={ex} className="chip hover:text-[var(--cinnabar)] transition-colors" onClick={() => setQuery(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <button className="seal-button text-sm" onClick={run} disabled={busy || !query.trim()}>
            {busy ? '寻径中…' : '找 书'}
          </button>
        </div>
      </div>

      {/* 进度 */}
      {busy && (
        <div role="status" className="mt-8 flex flex-wrap items-center gap-4">
          <div className="flex gap-1.5">
            <span className="ink-drop" />
            <span className="ink-drop" style={{ animationDelay: '0.18s' }} />
            <span className="ink-drop" style={{ animationDelay: '0.36s' }} />
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {steps.map((s) => (
              <span
                key={s.key}
                style={{
                  color: phase === s.key ? 'var(--cinnabar)' : 'var(--ink-faint)',
                  fontWeight: phase === s.key ? 700 : 400,
                }}
              >
                {phase === s.key ? '◆ ' : '◇ '}
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {(phase === 'error' || error) && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm" style={{ color: 'var(--cinnabar)' }}>
            ✗ {error}
          </p>
          {showRetry(phase, retryFrom) && retryFrom && (
            <button
              className="chip hover:border-[var(--cinnabar)] hover:text-[var(--cinnabar)] transition-colors"
              onClick={retry}
              disabled={busy}
            >
              {retryLabel(retryFrom)}
            </button>
          )}
        </div>
      )}

      {/* 结果 */}
      {/* 写库失败（result 帧 persisted=false）：结果还在，但这批书没存下来，必须说清楚 */}
      {phase === 'done' && persistNote && (
        <p role="alert" className="mt-6 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ⚠ {persistNote}
        </p>
      )}
      {phase === 'done' && results.length === 0 && (
        <p role="status" className="mt-8 text-sm">本轮没有符合条件的书。</p>
      )}
      {results.length > 0 && (
        <div className="mt-8 space-y-4">
          {results.map((it, i) => (
            <BookCard key={`${it.title}-${i}`} item={it} index={i} />
          ))}
        </div>
      )}
      </div>

      <div hidden={mode !== 'exact'}>
        <ExactSearchSection
          onFallback={(next) => { setQuery(next); setMode('taste'); }}
        />
      </div>
    </div>
  );
}

// 精确找书面板（task-77）。状态机、文案选择、响应收窄全部来自 @/lib/find-exact——
// 本仓 vitest 没有 jsdom，写在 JSX 里的判定测不到。
function ExactSearchSection({ onFallback }: { onFallback: (query: string) => void }) {
  const { apiFetch } = useOwner();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [state, dispatch] = useReducer(exactReducer, EMPTY_EXACT_STATE);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [apiFetch]);

  async function search() {
    const q = title.trim();
    if (!canSubmitExact(state.phase, q)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    dispatch({ type: 'submit', title: q });
    try {
      const res = await apiFetch('/api/find/exact', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: q, author: author.trim() }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const message = isRecord(payload) && typeof payload.error === 'string' && payload.error
          ? payload.error : '精确找书失败，请重试';
        dispatch({ type: 'fail', message: `${message}（HTTP ${res.status}）` });
        return;
      }
      dispatch({ type: 'settle', result: parseExactResponse(payload) });
    } catch (e) {
      if (controller.signal.aborted) return;
      dispatch({ type: 'fail', message: e instanceof Error ? e.message : '精确找书失败，请重试' });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const busy = state.phase === 'searching';
  // 出路句用**本次提交**的书名，不是输入框当前值（用户可能已经改了框里的字）。
  const fallback = exactFallbackQuery(state);

  return (
    <div>
      <div className="flex flex-col gap-3">
        <input
          className="paper-input text-[15px] leading-7"
          aria-label="书名"
          placeholder="书名，例如：诡秘之主"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
        />
        <input
          className="paper-input text-sm"
          aria-label="作者（选填）"
          placeholder="作者（选填，同名书多时用来区分）"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="seal-button text-sm"
            onClick={() => void search()}
            disabled={!canSubmitExact(state.phase, title)}
          >
            {busy ? '检索中…' : '精确查找'}
          </button>
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            这里只输入书名，不要写口味描述（那属于「口味推荐」）。先查本地书库，没有再查豆瓣。
          </span>
        </div>
      </div>

      {busy && (
        <div role="status" className="mt-8 flex items-center gap-4">
          <div className="flex gap-1.5">
            <span className="ink-drop" />
            <span className="ink-drop" style={{ animationDelay: '0.18s' }} />
            <span className="ink-drop" style={{ animationDelay: '0.36s' }} />
          </div>
          <span className="text-sm">正在查本地书库与豆瓣…</span>
        </div>
      )}

      {state.phase === 'error' && (
        <p role="alert" className="mt-6 text-sm" style={{ color: 'var(--cinnabar)' }}>✗ {state.error}</p>
      )}

      {showExactEmpty(state) && state.result && (
        <div role="status" className="mt-8 flex flex-col gap-2">
          <p className="text-sm">{exactEmptyMessage(state.result)}</p>
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            也可以换个写法再试：去掉书名号或副标题，或把作者名填到下面一栏。
          </p>
          {fallback && (
            <button className="chip chip-dai self-start" onClick={() => onFallback(fallback)}>
              改用「口味推荐」找类似的书
            </button>
          )}
        </div>
      )}

      {state.result && state.result.items.length > 0 && (
        <div className="mt-8 space-y-4">
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>{exactResultNote(state.result)}</p>
          {state.result.items.map((item, i) => (
            <ExactBookCard key={`${item.source}-${item.doubanId ?? item.title}-${i}`} item={item} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// 精确找书的结果卡。复用 book-card / seal-outline 的既有视觉，但**不**沿用口味卡片的匹配分：
// 精确命中没有模型打分，编一个分数出来就是假信息，这里改放来源标记（书库 / 豆瓣）。
function ExactBookCard({ item, index }: { item: ExactBook; index: number }) {
  const { apiFetch } = useOwner();
  const [shelf, setShelf] = useState<ShelfPhase>(() => initialShelfPhase(item.onShelf));
  const [note, setNote] = useState('');

  async function addToShelf() {
    if (shelf === 'saving' || shelf === 'saved') return;
    setShelf('saving');
    setNote('');
    try {
      const res = await apiFetch('/api/find/exact/shelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: item.title, author: item.author }),
      });
      const outcome = shelfOutcome(res.status);
      setShelf(outcome);
      if (outcome === 'error') setNote(`加入书架失败（HTTP ${res.status}）`);
    } catch {
      setShelf('error');
      setNote('加入书架失败，请重试。');
    }
  }

  return (
    <article className="book-card pl-6 pr-5 py-5 ink-rise" style={{ animationDelay: `${0.1 + index * 0.07}s` }}>
      <div className="flex items-start gap-4">
        <div className="seal-outline w-14 h-14 shrink-0 flex-col">
          <span className="text-sm font-bold leading-none">{item.source === 'library' ? '书库' : '豆瓣'}</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-lg font-bold">{item.title}</h3>
            <span className="text-sm" style={{ color: 'var(--ink-faint)' }}>
              {item.author || '作者未知'}
              {item.category ? ` · ${item.category}` : ''}
              {item.wordCount ? ` · ${item.wordCount}` : ''}
            </span>
          </div>

          <p className="text-xs mt-1.5" style={{ color: 'var(--ink-faint)' }}>
            {item.source === 'library'
              ? '本地书库精确命中。'
              : '来自豆瓣检索；豆瓣条目多为出版版本，网文常无条目。'}
            {item.rating != null && ` 豆瓣评分 ${item.rating}`}
            {item.ratingCount != null && ` · ${item.ratingCount} 人评价`}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="chip hover:border-[var(--cinnabar)] hover:text-[var(--cinnabar)] transition-colors !inline-flex min-h-11 items-center !px-4"
              onClick={() => void addToShelf()}
              disabled={shelf === 'saving' || shelf === 'saved'}
              aria-pressed={shelf === 'saved'}
            >
              {shelfButtonLabel(shelf)}
            </button>
            {item.doubanUrl && (
              <a
                className="chip chip-dai !inline-flex min-h-11 items-center justify-center !px-4"
                href={item.doubanUrl}
                target="_blank"
                rel="noreferrer"
              >
                豆瓣条目 →
              </a>
            )}
            <ReadBookLink title={item.title} author={item.author} from="find" label="直接阅读" />
          </div>

          {note && <p className="mt-2 text-xs" role="alert" style={{ color: 'var(--cinnabar)' }}>{note}</p>}
        </div>
      </div>
    </article>
  );
}

function BookCard({
  item,
  index,
}: {
  item: RerankedItem;
  index: number;
}) {
  const [noteFor, setNoteFor] = useState<FeedbackStatus | null>(null);
  const [savedNote, setSavedNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [profileUpdated, setProfileUpdated] = useState(false);
  const [sending, setSending] = useState(false);

  const suspicious = item.hallucinationRisk;

  return (
    <article className="book-card pl-6 pr-5 py-5 ink-rise" style={{ animationDelay: `${0.1 + index * 0.07}s` }}>
      <div className="flex items-start gap-4">
        {/* 分数印章 */}
        <div
          className={`seal-outline w-14 h-14 shrink-0 flex-col ${item.matchScore < 40 || suspicious ? 'border-dashed' : ''}`}
        >
          <span className="text-xl font-bold leading-none">{item.matchScore}</span>
          <span className="text-[10px] tracking-widest mt-0.5">匹配分</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-lg font-bold">{item.title}</h3>
            <span className="text-sm" style={{ color: 'var(--ink-faint)' }}>
              {item.author} · {item.category}
            </span>
            {suspicious && (
              <span className="chip chip-risk">存在性存疑</span>
            )}
          </div>

          <p className="text-xs mt-1.5" style={{ color: 'var(--ink-faint)' }}>
            个人匹配排序分，来自模型判断，不是喜欢概率 · 字数/状态：{item.wordCount || '模型未提供'}（模型提供，待核验）
          </p>

          {item.douban && (
            <div
              className="mt-2 border-l-2 pl-3 text-xs leading-6"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}
            >
              <p className="font-bold" style={{ color: 'var(--ink)' }}>豆瓣外部验证证据</p>
              {item.douban.status === 'verified' && (
                <p>
                  {item.douban.url ? (
                    <a
                      href={item.douban.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                      style={{ color: 'var(--dai)' }}
                    >
                      已找到豆瓣条目
                    </a>
                  ) : '已找到豆瓣条目'}
                  {item.douban.rating != null ? ` · 评分 ${item.douban.rating}` : ' · 暂无评分'}
                  {item.douban.ratingCount != null ? ` · ${item.douban.ratingCount} 人评价` : ''}
                </p>
              )}
              {item.douban.status === 'not_found' && (
                <p>豆瓣未检索到条目，不等于作品不存在。</p>
              )}
              {item.douban.status === 'unavailable' && (
                <p>豆瓣验证暂不可用，本轮无法核验。</p>
              )}
              {item.douban.note && <p>验证说明：{item.douban.note}</p>}
            </div>
          )}

          {item.sourceEvidence && (
            <div className="mt-2 border-l-2 pl-3 text-xs leading-6" style={{ borderColor: 'var(--dai)', color: 'var(--ink-soft)' }}>
              <p className="font-bold" style={{ color: 'var(--dai)' }}>书源存在性补验</p>
              {item.sourceEvidence.status === 'matched' && <p>
                已找到匹配目录 · {item.sourceEvidence.sourceName}
                {item.sourceEvidence.url && <> · <a href={item.sourceEvidence.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">查看书源</a></>}
              </p>}
              <p>{item.sourceEvidence.note}</p>
            </div>
          )}

          <div className="mt-3"><ReadBookLink title={item.title} author={item.author} from="find" label="直接阅读" /></div>

          {(item.hitLikes?.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>模型推断的萌点命中</span>
              {item.hitLikes.map((h) => (
                <span key={h} className="chip chip-like">{h}</span>
              ))}
            </div>
          )}

          <p className="text-sm mt-2.5 leading-7" style={{ color: 'var(--ink-soft)' }}>
            <span style={{ color: 'var(--moss)' }}>召回理由（模型判断）</span>
            <span aria-hidden="true" className="mx-1.5" style={{ color: 'var(--line)' }}>|</span>
            {item.why || item.reason}
          </p>
          {item.risks && (
            <p className="text-sm mt-1.5 leading-7" style={{ color: 'var(--ink-soft)' }}>
              <span style={{ color: 'var(--cinnabar)' }}>风险（模型推断，待核验）</span>
              <span aria-hidden="true" className="mx-1.5" style={{ color: 'var(--line)' }}>|</span>
              {item.risks}
            </p>
          )}
          <p className="text-sm mt-1.5 leading-7 font-bold">
            <span className="font-normal" style={{ color: 'var(--ink-faint)' }}>模型结论：</span>{item.reason}
          </p>

          {/* 反馈操作 */}
          {!saved ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-2 text-xs">
              {(
                [
                  ['want', '想读'],
                  ['reading', '在读'],
                  ['done', '读完'],
                  ['dropped', '弃书'],
                ] as [FeedbackStatus, string][]
              ).map(([st, label]) => (
                <button
                  key={st}
                  className="chip hover:border-[var(--cinnabar)] hover:text-[var(--cinnabar)] transition-colors"
                  onClick={() => setNoteFor(st)}
                  aria-pressed={noteFor === st}
                  disabled={sending}
                >
                  {label}
                </button>
              ))}
              {noteFor && (
                <FeedbackForm
                  title={item.title} author={item.author} status={noteFor}
                  onBusyChange={setSending}
                  onSaved={(note, updated) => {
                    setSaved(true); setSavedNote(note); setProfileUpdated(updated); setNoteFor(null);
                  }}
                  onCancel={() => setNoteFor(null)}
                />
              )}
            </div>
          ) : (
            <div className="mt-3.5 text-xs">
              <p style={{ color: 'var(--moss)' }}>✓ 已记录到书架{profileUpdated && '，画像已更新'}</p>
              {savedNote && (
                <p className="mt-1 whitespace-pre-wrap break-words leading-6" style={{ color: 'var(--ink-soft)' }}>
                  {savedNote}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
