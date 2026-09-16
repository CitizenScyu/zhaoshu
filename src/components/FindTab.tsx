'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Candidate, RerankedItem, VerifiedCandidate, FeedbackStatus } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';
import FeedbackForm from '@/components/FeedbackForm';
import ReadBookLink from '@/components/ReadBookLink';
import { isRecord } from '@/lib/sanitize';
import { EMPTY_HISTORY, historyKeyFor, historySnapshot, rememberQuery, subscribeHistory } from '@/lib/recent-queries';

// 找书三步的后端下行是真 SSE：事件 `data: <json>\n\n`。phase/progress 实时帧、
// result 结束帧、error 错误帧（带可识别 code）。SSE 断线/超时给用户可识别错误与重试入口。
type SseEvent = Record<string, unknown> & { type: string };
const FIND_FETCH_TIMEOUT_MS = 290_000; // 略低于 295s 路由上限，避免读到一半被平台掐掉

async function consumeFindSSE(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('找书响应为空，请重试');
  const reader = response.body.getReader();
  const race = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      race.throwIfAborted();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);
        const m = frame.match(/^data: (.+)$/m);
        if (!m) continue;
        let data: unknown;
        try { data = JSON.parse(m[1]); } catch { continue; }
        if (!isRecord(data) || typeof data.type !== 'string') continue;
        const type = data.type as string;
        if (type === 'error') {
          const e = new Error(typeof data.message === 'string' ? data.message : '找书失败，请重试');
          (e as Error & { code?: string }).code = typeof data.code === 'string' ? data.code : undefined;
          throw e;
        }
        onEvent(data as SseEvent);
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已取消或已关闭 */ }
  }
}

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

type Phase = 'idle' | 'recall' | 'verify' | 'rerank' | 'done' | 'error';

export default function FindTab() {
  const { apiFetch, user } = useOwner();
  const userId = user?.id ?? 0;
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
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [apiFetch]);
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
    setPhase('recall');
    setError('');
    setCandidates([]);
    setResults([]);
    setVerifyTotal(0);
    setVerifyDone(0);
    setSourceProgress(null);
    const controller = new AbortController();
    request.current = controller;

    // 勾选「仅本次有效」：本次输入走 conditions 通道（soft 约束、不写入长期画像/不入记忆）；
    // 未勾 = 长期通道（conditions 传空），行为同现状。
    const conditions = onlyThisTime ? q : '';
    const stepBody = (step: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      step, query: q, conditions, ...extra,
    });

    try {
      // 1) recall：消费流，拿到 candidates。
      const recalled = await fetchStepResult<Candidate[]>(
        controller.signal,
        () => apiFetch('/api/find', {
          signal: controller.signal, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stepBody('recall'),
        }),
        'candidates',
      );
      setCandidates(recalled);
      setPhase('verify');

      // 2) verify：实时 progress 帧更新进度；结束帧返回 verified。
      const verified = await fetchStepResult<VerifiedCandidate[]>(
        controller.signal,
        () => apiFetch('/api/find', {
          signal: controller.signal, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stepBody('verify', { candidates: recalled }),
        }),
        'verified',
      );
      setPhase('rerank');

      // 3) rerank：结束帧带 items（+persisted）。
      const items = await fetchStepResult<RerankedItem[]>(
        controller.signal,
        () => apiFetch('/api/find', {
          signal: controller.signal, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stepBody('rerank', { verified }),
        }),
        'items',
      );
      setResults(items);
      setPhase('done');
    } catch (e) {
      if (controller.signal.aborted) return;
      // SSE 断线/超时/后端 error 帧都带可识别 code，提示里给用户可操作重试入口。
      const code = (e as Error & { code?: string }).code;
      const base = e instanceof Error ? e.message : '未知错误';
      setError(code ? `${base}（${code}）` : base);
      setPhase('error');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  // 发送一步并取得它的 result 帧；同时把实时 progress/phase 帧喂给页面进度。
  async function fetchStepResult<T>(
    signal: AbortSignal,
    doFetch: () => Promise<Response>,
    field: 'candidates' | 'verified' | 'items',
  ): Promise<T> {
    const event = await fetchResultEvent(signal, doFetch);
    if (!Array.isArray(event[field])) throw new Error('找书结果不完整，请重试');
    return event[field] as T;
  }

  async function fetchResultEvent(
    signal: AbortSignal,
    doFetch: () => Promise<Response>,
  ): Promise<SseEvent & { [k: string]: unknown }> {
    const res = await doFetch();
    signal.throwIfAborted();
    if (!res.ok || !/text\/event-stream/i.test(res.headers.get('content-type') ?? '')) {
      const data = await res.json().catch(() => ({}));
      signal.throwIfAborted();
      throw new Error((data as { error?: string }).error || '找书失败，请重试');
    }
    const race = AbortSignal.any([signal, AbortSignal.timeout(FIND_FETCH_TIMEOUT_MS)]);
    return await new Promise<SseEvent & { [k: string]: unknown }>((resolve, reject) => {
      void consumeFindSSE(res, race, FIND_FETCH_TIMEOUT_MS, (event) => {
        if (event.type === 'result') {
          resolve(event);
        } else if (event.type === 'progress' && event.step === 'verify') {
          setVerifyTotal(typeof event.total === 'number' ? event.total : 0);
          setVerifyDone(typeof event.done === 'number' ? event.done : 0);
          if (event.provider === 'source') setSourceProgress({
            done: typeof event.sourceDone === 'number' ? event.sourceDone : 0,
            total: typeof event.sourceTotal === 'number' ? event.sourceTotal : 0,
          });
        } else if (event.type === 'phase' && event.step === 'verify') {
          setVerifyTotal(typeof event.total === 'number' ? event.total : 0);
        }
      }).catch((e) => reject(e instanceof Error ? e : new Error('找书失败，请重试')));
    });
  }

  const busy = phase === 'recall' || phase === 'verify' || phase === 'rerank';
  const steps: { key: Phase; label: string }[] = [
    { key: 'recall', label: `召回${candidates.length ? ` ${candidates.length} 本` : ''}` },
    { key: 'verify', label: sourceProgress ? `书源补验 ${sourceProgress.done}/${sourceProgress.total}` : `豆瓣验证${verifyTotal ? ` ${verifyDone}/${verifyTotal}` : ''}` },
    { key: 'rerank', label: '按画像重排' },
  ];

  return (
    <div>
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
        <p role="alert" className="mt-6 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ✗ {error}
        </p>
      )}

      {/* 结果 */}
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
