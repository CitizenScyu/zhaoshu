'use client';

import { useState } from 'react';
import type { Candidate, RerankedItem, VerifiedCandidate, ShelfStatus } from '@/lib/types';

const EXAMPLES = [
  '类似《诡秘之主》的克苏鲁+升级流，主角要冷静理性',
  '慢热权谋文，文笔好，不要无脑爽',
  '单女主都市日常，轻松治愈，别有系统',
  '历史文，考据扎实，主角不圣母',
];

type Phase = 'idle' | 'recall' | 'verify' | 'rerank' | 'done' | 'error';

export default function FindTab() {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [results, setResults] = useState<RerankedItem[]>([]);
  const [error, setError] = useState('');

  async function run() {
    const q = query.trim();
    if (!q || phase === 'recall' || phase === 'verify' || phase === 'rerank') return;
    setPhase('recall');
    setError('');
    setResults([]);
    try {
      const r1 = await fetch('/api/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'recall', query: q }),
      });
      const d1 = await r1.json();
      if (!r1.ok) throw new Error(d1.error || '召回失败');
      setCandidates(d1.candidates);

      setPhase('verify');
      const r2 = await fetch('/api/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'verify', candidates: d1.candidates }),
      });
      const d2 = await r2.json();
      if (!r2.ok) throw new Error(d2.error || '验证失败');
      const verified: VerifiedCandidate[] = d2.verified;

      setPhase('rerank');
      const r3 = await fetch('/api/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'rerank', query: q, verified }),
      });
      const d3 = await r3.json();
      if (!r3.ok) throw new Error(d3.error || '重排失败');
      setResults(d3.items);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '未知错误');
      setPhase('error');
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
          placeholder="想看什么？越具体越好：题材、流派、主角性格、雷点……"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip hover:text-[var(--cinnabar)] transition-colors" onClick={() => setQuery(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <button className="seal-button text-sm" onClick={run} disabled={busy || !query.trim()}>
            {busy ? '寻径中…' : '找 书'}
          </button>
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>Ctrl+Enter 提交</span>
        </div>
      </div>

      {/* 进度 */}
      {busy && (
        <div className="mt-8 flex items-center gap-4">
          <div className="flex gap-1.5">
            <span className="ink-drop" />
            <span className="ink-drop" style={{ animationDelay: '0.18s' }} />
            <span className="ink-drop" style={{ animationDelay: '0.36s' }} />
          </div>
          <div className="flex gap-5 text-sm">
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

      {phase === 'error' && (
        <p className="mt-6 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ✗ {error}
        </p>
      )}

      {/* 结果 */}
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

function BookCard({ item, index }: { item: RerankedItem; index: number }) {
  const [noteFor, setNoteFor] = useState<ShelfStatus | null>(null);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);

  async function sendFeedback(status: ShelfStatus, noteText: string) {
    setSending(true);
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: item.title, author: item.author, status, note: noteText }),
      });
      setSaved(true);
      setNoteFor(null);
    } finally {
      setSending(false);
    }
  }

  const suspicious = (item as RerankedItem & { hallucinationRisk?: boolean }).hallucinationRisk;

  return (
    <article className="book-card pl-6 pr-5 py-5 ink-rise" style={{ animationDelay: `${0.1 + index * 0.07}s` }}>
      <div className="flex items-start gap-4">
        {/* 分数印章 */}
        <div
          className={`seal-outline w-14 h-14 shrink-0 flex-col ${item.matchScore < 40 || suspicious ? 'opacity-60' : ''}`}
        >
          <span className="text-xl font-bold leading-none">{item.matchScore}</span>
          <span className="text-[10px] tracking-widest mt-0.5">匹配</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-lg font-bold">{item.title}</h3>
            <span className="text-sm" style={{ color: 'var(--ink-faint)' }}>
              {item.author} · {item.category} · {item.wordCount}
            </span>
            {suspicious && (
              <span className="chip chip-risk">存在性存疑</span>
            )}
            {item.douban?.rating != null && (
              <a
                href={item.douban.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline underline-offset-2"
                style={{ color: 'var(--dai)' }}
              >
                豆瓣 {item.douban.rating}（{item.douban.ratingCount ?? '?'}人评价）
              </a>
            )}
            {item.douban && !item.douban.found && (
              <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                豆瓣未收录（网文常见）
              </span>
            )}
          </div>

          {(item.hitLikes?.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {item.hitLikes.map((h) => (
                <span key={h} className="chip chip-like">{h}</span>
              ))}
            </div>
          )}

          <p className="text-sm mt-2.5 leading-7" style={{ color: 'var(--ink-soft)' }}>
            <span style={{ color: 'var(--moss)' }}>荐</span>
            <span className="mx-1.5" style={{ color: 'var(--line)' }}>|</span>
            {item.why || item.reason}
          </p>
          {item.risks && (
            <p className="text-sm mt-1.5 leading-7" style={{ color: 'var(--ink-soft)' }}>
              <span style={{ color: 'var(--cinnabar)' }}>险</span>
              <span className="mx-1.5" style={{ color: 'var(--line)' }}>|</span>
              {item.risks}
            </p>
          )}
          <p className="text-sm mt-1.5 leading-7 font-bold">{item.reason}</p>

          {/* 反馈操作 */}
          {!saved ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-2 text-xs">
              {(
                [
                  ['want', '想读'],
                  ['reading', '在读'],
                  ['done', '读完'],
                  ['dropped', '弃书'],
                ] as [ShelfStatus, string][]
              ).map(([st, label]) => (
                <button
                  key={st}
                  className="chip hover:border-[var(--cinnabar)] hover:text-[var(--cinnabar)] transition-colors"
                  onClick={() => {
                    if (st === 'done' || st === 'dropped') setNoteFor(noteFor === st ? null : st);
                    else sendFeedback(st, '');
                  }}
                  disabled={sending}
                >
                  {label}
                </button>
              ))}
              {noteFor && (
                <span className="flex items-center gap-2 ml-2 flex-wrap">
                  <input
                    className="paper-input text-xs !py-1.5 !px-2.5 w-64"
                    placeholder={`为什么${noteFor === 'done' ? '读完' : '弃书'}？一句话，喂给画像`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && note.trim()) sendFeedback(noteFor, note.trim());
                    }}
                    autoFocus
                  />
                  <button
                    className="chip chip-dai"
                    onClick={() => sendFeedback(noteFor, note.trim())}
                    disabled={!note.trim() || sending}
                  >
                    记下
                  </button>
                </span>
              )}
            </div>
          ) : (
            <p className="mt-3.5 text-xs" style={{ color: 'var(--moss)' }}>
              ✓ 已记录到书架{note && '，画像已更新'}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
