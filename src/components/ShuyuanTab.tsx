'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';

interface ShuyuanStats {
  total: number;
  active: number;
  disabled: number;
  collections: { id: number; title: string; count: number }[];
  refreshedAt: string | null;
}

export default function ShuyuanTab() {
  const { apiFetch } = useOwner();
  const [stats, setStats] = useState<ShuyuanStats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/shuyuan', { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '书源加载失败');
      setStats(data as ShuyuanStats);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : '书源加载失败');
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

  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setError('');
    try {
      const res = await apiFetch('/api/shuyuan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '刷新失败');
      setStats(data as ShuyuanStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : '刷新失败');
    } finally {
      setRefreshing(false);
      refreshInFlight.current = false;
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="text-lg font-bold">书源</h2>
        <button
          className="seal-button text-sm"
          onClick={() => void refresh()}
          disabled={refreshing || loading}
        >
          {refreshing ? '拉取中…' : '刷新合集'}
        </button>
        {stats?.refreshedAt && (
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            上次更新 {new Date(stats.refreshedAt).toLocaleString('zh-CN')}
          </span>
        )}
      </div>
      <p className="text-sm mt-2 leading-7" style={{ color: 'var(--ink-soft)' }}>
        从 yckceo.com 拉取最新的书源合集（去重合并），供找书时做存在性验证与试读。
        每天 04:00 自动更新一次，也可手动刷新；失效的书源会自动剔除出轮换。
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ✗ {error}
        </p>
      )}

      {loading && !stats && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>
      )}

      {stats && (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <span>共 <b>{stats.total}</b> 个源</span>
            <span style={{ color: 'var(--moss)' }}>可用 {stats.active}</span>
            <span style={{ color: 'var(--ink-faint)' }}>失效 {stats.disabled}</span>
          </div>
          {stats.collections.length > 0 ? (
            <div>
              <p className="text-sm mb-2" style={{ color: 'var(--ink-faint)' }}>来源合集</p>
              <div className="flex flex-wrap gap-2">
                {stats.collections.map((c) => (
                  <span key={c.id} className="chip text-xs">
                    {c.title}（{c.count}）
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--ink-faint)' }}>
              还没有书源数据，点「刷新合集」拉取。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
