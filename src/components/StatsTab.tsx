'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import { TokenStatTile, TokenUsageDetails } from '@/components/TokenStats';
import type { StatsResponse as Stats } from '@/app/api/stats/route';

const SECTION_NAMES = { library: '书库', download: '下载', find: '找书', shelf: '书架', shuyuan: '书源', tokens: '模型用量' };

// 与 ShelfTab 的分组口径一致
const SHELF_STATUS: Record<string, { label: string; color: string }> = {
  want: { label: '想读', color: 'var(--dai)' },
  reading: { label: '在读', color: 'var(--gold)' },
  done: { label: '读完', color: 'var(--moss)' },
  dropped: { label: '弃书', color: 'var(--cinnabar)' },
  new: { label: '未处理', color: 'var(--ink-faint)' },
};

// 字数缩写：5540000 → 「554 万」、120000000 → 「1.2 亿」
function formatChars(n: number | undefined): string {
  if (n === undefined) return '不可用';
  if (!Number.isFinite(n) || n < 1e4) return String(Math.max(0, Math.round(n)));
  if (n < 1e8) {
    const wan = n / 1e4;
    return wan >= 100 ? `${Math.round(wan)} 万` : `${wan.toFixed(1).replace(/\.0$/, '')} 万`;
  }
  const yi = n / 1e8;
  return yi >= 100 ? `${Math.round(yi)} 亿` : `${yi.toFixed(2).replace(/\.?0+$/, '')} 亿`;
}

function StatTile({
  label,
  value,
  unit,
  note,
  strong = false,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="book-card px-4 py-4 sm:px-5">
      <dt className="text-xs tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </dt>
      <dd className="mt-2 leading-none">
        <span
          className={`text-3xl sm:text-4xl font-bold tabular-nums ${strong ? '' : 'ink-rise'}`}
          style={{ color: strong ? 'var(--cinnabar)' : 'var(--ink)' }}
        >
          {value}
        </span>
        {unit && <span className="text-sm ml-1" style={{ color: 'var(--ink-soft)' }}>{unit}</span>}
      </dd>
      {note && (
        <p className="text-xs mt-2 leading-5" style={{ color: 'var(--ink-faint)' }}>{note}</p>
      )}
    </div>
  );
}

export default function StatsTab() {
  const { apiFetch } = useOwner();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  async function exportData() {
    setExporting(true);
    setExportError('');
    try {
      const res = await apiFetch('/api/export', { cache: 'no-store' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || '数据导出失败，请稍后重试');
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
        || `shujing-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        // 给浏览器留出接收下载的时间，再释放临时 URL。
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '数据导出失败，请稍后重试');
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/stats', { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '统计加载失败');
      if (signal?.aborted) return;
      setStats(data as Stats);
    } catch (e) {
      if (signal?.aborted) return;
      setStats(null);
      setError(e instanceof Error ? e.message : '统计加载失败');
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

  const shelfTotal = stats?.shelf ? stats.shelf.statuses.reduce((sum, s) => sum + s.count, 0) : null;
  const unavailable = stats
    ? (Object.keys(SECTION_NAMES) as (keyof typeof SECTION_NAMES)[])
      .filter((key) => stats.sectionStates?.[key] === 'unavailable').map((key) => SECTION_NAMES[key])
    : [];

  const sectionValue = (section: keyof typeof SECTION_NAMES) =>
    stats?.sectionStates[section] === 'forbidden' ? '无权限'
      : stats?.sectionStates[section] === 'not_ready' ? '待开放' : '不可用';
  const sectionNote = (section: keyof typeof SECTION_NAMES) =>
    stats?.sectionStates[section] === 'forbidden' ? `当前账号无权查看${SECTION_NAMES[section]}分区`
      : stats?.sectionStates[section] === 'not_ready' ? `${SECTION_NAMES[section]}统计尚未开放`
        : `${SECTION_NAMES[section]}统计暂不可用`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="text-lg font-bold">统计</h2>
        <span className="chip text-xs">账本 · 战果</span>
        <button type="button" className="chip text-xs" onClick={() => void load()} disabled={loading}>
          {loading ? '读取中…' : '刷新统计'}
        </button>
      </div>
      <p className="text-sm mt-2 leading-7" style={{ color: 'var(--ink-soft)' }}>
        查看本人的找书与书架记录，以及明确标注的共享书库、书源概况。
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
        <div className="mt-6 space-y-8">
          {unavailable.length > 0 && (
            <p role="status" className="text-sm" style={{ color: 'var(--cinnabar)' }}>
              {unavailable.join('、')}统计暂不可用，可点击「刷新统计」重试。
            </p>
          )}
          {/* 核心战果 */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatTile
              strong
              label="共享书库"
              value={stats.library ? String(stats.library.total) : '不可用'}
              unit={stats.library ? '本' : undefined}
              note={stats.library ? `带质量分 ${stats.library.withQuality} 本` : '书库统计暂不可用'}
            />
            <StatTile
              label="共享打标字数"
              value={formatChars(stats.library?.charsLabeled)}
              note="批量打标读过的正文规模"
            />
            <StatTile
              label="我的找书次数"
              value={stats.find ? String(stats.find.queries) : '不可用'}
              unit={stats.find ? '次' : undefined}
              note={stats.find ? `累计推荐 ${stats.find.recommendations} 本次` : '找书统计暂不可用'}
            />
            <StatTile
              label="我的下载"
              value={stats.download ? String(stats.download.done) : sectionValue('download')}
              unit={stats.download ? '本' : undefined}
              note={
                !stats.download ? sectionNote('download')
                : stats.download.done > 0
                  ? `${Math.round(stats.download.chapters).toLocaleString('zh-CN')} 章 · ${formatChars(stats.download.chars)}`
                  : stats.download.total > 0
                    ? `任务 ${stats.download.total} 个，尚无完成`
                    : '还没有下载任务'
              }
            />
            <StatTile
              label="共享平均质量分"
              value={!stats.library ? '不可用' : stats.library.avgQuality !== null ? stats.library.avgQuality.toFixed(1) : '—'}
              note={!stats.library ? '书库统计暂不可用' : stats.library.avgQuality !== null ? `满分 10 · 已评 ${stats.library.withQuality} 本` : '还没有质量分'}
            />
            {stats.allowedSections.includes('tokens')
              ? <TokenStatTile tokens={stats.tokens} available={stats.availability.tokens} />
              : <StatTile label="模型用量" value={sectionValue('tokens')} note={sectionNote('tokens')} />}
          </dl>

          {stats.allowedSections.includes('tokens') && (
            <>
              <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>模型用量为全站共享账目，仅维护者可见。</p>
              <TokenUsageDetails tokens={stats.tokens} />
            </>
          )}

          {/* 次要分布 */}
          <div className="grid md:grid-cols-2 gap-8">
            <section aria-labelledby="stats-genres">
              <h3 id="stats-genres" className="text-sm font-bold mb-3">
                共享分类分布
                <span className="font-normal ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {stats.library ? `书库 ${stats.library.total} 本` : '统计不可用'}
                </span>
              </h3>
              {!stats.library ? (
                <p className="text-sm" style={{ color: 'var(--cinnabar)' }}>书库分类统计暂不可用。</p>
              ) : stats.library.genres.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="分类分布列表">
                  {stats.library.genres.map((g) => (
                    <li key={g.name} className="chip text-xs">
                      {g.name}
                      <span className="ml-1.5 font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        {g.count}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm" style={{ color: 'var(--ink-faint)' }}>
                  书库还是空的，先去批量打标入库吧。
                </p>
              )}
            </section>

            <section aria-labelledby="stats-shelf">
              <h3 id="stats-shelf" className="text-sm font-bold mb-3">
                我的书架状态
                <span className="font-normal ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {shelfTotal === null ? '统计不可用' : `共 ${shelfTotal} 条`}
                </span>
              </h3>
              {!stats.shelf ? (
                <p className="text-sm" style={{ color: 'var(--cinnabar)' }}>书架统计暂不可用。</p>
              ) : stats.shelf.statuses.length > 0 ? (
                <ul className="space-y-2" aria-label="书架状态分布列表">
                  {stats.shelf.statuses.map((s) => {
                    const meta = SHELF_STATUS[s.name] ?? { label: s.name, color: 'var(--ink-faint)' };
                    const pct = shelfTotal && shelfTotal > 0 ? Math.round((s.count / shelfTotal) * 100) : 0;
                    return (
                      <li key={s.name} className="flex items-center gap-3 text-sm">
                        <span className="w-14 shrink-0" style={{ color: meta.color }}>{meta.label}</span>
                        <span
                          className="flex-1 h-1.5 rounded-full overflow-hidden"
                          style={{ background: 'var(--paper-deep)' }}
                          aria-hidden="true"
                        >
                          <span
                            className="block h-full"
                            style={{ width: `${pct}%`, background: meta.color, opacity: 0.65 }}
                          />
                        </span>
                        <span className="w-8 text-right tabular-nums" style={{ color: 'var(--ink-soft)' }}>
                          {s.count}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm" style={{ color: 'var(--ink-faint)' }}>
                  书架还是空的。
                </p>
              )}
            </section>
          </div>

          {/* 书源一笔账 */}
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            {stats.shuyuan
              ? `共享书源资料 ${stats.shuyuan.total} 条（启用 ${stats.shuyuan.enabled} 条；最近探测可达 ${stats.shuyuan.reachable} 条；未探测 ${stats.shuyuan.unprobed} 条；待核验 ${stats.shuyuan.pending} 条）。可达只代表源站本身探测通过，不代表每本书都能搜到或读到。`
              : sectionNote('shuyuan')}
          </p>
        </div>
      )}

      <section className="mt-8 pt-5 border-t" style={{ borderColor: 'var(--line)' }} aria-label="数据导出">
        <button
          type="button"
          onClick={() => void exportData()}
          disabled={exporting}
          className="chip chip-dai cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {exporting ? '导出中…' : '导出我的数据'}
        </button>
        <p className="mt-2 text-xs leading-6" style={{ color: 'var(--ink-faint)' }}>
          将本人的画像、种子书单、书架、反馈及关联书目，与共享书库基本信息保存为 JSON 文件。
        </p>
        {exportError && (
          <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--cinnabar)' }}>
            {exportError}
          </p>
        )}
      </section>
    </div>
  );
}
