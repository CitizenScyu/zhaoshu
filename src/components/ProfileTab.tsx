'use client';

import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { ProfileSnapshot, SeedBook } from '@/lib/types';
import { useOwner } from '@/components/OwnerProvider';
import {
  contentChanged, readProfileSnapshot, seedsChanged,
  type ProfileDraftAction, type ProfileDraftState, type SaveScope,
} from '@/lib/profile-draft';
import { isRecord } from '@/lib/sanitize';
import { removedSeedBooks, seedRemovalMessage } from '@/lib/profile-seeds';

export default function ProfileTab({ state, dispatch, active }: {
  state: ProfileDraftState;
  dispatch: Dispatch<ProfileDraftAction>;
  active: boolean;
}) {
  const { apiFetch } = useOwner();
  const { seeds, content: draft } = state;
  const content = state.saved?.content ?? '';
  const seedDirty = seedsChanged(state);
  const contentDirty = contentChanged(state);
  const [editing, setEditing] = useState(false);
  const [seedEditing, setSeedEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(!state.saved);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loaded = useRef(Boolean(state.saved));
  const operation = useRef<AbortController | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const restoreEditorFocus = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (editing) {
      editor.current?.focus({ preventScroll: true });
    } else if (restoreEditorFocus.current) {
      editButton.current?.focus({ preventScroll: true });
      restoreEditorFocus.current = false;
    }
  }, [editing, active]);

  // tab 切换保留进行中的生成；退出口令导致页面会话卸载时才取消。
  useEffect(() => () => operation.current?.abort(), []);

  useEffect(() => {
    if (!active || busy) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      void apiFetch('/api/profile', { signal: controller.signal }).then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '读取画像失败（' + res.status + '）');
        const profile = readProfileSnapshot(data);
        if (!profile) throw new Error('画像数据不完整，请重新读取');
        if (controller.signal.aborted) return;
        setLoadError('');
        dispatch({ type: 'load', profile });
        if (!loaded.current) {
          setSeedEditing(profile.seeds.length === 0);
          loaded.current = true;
        }
      }).catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : '读取画像失败，请重试');
        }
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    });
    return () => controller.abort();
  }, [active, apiFetch, loadAttempt, busy, dispatch]);

  function setSeeds(value: SeedBook[] | ((current: SeedBook[]) => SeedBook[])) {
    dispatch({ type: 'edit-seeds', seeds: typeof value === 'function' ? value(seeds) : value });
  }

  function updateSeed(i: number, patch: Partial<SeedBook>) {
    setSeeds((current) => current.map((seed, index) => index === i ? { ...seed, ...patch } : seed));
  }

  function discard(scope: 'seeds' | 'content') {
    const changed = scope === 'seeds' ? seedDirty : contentDirty;
    if (changed && !window.confirm(scope === 'seeds' ? '丢弃未保存的书单改动？' : '丢弃未保存的画像修订？')) return;
    dispatch({ type: 'discard', scope });
    if (scope === 'seeds') setSeedEditing(false);
    else setEditing(false);
    setMsg('');
  }

  async function readWriteResponse(res: Response, controller: AbortController, generating = false): Promise<ProfileSnapshot | null> {
    const raw: unknown = await res.json().catch(() => null);
    controller.signal.throwIfAborted();
    const data = isRecord(raw) ? raw : {};
    if (res.status === 409 && (data.code === 'PROFILE_CONFLICT' || data.code === 'PROFILE_SEEDS_CONFIRM_REQUIRED')) {
      const generated = generating && isRecord(data.draft)
        ? readProfileSnapshot({ ...data.draft, updatedAt: state.saved?.updatedAt })
        : null;
      dispatch({
        type: 'conflict', profile: readProfileSnapshot(data.profile),
        ...(generated ? { generated: { seeds: generated.seeds, content: generated.content } } : {}),
      });
      if (generated) setEditing(true);
      setMsg(generated
        ? '本次生成稿已保留，请比较后重新保存。'
        : '画像已在其他页面更新，你的草稿已保留。');
      return null;
    }
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '保存失败，请重试');
    const profile = readProfileSnapshot(data);
    if (!profile) throw new Error('保存响应不完整，草稿已保留，请重新读取后核对');
    return profile;
  }

  function beginOperation(): AbortController | null {
    if (!state.saved || loading || loadError || operation.current) return null;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setMsg('');
    return controller;
  }

  // POST 生成改为真 SSE：首字节尽早到达，避免浏览器→Vercel 之间的空闲连接被本地代理
  // 在 60s 掐断。结束帧带最终 seeds/content/updatedAt；冲突以 `conflict` 事件结算，
  // 保留第七批的 CAS/409 语义；最严苛错误落 `error` 事件，在正常流结束时交给调用方。
  async function generateFromStream(res: Response, controller: AbortController): Promise<ProfileSnapshot | null> {
    if (!res.body) throw new Error('生成响应为空，请重试');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        controller.signal.throwIfAborted();
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
          if (data.type === 'done') {
            const profile = readProfileSnapshot(data);
            if (!profile) throw new Error('生成响应不完整，草稿已保留，请重新读取后核对');
            return profile;
          }
          if (data.type === 'conflict') {
            const generated = isRecord(data.draft)
              ? readProfileSnapshot({ ...data.draft, updatedAt: state.saved?.updatedAt })
              : null;
            dispatch({
              type: 'conflict', profile: readProfileSnapshot(data.profile),
              ...(generated ? { generated: { seeds: generated.seeds, content: generated.content } } : {}),
            });
            if (generated) setEditing(true);
            setMsg(generated ? '本次生成稿已保留，请比较后重新保存。' : '画像已在其他页面更新，你的草稿已保留。');
            return null;
          }
          if (data.type === 'error') {
            throw new Error(typeof data.message === 'string' ? data.message : '生成失败，请重试');
          }
        }
      }
      throw new Error('生成响应意外结束，请重试');
    } finally {
      try { await reader.cancel(); } catch { /* 已取消或已关闭 */ }
    }
  }

  function finishOperation(controller: AbortController) {
    if (operation.current !== controller) return;
    operation.current = null;
    if (!controller.signal.aborted) setBusy(false);
  }

  async function save(scope: SaveScope) {
    const updatedAt = scope === 'all' ? state.conflict?.updatedAt : state.saved?.updatedAt;
    if (!updatedAt || (state.conflictDetected && scope !== 'all')) return;
    const baseline = scope === 'all' ? state.conflict : state.saved;
    if (!baseline || !state.saved) return;
    const nextSeeds = scope === 'content' ? state.saved.seeds : seeds;
    const confirmSeedRemoval = removedSeedBooks(baseline.seeds, nextSeeds).length > 0;
    if (confirmSeedRemoval && !window.confirm(seedRemovalMessage(baseline.seeds, nextSeeds))) return;
    const controller = beginOperation();
    if (!controller || !state.saved) return;
    try {
      const res = await apiFetch('/api/profile', {
        method: 'PUT', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seeds: nextSeeds, confirmSeedRemoval,
          ...(scope === 'seeds' ? {} : { content: draft }),
          updatedAt,
        }),
      });
      const profile = await readWriteResponse(res, controller);
      if (!profile) return;
      dispatch({ type: 'saved', profile, scope });
      if (scope !== 'content') setSeedEditing(false);
      if (scope !== 'seeds') setEditing(false);
      setMsg(scope === 'seeds' ? '✓ 种子已保存' : '✓ 已保存');
    } catch (error) {
      if (!controller.signal.aborted) setMsg('✗ ' + (error instanceof Error ? error.message : '保存失败，请重试') + '，草稿已保留。');
    } finally {
      finishOperation(controller);
    }
  }

  async function generate() {
    if (state.conflictDetected || contentDirty) return;
    if (!state.saved) return;
    const confirmSeedRemoval = removedSeedBooks(state.saved.seeds, seeds).length > 0;
    if (confirmSeedRemoval && !window.confirm(seedRemovalMessage(state.saved.seeds, seeds))) return;
    const controller = beginOperation();
    if (!controller || !state.saved) return;
    try {
      const saveRes = await apiFetch('/api/profile', {
        method: 'PUT', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds, updatedAt: state.saved.updatedAt, confirmSeedRemoval }),
      });
      const saved = await readWriteResponse(saveRes, controller);
      if (!saved) return;
      dispatch({ type: 'saved', profile: saved, scope: 'seeds' });
      setSeedEditing(false);
      const res = await apiFetch('/api/profile', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updatedAt: saved.updatedAt }),
      });
      if (!res.ok) {
        // 非 200 仍是流未启动前的错误（如 409 冲突 / 校验失败），沿用旧 readWriteResponse 契约。
        const fallback = await readWriteResponse(res, controller, true);
        if (!fallback) return;
        dispatch({ type: 'saved', profile: fallback, scope: 'all' });
        setEditing(false);
        setMsg('✓ 画像已生成');
        return;
      }
      const profile = await generateFromStream(res, controller);
      if (!profile) return;
      dispatch({ type: 'saved', profile, scope: 'all' });
      setEditing(false);
      setMsg('✓ 画像已生成');
    } catch (error) {
      if (!controller.signal.aborted) setMsg('✗ ' + (error instanceof Error ? error.message : '生成失败，请重试'));
    } finally {
      finishOperation(controller);
    }
  }

  function useLatest() {
    if (!state.conflict) return;
    if ((seedDirty || contentDirty) && !window.confirm('丢弃当前草稿，使用服务器最新画像和书单？')) return;
    dispatch({ type: 'use-latest' });
    setEditing(false);
    setSeedEditing(state.conflict.seeds.length === 0);
    setMsg('✓ 已使用服务器最新版本');
  }

  const cannotSave = busy || loading || Boolean(loadError) || state.conflictDetected;

  const loveCount = seeds.filter((s) => s.kind === 'love').length;
  const dropCount = seeds.filter((s) => s.kind === 'drop').length;

  if (loading && !state.saved) {
    return <p role="status" className="text-sm py-10 text-center">正在读取画像…</p>;
  }

  if (loadError && !state.saved) {
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
    <div className="space-y-6">
      {loadError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm" style={{ color: 'var(--cinnabar)' }}>{loadError}，草稿仍保留。</p>
          <button className="chip text-xs" disabled={busy || loading} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重新读取</button>
        </div>
      )}
      {state.conflictDetected && (
        <section aria-labelledby="profile-conflict-title" className="border-t-2 border-[var(--cinnabar)] bg-[var(--paper)] p-4 sm:p-5">
          <h2 id="profile-conflict-title" className="text-base font-bold" style={{ color: 'var(--cinnabar)' }}>画像有新版本</h2>
          <p role="status" className="mt-2 text-xs leading-6" style={{ color: 'var(--ink-soft)' }}>
            你的草稿已保留。比较书单与正文后，可在下方继续编辑，再重新保存。
          </p>
          {state.conflict ? (
            <>
              <div className="grid md:grid-cols-2 gap-4 mt-4">
                <ProfileComparison title="服务器最新" seeds={state.conflict.seeds} content={state.conflict.content} />
                <ProfileComparison title="我的草稿" seeds={seeds} content={draft} />
              </div>
              <div className="flex flex-wrap gap-3 mt-4">
                <button className="seal-button text-xs !py-2" onClick={() => void save('all')} disabled={busy || loading || Boolean(loadError)}>
                  以当前草稿重新保存
                </button>
                <button className="ink-button text-xs !py-2" onClick={useLatest} disabled={busy}>
                  使用服务器最新版本
                </button>
              </div>
            </>
          ) : (
            <button className="ink-button text-xs mt-3" disabled={busy || loading} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              读取最新版本以比较
            </button>
          )}
        </section>
      )}
      <div className="grid lg:grid-cols-2 gap-10">
      {/* 左：种子书单 */}
      <section>
        <h2 className="text-sm font-bold tracking-[0.25em] mb-1" style={{ color: 'var(--cinnabar)' }}>
          种子书单
          {seedDirty && <span className="ml-2 text-xs font-normal tracking-normal" style={{ color: 'var(--ink-soft)' }}>未保存</span>}
        </h2>
        <p className="text-xs mb-4 leading-6" style={{ color: 'var(--ink-faint)' }}>
          最爱 {loveCount} 本 · 弃书 {dropCount} 本。弃书原因的权重高于最爱——网文口味「彼仙我毒」，雷点比萌点更能定义你。
        </p>
        <p id="seed-author-help" className="text-xs mb-4 leading-6" style={{ color: 'var(--ink-soft)' }}>
          作者留空会排除所有同名书；填写作者后，仅排除该作者的同名作品。续篇书名不同，仍可推荐。
        </p>

        {seedEditing ? (
          <fieldset disabled={busy} aria-label="编辑种子书单" className="min-w-0">
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
                onClick={() => discard('seeds')}
              >
                {seedDirty ? '丢弃书单改动' : '收起'}
              </button>
            </div>

            <div className="space-y-3">
              {seeds.map((s, i) => (
                <div
                  key={i}
                  className="border border-[var(--line)] rounded p-3 bg-[var(--paper-card)]"
                >
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 items-center mb-2">
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
                    className="paper-input text-sm w-full !py-1.5 mb-2"
                    aria-label="作者"
                    aria-describedby="seed-author-help"
                    placeholder="作者(可空)"
                    value={s.author ?? ''}
                    onChange={(e) => updateSeed(i, { author: e.target.value })}
                  />
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
          </fieldset>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {seeds.map((s, i) => (
                <span
                  key={i}
                  className="inline-flex max-w-full flex-wrap items-center gap-1.5 text-xs px-2 py-1 border-b border-[var(--line)]"
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
              disabled={busy}
            >
              编辑书单
            </button>
          </>
        )}

        <div className="flex flex-wrap gap-2.5 mt-4">
          <div className="flex-1" />
          <button className="ink-button text-xs !py-2" onClick={() => void save('seeds')} disabled={cannotSave}>
            保存种子
          </button>
          <button className="seal-button text-xs !py-2" onClick={generate} disabled={cannotSave || contentDirty}>
            {busy ? '…' : '生成画像'}
          </button>
        </div>
        {contentDirty && !state.conflictDetected && (
          <p className="text-xs mt-3 leading-6" style={{ color: 'var(--ink-soft)' }}>先保存或丢弃画像修订，再生成新画像。</p>
        )}
        {msg && (
          <p role="status" className="text-xs mt-3" style={{ color: msg.startsWith('✓') ? 'var(--moss)' : 'var(--cinnabar)' }}>
            {msg}
          </p>
        )}
      </section>

      {/* 右：画像 */}
      <section>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <h2 id="profile-content-title" className="text-sm font-bold tracking-[0.25em] mr-auto" style={{ color: 'var(--cinnabar)' }}>
            口味画像
            {contentDirty && <span className="ml-2 text-xs font-normal tracking-normal" style={{ color: 'var(--ink-soft)' }}>未保存</span>}
          </h2>
          {!editing && (
            <button
              ref={editButton}
              className="chip text-xs"
              disabled={busy}
              onClick={() => {
                restoreEditorFocus.current = true;
                setEditing(true);
              }}
            >
              人工修订
            </button>
          )}
          {editing && (
            <>
              <button className="chip chip-dai text-xs" onClick={() => void save('content')} disabled={cannotSave}>
                保存修订
              </button>
              <button
                className="chip text-xs"
                onClick={() => discard('content')}
                disabled={busy}
              >
                {contentDirty ? '丢弃修订' : '取消'}
              </button>
            </>
          )}
        </div>

        {editing ? (
          <textarea
            ref={editor}
            aria-labelledby="profile-content-title"
            className="paper-input text-sm leading-7 w-full h-96 font-mono resize-y"
            value={draft}
            onChange={(e) => dispatch({ type: 'edit-content', content: e.target.value })}
            disabled={busy}
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
    </div>
  );
}

function ProfileComparison({ title, seeds, content }: { title: string; seeds: SeedBook[]; content: string }) {
  return (
    <div className="min-w-0 border border-[var(--line)] bg-[var(--paper-card)] p-3">
      <h3 className="text-sm font-bold mb-3">{title}</h3>
      <div tabIndex={0} aria-label={title + '内容'} className="max-h-80 overflow-auto text-xs leading-6 break-words">
        <p className="font-bold" style={{ color: 'var(--ink-soft)' }}>种子书单</p>
        {seeds.length > 0 ? <ul className="space-y-1 mb-3">
          {seeds.map((seed, index) => <li key={index}>
            {seed.kind === 'drop' ? '弃书' : '最爱'} · {seed.title}{seed.author && ' / ' + seed.author}
            {seed.reason && <p style={{ color: 'var(--ink-soft)' }}>{seed.reason}</p>}
          </li>)}
        </ul> : <p className="mb-3">书单为空</p>}
        <p className="font-bold" style={{ color: 'var(--ink-soft)' }}>画像正文</p>
        <p className="whitespace-pre-wrap">{content || '画像为空'}</p>
      </div>
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
