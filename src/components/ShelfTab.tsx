'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FeedbackStatus, ShelfStatus } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';
import FeedbackForm from '@/components/FeedbackForm';
import ReadBookLink from '@/components/ReadBookLink';

interface ShelfItem {
  id: number;
  query: string;
  match_score: number | null;
  hit_likes: string[] | null;
  risks: string | null;
  reason: string | null;
  status: ShelfStatus;
  note: string;
  feedback_id?: number;
  created_at: string;
  title: string;
  author: string;
  douban_id: string | null;
  douban_rating: number | null;
  douban_rating_count: number | null;
  meta: { category?: string; wordCount?: string };
  read_task_id?: number | null;
}

const GROUPS: { key: ShelfStatus; label: string; color: string }[] = [
  { key: 'want', label: '想读', color: 'var(--dai)' },
  { key: 'reading', label: '在读', color: 'var(--gold)' },
  { key: 'done', label: '读完', color: 'var(--moss)' },
  { key: 'dropped', label: '弃书', color: 'var(--cinnabar)' },
  { key: 'new', label: '未处理', color: 'var(--ink-faint)' },
];

export default function ShelfTab() {
  const { apiFetch } = useOwner();
  const [items, setItems] = useState<ShelfItem[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; status: FeedbackStatus; clear?: boolean } | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/recommendations', { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '书架加载失败');
      setItems(data.recommendations);
    } catch (error) {
      if (signal?.aborted) return;
      setError(error instanceof Error ? error.message : '书架加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  // 两段式移除：先标记 confirm 高亮，再点一次才真正发 DELETE
  function askRemove(item: ShelfItem) {
    if (confirmId === item.id) {
      void doRemove(item);
    } else {
      setConfirmId(item.id);
      window.setTimeout(() => setConfirmId((cur) => (cur === item.id ? null : cur)), 3000);
    }
  }

  async function doRemove(item: ShelfItem) {
    setConfirmId(null);
    if (removing) return;
    setRemoving(true);
    setError('');
    try {
      const res = await apiFetch(`/api/shelf?id=${item.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '移除失败');
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : '移除失败');
    } finally {
      setRemoving(false);
    }
  }

  if (items === null && loading) {
    return (
      <div className="flex gap-1.5 py-10 justify-center">
        <span className="ink-drop" />
        <span className="ink-drop" style={{ animationDelay: '0.18s' }} />
        <span className="ink-drop" style={{ animationDelay: '0.36s' }} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {feedbackMessage && (
        <p role="status" className="text-sm" style={{ color: 'var(--moss)' }}>{feedbackMessage}</p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--cinnabar)' }}>
          <p>{error}</p>
          <button className="chip" onClick={() => void load()} disabled={loading || updating}>
            {loading ? '加载中…' : '重新加载'}
          </button>
        </div>
      )}
      {!error && items?.length === 0 && (
        <p className="text-sm py-10 text-center" style={{ color: 'var(--ink-faint)' }}>
          书架空空，先去「找书」跑一单
        </p>
      )}
      {GROUPS.map((g) => {
        const group = (items ?? []).filter((i) => (i.status || 'new') === g.key);
        if (group.length === 0) return null;
        return (
          <section key={g.key}>
            <h2 className="text-sm font-bold tracking-[0.25em] mb-3 pb-2 border-b border-dashed" style={{ borderColor: 'var(--line)', color: g.color }}>
              {g.label} · {group.length}
            </h2>
            <div className="space-y-2.5">
              {group.map((it, i) => (
                <div
                  key={it.id}
                  className="book-card px-5 py-3.5 pl-6 flex flex-wrap items-center gap-x-4 gap-y-3 ink-rise"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <div className="w-full sm:w-auto sm:flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="min-w-0 max-w-full font-bold break-words">{it.title}</span>
                      <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                        {it.author}
                        {it.meta?.category ? ` · ${it.meta.category}` : ''}
                        {it.douban_rating != null ? ` · 豆瓣 ${it.douban_rating}` : ''}
                      </span>
                    </div>
                    {it.reason && (
                      <p className="text-xs mt-1 break-words leading-5" style={{ color: 'var(--ink-soft)' }}>
                        {it.reason}
                      </p>
                    )}
                    {it.status !== 'new' && (
                      <p className="text-xs mt-2 break-words whitespace-pre-wrap leading-6" style={{ color: 'var(--ink-soft)' }}>
                        <span className="font-bold">反馈原因：</span>{it.note || '尚未填写'}
                      </p>
                    )}
                  </div>
                  <span className="text-xs shrink-0" style={{ color: 'var(--ink-faint)' }}>
                    {new Date(it.created_at).toLocaleDateString('zh-CN')}
                  </span>
                  {/* 状态切换 */}
                  <div className="flex flex-wrap gap-1.5 sm:shrink-0">
                    <ReadBookLink taskId={it.read_task_id} title={it.title} author={it.author} from="shelf" />
                    {(
                      [
                        ['want', '想读'],
                        ['reading', '在读'],
                        ['done', '完'],
                        ['dropped', '弃'],
                      ] as [FeedbackStatus, string][]
                    ).map(([st, label]) => (
                      <button
                        key={st}
                        className="chip text-xs"
                        style={
                          (it.status || 'new') === st
                            ? { borderColor: g.color, color: g.color }
                            : undefined
                        }
                        onClick={() => {
                          setEditing({ id: it.id, status: st });
                          setFeedbackMessage('');
                        }}
                        disabled={updating || loading || removing || it.status === st}
                        aria-label={`将${it.title}标记为${GROUPS.find((group) => group.key === st)?.label}`}
                      >
                        {label}
                      </button>
                    ))}
                    {it.status !== 'new' && (
                      <button
                        className="chip chip-dai text-xs"
                        disabled={updating || loading || removing}
                        aria-expanded={editing?.id === it.id}
                        onClick={() => {
                          if (it.status === 'new') return;
                          setEditing({ id: it.id, status: it.status });
                          setFeedbackMessage('');
                        }}
                      >
                        {it.note ? '编辑反馈' : '补充原因'}
                      </button>
                    )}
                    {it.status !== 'new' && it.note && (
                      <button
                        className="chip text-xs"
                        disabled={updating || loading || removing}
                        aria-label={`清除${it.title}的反馈原因，保留阅读状态`}
                        onClick={() => {
                          if (it.status !== 'new') setEditing({ id: it.id, status: it.status, clear: true });
                        }}
                      >
                        清除原因
                      </button>
                    )}
                    <button
                      className="chip text-xs"
                      style={
                        confirmId === it.id
                          ? { borderColor: 'var(--cinnabar)', color: 'var(--cinnabar)' }
                          : { color: 'var(--ink-faint)' }
                      }
                      onClick={() => askRemove(it)}
                      disabled={removing || loading || updating}
                      aria-label={
                        confirmId === it.id
                          ? `再次点击确认将${it.title}移出书架`
                          : `将${it.title}移出书架`
                      }
                    >
                      {confirmId === it.id ? '确认移除?' : '✕ 移除'}
                    </button>
                  </div>
                  {editing?.id === it.id && (
                    <FeedbackForm
                      key={`${it.id}-${editing.clear ? 'clear' : 'edit'}`}
                      title={it.title} author={it.author} status={editing.status}
                      initialSnapshot={{ version: it.feedback_id ?? 0, note: it.note, status: it.status === 'new' ? null : it.status }}
                      clearInitially={editing.clear}
                      onBusyChange={setUpdating}
                      onSaved={(note, profileUpdated) => {
                        setItems((current) => current?.map((entry) => entry.id === it.id ? { ...entry, status: editing.status, note } : entry) ?? null);
                        setEditing(null);
                        setFeedbackMessage(`「${it.title}」反馈已记录${profileUpdated ? '，画像已更新' : ''}`);
                        void load();
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
