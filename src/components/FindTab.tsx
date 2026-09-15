'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Candidate, RerankedItem, VerifiedCandidate, FeedbackStatus } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';
import FeedbackEditor from '@/components/FeedbackEditor';

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

const HISTORY_KEY = 'novel-finder-recent-queries';
const HISTORY_MAX = 6; // 存储上限
const HISTORY_SHOW = 4; // 同时展示的最近条数
const CHIP_TOTAL = 6; // chips 总数上限（最近 + 随机示例）

// ---- 最近搜索历史：localStorage 的最小外部 store（useSyncExternalStore 需要稳定快照）----
const EMPTY_HISTORY: string[] = [];
let historyCache: string[] | null = null;
const historyListeners = new Set<() => void>();

function loadHistory(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    if (Array.isArray(saved)) return saved.filter((q) => typeof q === 'string' && q);
  } catch {
    // 坏数据当没有
  }
  return [];
}

function getHistory(): string[] {
  if (historyCache === null) historyCache = loadHistory();
  return historyCache;
}

function subscribeHistory(listener: () => void) {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

function rememberQuery(q: string) {
  const next = [q, ...getHistory().filter((p) => p !== q)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 存不进就算了，不影响找书
  }
  historyCache = next;
  historyListeners.forEach((l) => l());
}

type Phase = 'idle' | 'recall' | 'verify' | 'rerank' | 'done' | 'error';

export default function FindTab() {
  const { apiFetch } = useOwner();
  const [query, setQuery] = useState('');
  const [conditions, setConditions] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [results, setResults] = useState<RerankedItem[]>([]);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [apiFetch]);
  const history = useSyncExternalStore(subscribeHistory, getHistory, () => EMPTY_HISTORY);

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
    const currentConditions = conditions.trim();
    if (!q || phase === 'recall' || phase === 'verify' || phase === 'rerank') return;
    rememberQuery(q);
    setPhase('recall');
    setError('');
    setCandidates([]);
    setResults([]);
    const controller = new AbortController();
    request.current = controller;
    try {
      const r1 = await apiFetch('/api/find', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'recall', query: q, conditions: currentConditions }),
      });
      const d1 = await r1.json();
      controller.signal.throwIfAborted();
      if (!r1.ok) throw new Error(d1.error || '召回失败');
      setCandidates(d1.candidates);

      setPhase('verify');
      const r2 = await apiFetch('/api/find', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'verify', candidates: d1.candidates }),
      });
      const d2 = await r2.json();
      controller.signal.throwIfAborted();
      if (!r2.ok) throw new Error(d2.error || '验证失败');
      const verified: VerifiedCandidate[] = d2.verified;

      setPhase('rerank');
      const r3 = await apiFetch('/api/find', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'rerank', query: q, conditions: currentConditions, verified }),
      });
      const d3 = await r3.json();
      controller.signal.throwIfAborted();
      if (!r3.ok) throw new Error(d3.error || '重排失败');
      setResults(d3.items);
      if (d3.persisted === false) {
        setError('推荐已生成，但保存到书架失败');
      }
      setPhase('done');
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : '未知错误');
      setPhase('error');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  const busy = phase === 'recall' || phase === 'verify' || phase === 'rerank';
  const steps: { key: Phase; label: string }[] = [
    { key: 'recall', label: `召回${candidates.length ? ` ${candidates.length} 本` : ''}` },
    { key: 'verify', label: '豆瓣验证' },
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
        <div className="border-l-2 pl-3" style={{ borderColor: 'var(--line)' }}>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <label htmlFor="find-conditions" className="text-sm font-bold">仅本次条件</label>
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              与长期画像分开，不会自动保存
            </span>
            {conditions && (
              <button type="button" className="chip text-xs ml-auto" onClick={() => setConditions('')}>
                清空本次条件
              </button>
            )}
          </div>
          <input
            id="find-conditions"
            className="paper-input text-sm w-full"
            value={conditions}
            onChange={(event) => setConditions(event.target.value)}
            placeholder="例如：这次想轻松一点、偏短篇、节奏快；这些是软意图，属性仍需核验"
          />
          <p className="text-xs mt-1.5 leading-5" style={{ color: 'var(--ink-faint)' }}>
            题材、节奏等用于本轮匹配；完结、字数、雷点等只有出现明确证据时才算已核验约束。
          </p>
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
            <BookCard key={`${it.title}-${i}`} item={it} index={i} apiFetch={apiFetch} />
          ))}
        </div>
      )}
    </div>
  );
}

function BookCard({
  item,
  index,
  apiFetch,
}: {
  item: RerankedItem;
  index: number;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const [noteFor, setNoteFor] = useState<FeedbackStatus | null>(null);
  const [savedNote, setSavedNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [profileUpdated, setProfileUpdated] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const feedbackInFlight = useRef(false);

  async function sendFeedback(status: FeedbackStatus, noteText: string) {
    if (feedbackInFlight.current) return;
    feedbackInFlight.current = true;
    setSending(true);
    setFeedbackError('');
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: item.title, author: item.author, status, note: noteText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '记录反馈失败');
      setSaved(true);
      setSavedNote(noteText);
      setProfileUpdated(data.profileUpdated === true);
      setNoteFor(null);
    } catch (e) {
      setFeedbackError(e instanceof Error ? e.message : '记录反馈失败');
    } finally {
      feedbackInFlight.current = false;
      setSending(false);
    }
  }

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
                  onClick={() => {
                    setNoteFor(noteFor === st ? null : st);
                    setFeedbackError('');
                  }}
                  aria-pressed={noteFor === st}
                  disabled={sending}
                >
                  {label}
                </button>
              ))}
              {feedbackError && (
                <p role="alert" className="w-full text-xs" style={{ color: 'var(--cinnabar)' }}>{feedbackError}</p>
              )}
              {noteFor && (
                <FeedbackEditor
                  key={noteFor}
                  status={noteFor}
                  busy={sending}
                  onSubmit={(note) => sendFeedback(noteFor, note)}
                  onCancel={() => { setNoteFor(null); setFeedbackError(''); }}
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
