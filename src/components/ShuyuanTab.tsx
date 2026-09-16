'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import type { ShuyuanAvailability, ShuyuanStats } from '@/lib/shuyuan';

const AVAILABILITY_LABELS: Record<ShuyuanAvailability, string> = {
  unprobed: '未探测', pending: '待核验', reachable: '最近探测可达', failed: '最近探测失败',
};

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
        从 yckceo.com 拉取书源合集并去重合并，尚未接入找书验证或试读。
        未知来源只保存资料和已有失败信息，不自动访问；规则变化后需要核验。自动检查仅限 book15.net，可达仅表示最近一次请求成功。
        计划每天自动更新一次，触发时间可能延迟；也可手动刷新。启用状态独立于探测结果。
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
          <div className="flex flex-wrap gap-6 text-sm" aria-label="书源状态统计">
            <span>共 <b>{stats.total}</b> 个源</span>
            <span>已启用 {stats.enabled}</span>
            <span style={{ color: 'var(--ink-faint)' }}>已禁用 {stats.disabled}</span>
            <span>未探测 {stats.unprobed}</span>
            <span style={{ color: 'var(--cinnabar)' }}>待核验 {stats.pending}</span>
            <span style={{ color: 'var(--moss)' }}>最近探测可达 {stats.reachable}</span>
            <span>最近探测失败 {stats.failed}</span>
          </div>
          {stats.sources.length > 0 && (
            <section aria-label="书源状态明细">
              <h3 className="text-sm font-bold mb-2">书源状态</h3>
              {stats.total > stats.sources.length && (
                <p className="text-xs mb-3" style={{ color: 'var(--ink-faint)' }}>
                  显示 {stats.sources.length} 条，优先列出待核验和曾失败的来源。
                </p>
              )}
              <ul className="space-y-3">
                {stats.sources.map((source) => (
                  <li key={source.url} className="border border-[var(--line)] rounded-lg p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{source.name || '未命名书源'}</b>
                      <span className="chip text-xs">{AVAILABILITY_LABELS[source.availability]}</span>
                      <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>{source.disabled ? '已禁用' : '已启用'}</span>
                    </div>
                    <p className="text-xs mt-2 break-all" style={{ color: 'var(--ink-faint)' }}>{source.url}</p>
                    {source.lastError && <p className="mt-2 break-words">保留的失败信息：{source.lastError}</p>}
                    {source.probeError && <p className="mt-1 break-words">最近探测：{source.probeError}</p>}
                    {source.checkedAt && <p className="text-xs mt-2">探测时间 {new Date(source.checkedAt).toLocaleString('zh-CN')}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
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
