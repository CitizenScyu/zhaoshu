'use client';

import { useEffect, useState } from 'react';
import type { SeedBook } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';

export default function ProfileTab() {
  const { apiFetch } = useOwner();
  const [seeds, setSeeds] = useState<SeedBook[]>([]);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [seedEditing, setSeedEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/profile', { signal: controller.signal }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `读取画像失败（${res.status}）`);
      if (controller.signal.aborted) return;
      setSeeds(data.seeds ?? []);
      setSeedEditing(!(data.seeds && data.seeds.length > 0));
      setContent(data.content ?? '');
    }).catch((error) => {
      if (!controller.signal.aborted) {
        setLoadError(error instanceof Error ? error.message : '读取画像失败，请重试');
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [apiFetch, loadAttempt]);

  function updateSeed(i: number, patch: Partial<SeedBook>) {
    setSeeds((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  async function saveSeeds() {
    if (loading || loadError || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? '✓ 种子已保存' : `✗ ${data.error || '保存失败'}`);
      if (res.ok) setSeedEditing(false);
    } catch (error) {
      setMsg(`✗ ${error instanceof Error ? error.message : '保存失败，请重试'}`);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (loading || loadError || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const saveRes = await apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds }),
      });
      const saveData = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setMsg(`✗ ${saveData.error || '保存种子失败'}`);
        return;
      }
      const res = await apiFetch('/api/profile', { method: 'POST' });
      const d = await res.json();
      if (res.ok) {
        setContent(d.content);
        setMsg('✓ 画像已生成');
        if (seeds.length > 0) setSeedEditing(false);
      } else {
        setMsg(`✗ ${d.error || '生成失败'}`);
      }
    } catch (error) {
      setMsg(`✗ ${error instanceof Error ? error.message : '生成失败，请重试'}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (loading || loadError || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds, content: draft }),
      });
      if (res.ok) {
        setContent(draft);
        setEditing(false);
        setMsg('✓ 已保存');
      } else {
        const data = await res.json().catch(() => ({}));
        setMsg(`✗ ${data.error || '保存失败'}`);
      }
    } catch (error) {
      setMsg(`✗ ${error instanceof Error ? error.message : '保存失败，请重试'}`);
    } finally {
      setBusy(false);
    }
  }

  const loveCount = seeds.filter((s) => s.kind === 'love').length;
  const dropCount = seeds.filter((s) => s.kind === 'drop').length;

  if (loading) {
    return <p role="status" className="text-sm py-10 text-center">正在读取画像…</p>;
  }

  if (loadError) {
    return (
      <div className="py-10 text-center">
        <p role="alert" className="text-sm mb-4" style={{ color: 'var(--cinnabar)' }}>{loadError}</p>
        <button
          className="ink-button text-xs"
          onClick={() => {
            setLoading(true);
            setLoadError('');
            setLoadAttempt((attempt) => attempt + 1);
          }}
        >
          重新读取
        </button>
      </div>
    );
  }

  return (
    <div className="grid lg:grid-cols-2 gap-10">
      {/* 左：种子书单 */}
      <section>
        <h2 className="text-sm font-bold tracking-[0.25em] mb-1" style={{ color: 'var(--cinnabar)' }}>
          种子书单
        </h2>
        <p className="text-xs mb-4 leading-6" style={{ color: 'var(--ink-faint)' }}>
          最爱 {loveCount} 本 · 弃书 {dropCount} 本。弃书原因的权重高于最爱——网文口味「彼仙我毒」，雷点比萌点更能定义你。
        </p>

        {seedEditing ? (
          <>
            <div className="flex flex-wrap gap-2.5 mb-3">
              <button
                className="chip hover:border-[var(--ink)] transition-colors"
                onClick={() =>
                  setSeeds((s) => [{ title: '', kind: 'love' }, ...s])
                }
              >
                + 最爱
              </button>
              <button
                className="chip hover:border-[var(--cinnabar)] transition-colors"
                onClick={() =>
                  setSeeds((s) => [{ title: '', kind: 'drop' }, ...s])
                }
              >
                + 弃书
              </button>
              <div className="flex-1" />
              <button
                className="chip text-xs"
                onClick={() => {
                  if (
                    seeds.length > 0 &&
                    !window.confirm('有未保存的修改，收起会丢弃这些改动，确定？')
                  ) {
                    return;
                  }
                  setSeedEditing(false);
                }}
              >
                收起
              </button>
            </div>

            <div className="space-y-3">
              {seeds.map((s, i) => (
                <div
                  key={i}
                  className="border border-[var(--line)] rounded p-3 bg-[var(--paper-card)]"
                >
                  <div className="flex flex-wrap gap-2 items-center mb-2">
                    <button
                      className={`chip text-xs ${s.kind === 'drop' ? 'chip-risk' : 'chip-like'}`}
                      onClick={() => updateSeed(i, { kind: s.kind === 'drop' ? 'love' : 'drop' })}
                      title="点击切换 最爱/弃书"
                    >
                      {s.kind === 'drop' ? '弃书' : '最爱'}
                    </button>
                    <input
                      className="paper-input text-sm flex-1 min-w-0 !py-1.5"
                      aria-label="书名"
                      placeholder="书名"
                      value={s.title}
                      onChange={(e) => updateSeed(i, { title: e.target.value })}
                    />
                    <input
                      className="paper-input text-sm w-28 !py-1.5"
                      aria-label="作者"
                      placeholder="作者(可空)"
                      value={s.author ?? ''}
                      onChange={(e) => updateSeed(i, { author: e.target.value })}
                    />
                    <button
                      className="text-xs px-1"
                      aria-label={`删除${s.title || '这本书'}`}
                      style={{ color: 'var(--ink-faint)' }}
                      onClick={() => setSeeds((arr) => arr.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    className="paper-input text-xs w-full !py-1.5"
                    aria-label="喜欢或弃书的原因"
                    placeholder={s.kind === 'drop' ? '为什么弃？（毒点在哪）' : '为什么爱？（哪个点戳中你）'}
                    value={s.reason ?? ''}
                    onChange={(e) => updateSeed(i, { reason: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {seeds.map((s, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 text-xs px-2 py-1 border-b border-[var(--line)]"
                  title="编辑书单"
                >
                  <span
                    className={`chip chip-sm !text-[10px] ${s.kind === 'drop' ? 'chip-risk' : 'chip-like'}`}
                  >
                    {s.kind === 'drop' ? '弃' : '爱'}
                  </span>
                  <span className="text-[var(--ink)]">{s.title}</span>
                  {s.author && <span className="text-[var(--ink-faint)] text-[10px]">{s.author}</span>}
                </span>
              ))}
              {seeds.length === 0 && (
                <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  书单还是空的 —— 点「编辑书单」加几本。
                </span>
              )}
            </div>
            <button
              className="ink-button text-xs !py-2"
              onClick={() => setSeedEditing(true)}
            >
              编辑书单
            </button>
          </>
        )}

        <div className="flex flex-wrap gap-2.5 mt-4">
          <div className="flex-1" />
          <button className="ink-button text-xs !py-2" onClick={saveSeeds} disabled={busy}>
            保存种子
          </button>
          <button className="seal-button text-xs !py-2" onClick={generate} disabled={busy}>
            {busy ? '…' : '生成画像'}
          </button>
        </div>
        {msg && (
          <p role="status" className="text-xs mt-3" style={{ color: msg.startsWith('✓') ? 'var(--moss)' : 'var(--cinnabar)' }}>
            {msg}
          </p>
        )}
      </section>

      {/* 右：画像 */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-sm font-bold tracking-[0.25em]" style={{ color: 'var(--cinnabar)' }}>
            口味画像
          </h2>
          <div className="flex-1" />
          {content && !editing && (
            <button
              className="chip text-xs"
              onClick={() => {
                setDraft(content);
                setEditing(true);
              }}
            >
              人工修订
            </button>
          )}
          {editing && (
            <>
              <button className="chip chip-dai text-xs" onClick={saveDraft} disabled={busy}>
                保存修订
              </button>
              <button
                className="chip text-xs"
                onClick={() => setEditing(false)}
              >
                取消
              </button>
            </>
          )}
        </div>

        {editing ? (
          <textarea
            className="paper-input text-sm leading-7 w-full h-96 font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : content ? (
          <div className="book-card px-6 py-5 pl-8 md">
            <Markdown md={content} />
          </div>
        ) : (
          <p className="text-sm py-10 text-center" style={{ color: 'var(--ink-faint)' }}>
            画像还是白纸 —— 填好种子书单，点「生成画像」
          </p>
        )}
        {content && !editing && (
          <p className="text-xs mt-3 leading-6" style={{ color: 'var(--ink-faint)' }}>
            每次读完/弃书留下原因，画像会自动吸收（见找书页的反馈按钮）。人工修订可直接改。
          </p>
        )}
      </section>
    </div>
  );
}

// 极简 Markdown 渲染（画像专用：## / 列表 / **粗体**）
function Markdown({ md }: { md: string }) {
  const lines = md.split('\n');
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  let key = 0;

  const flush = () => {
    if (list.length > 0) {
      out.push(<ul key={key++}>{list}</ul>);
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('##')) {
      flush();
      out.push(<h2 key={key++}>{line.replace(/^#+\s*/, '')}</h2>);
    } else if (/^\s*[-*]\s+/.test(line)) {
      list.push(<li key={key++}>{inline(line.replace(/^\s*[-*]\s+/, ''))}</li>);
    } else if (line.trim() === '') {
      flush();
    } else {
      flush();
      out.push(<p key={key++}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{out}</>;
}

function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p,
  );
}
