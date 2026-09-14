'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { OwnerProvider, useOwner } from '@/components/OwnerProvider';
import type { ReaderIndex, ReaderPart } from '@/lib/reader-types';
import {
  DEFAULT_READER_SETTINGS, READER_SETTINGS_KEY, parseReaderSettings, parseReadingProgress,
  readingPercent, readingProgressKey,
} from '@/lib/reader-preferences';
import type { ReaderSettings, ReaderTheme, ReadingPosition, ReadingProgress } from '@/lib/reader-preferences';
import styles from './reader.module.css';

interface Props { taskId: number; from: 'library' | 'shelf' }
interface Reading { index: ReaderIndex; part: ReaderPart; position: ReadingPosition; focus: boolean }
interface Failure { message: string; status: number; target?: ReadingPosition }
const START: ReadingPosition = { chapterIndex: 0, partIndex: 0, ratio: 0 };
const DIRECTORY_PAGE_SIZE = 80;

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new RequestError('访问口令不正确或已失效，请重新输入。', 401);
    throw new RequestError(typeof data?.error === 'string' ? data.error : '阅读服务暂时不可用，请稍后重试。', response.status);
  }
  if (!data) throw new RequestError('收到的阅读内容不完整，请重试。', 502);
  return data as T;
}

function storedValue(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function bodyText(part: ReaderPart): string {
  const text = part.text.replace(/^\uFEFF/, '');
  if (part.partIndex !== 0) return text;
  const lineEnd = text.search(/[\r\n]/);
  // The title already has its own heading; retain all other original text.
  if (lineEnd >= 0 && text.slice(0, lineEnd).trim() === part.title) return text.slice(lineEnd).replace(/^[\r\n]+/, '');
  if (text.trim() === part.title) return '';
  return text;
}

function BackLink({ from }: Pick<Props, 'from'>) {
  return <Link className={styles.back} href={`/?tab=${from}`}>← 返回{from === 'shelf' ? '书架' : '书库'}</Link>;
}

export default function ReaderClient(props: Props) {
  return <OwnerProvider><ReaderGate {...props} /></OwnerProvider>;
}

function ReaderGate(props: Props) {
  const { ready, token } = useOwner();
  if (!ready) return <div className={styles.screen}><p className={styles.empty} role="status">正在打开书页…</p></div>;
  if (!token) return <div className={styles.screen}><AccessForm from={props.from} /></div>;
  // Drop any in-flight work and previously displayed book when credentials change.
  return <ReaderSession key={`${props.taskId}:${token}`} {...props} />;
}

function AccessForm({ from, message }: Pick<Props, 'from'> & { message?: string }) {
  const { submitToken } = useOwner();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      await submitToken(draft);
    } catch (error) {
      setError(error instanceof Error ? error.message : '口令验证失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.access}>
      <BackLink from={from} />
      <div className={styles.accessCard}>
        <span className="seal w-12 h-12 text-lg" aria-hidden="true">书径</span>
        <h1>推门，入书中</h1>
        <p>输入站点访问口令，继续阅读。</p>
        {(error || message) && <p id="reader-owner-error" role="alert" className={styles.errorText}>{error || message}</p>}
        <form onSubmit={unlock}>
          <label htmlFor="reader-owner-token">访问口令</label>
          <input id="reader-owner-token" className={styles.input} type="password" autoComplete="current-password" value={draft} onChange={(event) => { setDraft(event.target.value); setError(''); }} disabled={busy} aria-invalid={Boolean(error || message) || undefined} aria-describedby={error || message ? 'reader-owner-error' : undefined} required />
          <button className={styles.primary} type="submit" disabled={busy || !draft.trim()}>{busy ? '验证中…' : '开始阅读 →'}</button>
        </form>
      </div>
    </div>
  );
}

function ReaderSession({ taskId, from }: Props) {
  const { apiFetch } = useOwner();
  const [settings, setSettings] = useState(() => parseReaderSettings(storedValue(READER_SETTINGS_KEY)));
  const [reading, setReading] = useState<Reading | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [panel, setPanel] = useState<'directory' | 'settings' | null>(null);
  const [percent, setPercent] = useState(0);
  const [notice, setNotice] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const scroller = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const request = useRef<AbortController | null>(null);
  const serial = useRef(0);
  const currentReading = useRef<Reading | null>(null);
  const progress = useRef<ReadingProgress | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveProgress = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!progress.current) return;
    try {
      window.localStorage.setItem(readingProgressKey(taskId), JSON.stringify(progress.current));
    } catch {
      setStorageFailed(true);
    }
  }, [taskId]);

  const beginRequest = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const id = ++serial.current;
    setLoading(true);
    setFailure(null);
    return { controller, id };
  }, []);

  const fetchPart = useCallback(async (index: ReaderIndex, position: ReadingPosition, signal: AbortSignal) => {
    const query = new URLSearchParams({ chapter: String(position.chapterIndex), part: String(position.partIndex), version: index.version });
    const part = await responseJson<ReaderPart>(await apiFetch(`/api/read/${taskId}/chapter?${query}`, { signal, cache: 'no-store' }));
    if (part.version !== index.version || part.chapterIndex !== position.chapterIndex || part.partIndex !== position.partIndex || typeof part.text !== 'string') {
      throw new RequestError('章节内容与目录不一致，请重新加载目录。', 409);
    }
    return part;
  }, [apiFetch, taskId]);

  const loadIndex = useCallback(async () => {
    const { controller, id } = beginRequest();
    try {
      const index = await responseJson<ReaderIndex>(await apiFetch(`/api/read/${taskId}/index`, { signal: controller.signal, cache: 'no-store' }));
      if (!Array.isArray(index.chapters) || !index.chapters.length) throw new RequestError('这本书还没有可阅读的正文。', 422);
      const saved = parseReadingProgress(storedValue(readingProgressKey(taskId)), index);
      const position = saved ?? START;
      const part = await fetchPart(index, position, controller.signal);
      if (controller.signal.aborted || id !== serial.current) return;
      setReading({ index, part, position, focus: false });
      setPercent(readingPercent(index, part, position.ratio));
      setNotice(saved ? '已回到上次阅读的位置' : '');
    } catch (error) {
      if (!controller.signal.aborted && id === serial.current) {
        const status = error instanceof RequestError ? error.status : 0;
        if (status === 401) setReading(null);
        setFailure({ message: error instanceof Error ? error.message : '打开书籍失败，请重试。', status });
      }
    } finally {
      if (!controller.signal.aborted && id === serial.current) setLoading(false);
    }
  }, [apiFetch, taskId, beginRequest, fetchPart]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadIndex(); });
    return () => { active = false; serial.current += 1; request.current?.abort(); saveProgress(); };
  }, [loadIndex, saveProgress]);

  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') saveProgress(); };
    window.addEventListener('pagehide', saveProgress);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', saveProgress);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [saveProgress]);

  useLayoutEffect(() => {
    currentReading.current = reading;
    if (!reading || !scroller.current) return;
    const element = scroller.current;
    progress.current = { schema: 1, version: reading.index.version, ...reading.position, updatedAt: Date.now() };
    element.scrollTop = reading.position.ratio * Math.max(0, element.scrollHeight - element.clientHeight);
    if (reading.focus) heading.current?.focus({ preventScroll: true });
    saveProgress();
    // Font downloads, orientation changes, and settings can change line wrapping.
    // Keep the same relative position instead of drifting to another passage.
    const observer = new ResizeObserver(() => {
      if (!progress.current || currentReading.current !== reading) return;
      const distance = Math.max(0, element.scrollHeight - element.clientHeight);
      // A short section can be entirely visible without ever emitting scroll.
      const ratio = distance > 0 ? progress.current.ratio : 1;
      if (ratio !== progress.current.ratio) {
        progress.current = { ...progress.current, ratio, updatedAt: Date.now() };
        saveProgress();
      }
      element.scrollTop = ratio * distance;
      setPercent(readingPercent(reading.index, reading.part, ratio));
    });
    if (article.current) observer.observe(article.current);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reading, saveProgress]);

  function onScroll() {
    const current = currentReading.current;
    const element = scroller.current;
    if (!current || !element || !progress.current) return;
    const distance = element.scrollHeight - element.clientHeight;
    const ratio = distance > 0 ? Math.max(0, Math.min(1, element.scrollTop / distance)) : 1;
    progress.current = { ...progress.current, ratio, updatedAt: Date.now() };
    setPercent(readingPercent(current.index, current.part, ratio));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveProgress, 400);
  }

  async function navigate(position: ReadingPosition) {
    if (!reading) return;
    saveProgress();
    setPanel(null);
    setNotice('');
    const { controller, id } = beginRequest();
    try {
      const part = await fetchPart(reading.index, position, controller.signal);
      if (controller.signal.aborted || id !== serial.current) return;
      setReading({ index: reading.index, part, position, focus: true });
      setPercent(readingPercent(reading.index, part, position.ratio));
    } catch (error) {
      if (!controller.signal.aborted && id === serial.current) {
        const status = error instanceof RequestError ? error.status : 0;
        if (status === 401) setReading(null);
        setFailure({ message: error instanceof Error ? error.message : '章节加载失败，请重试。', status, target: position });
      }
    } finally {
      if (!controller.signal.aborted && id === serial.current) setLoading(false);
    }
  }

  function updateSettings(next: ReaderSettings) {
    setSettings(next);
    try { window.localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify(next)); }
    catch { setStorageFailed(true); }
  }

  const chapter = reading?.part.chapterIndex ?? 0;
  const partIndex = reading?.part.partIndex ?? 0;
  const chapters = reading?.index.chapters ?? [];
  const hasNextPart = !!reading && partIndex + 1 < reading.part.partCount;
  const hasNextChapter = chapter + 1 < chapters.length;
  const position = (chapterIndex: number, nextPart = 0): ReadingPosition => ({ chapterIndex, partIndex: nextPart, ratio: 0 });
  const screenStyle = { '--reader-font-size': `${settings.fontSize}px`, '--reader-line-height': settings.lineHeight } as CSSProperties;

  if (failure?.status === 401) return <div className={styles.screen} data-theme={settings.theme}><AccessForm from={from} message={failure.message} /></div>;

  return (
    <div className={styles.screen} data-theme={settings.theme} style={screenStyle}>
      <header className={styles.header}>
        <BackLink from={from} />
        <div className={styles.bookIdentity}>
          <span className={styles.smallSeal} aria-hidden="true">书径</span>
          <span title={reading?.index.title}>{reading?.index.title ?? '在线阅读'}</span>
        </div>
        <div className={styles.tools}>
          <button className={styles.tool} disabled={!reading} aria-haspopup="dialog" aria-expanded={panel === 'directory'} onClick={() => setPanel('directory')}><span aria-hidden="true">☷</span> 目录</button>
          <button className={styles.tool} aria-haspopup="dialog" aria-expanded={panel === 'settings'} onClick={() => setPanel('settings')}><span aria-hidden="true">Aa</span> 设置</button>
        </div>
      </header>

      {failure && (
        <div className={styles.errorBar} role="alert">
          <span>{failure.message}</span>
          <button className={styles.tool} disabled={loading} onClick={() => failure.status === 409 || !failure.target ? void loadIndex() : void navigate(failure.target)}>{failure.status === 409 ? '重新加载目录' : '重试'}</button>
        </div>
      )}
      <div className={styles.liveStatus} role="status" aria-live="polite">
        {loading ? reading ? '正在打开章节…' : '正在准备目录与正文，首次打开可能需要一点时间…' : notice}
      </div>

      <main
        ref={scroller}
        className={styles.scroller}
        aria-label="阅读正文"
        aria-busy={loading}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={(event) => {
          if (loading || panel || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
          if (event.key === 'ArrowLeft' && chapter > 0) { event.preventDefault(); void navigate(position(chapter - 1)); }
          if (event.key === 'ArrowRight' && hasNextChapter) { event.preventDefault(); void navigate(position(chapter + 1)); }
        }}
      >
        {reading ? (
          <article ref={article} className={styles.page}>
            <div className={styles.chapterMeta}>
              <span>{reading.index.author || '佚名'} 著</span>
              <span>{String(chapter + 1).padStart(2, '0')} / {chapters.length}</span>
            </div>
            <h1 ref={heading} tabIndex={-1} className={styles.chapterTitle}>{reading.part.title}</h1>
            {reading.part.partCount > 1 && <p className={styles.partLabel}>本章较长，分节阅读 · 第 {partIndex + 1} / {reading.part.partCount} 节</p>}
            <div className={styles.prose} aria-label="章节正文">{bodyText(reading.part)}</div>
            <div className={styles.endMark} aria-hidden="true">· · ·</div>
            <nav className={styles.continueNav} aria-label="接着阅读">
              {partIndex > 0 && <button className={styles.secondary} disabled={loading} onClick={() => void navigate(position(chapter, partIndex - 1))}>← 本章上一节</button>}
              {hasNextPart ? (
                <button className={styles.primary} disabled={loading} onClick={() => void navigate(position(chapter, partIndex + 1))}>继续本章 →</button>
              ) : hasNextChapter ? (
                <button className={styles.primary} disabled={loading} onClick={() => void navigate(position(chapter + 1))}>下一章 →</button>
              ) : <p className={styles.finished}>已读到全书末尾 · 合卷，再寻一径</p>}
            </nav>
          </article>
        ) : (
          <div className={styles.empty}>
            <div className="seal w-14 h-14 text-xl" aria-hidden="true">书径</div>
            <h1>{failure ? '暂时未能打开这本书' : '一页书，一段光阴'}</h1>
            <p>{failure ? '可重试，或返回查看书籍的下载状态。' : '书页正在准备中…'}</p>
            {failure && <BackLink from={from} />}
          </div>
        )}
      </main>

      <footer className={styles.footer}>
        <div className={styles.progressTrack} role="progressbar" aria-label="全书阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percent.toFixed(1))}><span style={{ width: `${percent}%` }} /></div>
        <div className={styles.footerInner}>
          <button className={styles.chapterButton} disabled={!reading || loading || chapter === 0} onClick={() => void navigate(position(chapter - 1))}>← 上一章</button>
          <button className={styles.progressButton} disabled={!reading} onClick={() => setPanel('directory')} aria-label="打开目录，查看阅读位置">
            <span>{reading ? `第 ${chapter + 1} / ${chapters.length} 章` : '待展卷'}</span>
            <small>{reading ? `全书 ${percent.toFixed(1)}%` : '书径 · 在线阅读'}</small>
          </button>
          <button className={styles.chapterButton} disabled={!reading || loading || !hasNextChapter} onClick={() => void navigate(position(chapter + 1))}>下一章 →</button>
        </div>
        {storageFailed && <p className={styles.storageWarning} role="status">浏览器未允许保存，阅读进度与设置暂时无法记住。</p>}
      </footer>

      {panel === 'directory' && reading && (
        <Panel title="目录" side="left" onClose={() => setPanel(null)}>
          <Directory index={reading.index} current={chapter} onSelect={(selected) => void navigate(position(selected))} />
        </Panel>
      )}
      {panel === 'settings' && (
        <Panel title="阅读设置" side="right" onClose={() => setPanel(null)}>
          <Settings value={settings} onChange={updateSettings} />
        </Panel>
      )}
    </div>
  );
}

function Panel({ title, side, onClose, children }: { title: string; side: 'left' | 'right'; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true }); };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.panel}
      data-side={side}
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <div className={styles.panelHeader}><h2>{title}</h2><button className={styles.tool} onClick={onClose} aria-label={`关闭${title}`}>✕</button></div>
      {children}
    </dialog>
  );
}

function Directory({ index, current, onSelect }: { index: ReaderIndex; current: number; onSelect: (index: number) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(Math.floor(current / DIRECTORY_PAGE_SIZE));
  const [locateRequest, setLocateRequest] = useState(0);
  const locateOnRender = useRef(true);
  const currentButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLElement>(null);
  const filtered = useMemo(() => index.chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [index, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / DIRECTORY_PAGE_SIZE));
  const shown = filtered.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE);
  useEffect(() => {
    // A child effect runs before the parent opens its dialog; wait one frame so
    // the current item has a visible box, and reset scroll on directory paging.
    const frame = requestAnimationFrame(() => {
      if (locateOnRender.current && currentButton.current) currentButton.current.scrollIntoView({ block: 'center', behavior: 'instant' });
      else if (list.current) list.current.scrollTop = 0;
      locateOnRender.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [page, query, locateRequest]);
  return (
    <>
      <div className={styles.directoryIntro}>
        <p>{index.title}</p>
        <span>共 {index.chapters.length} 章</span>
        <input className={styles.input} type="search" aria-label="搜索章节" placeholder="搜索章节标题" value={query} onChange={(event) => { locateOnRender.current = false; setQuery(event.target.value); setPage(0); }} />
        <button className={styles.locate} onClick={() => { locateOnRender.current = true; setQuery(''); setPage(Math.floor(current / DIRECTORY_PAGE_SIZE)); setLocateRequest((value) => value + 1); }}>定位当前章</button>
      </div>
      <nav ref={list} className={styles.directoryList} aria-label="章节目录">
        {shown.length ? shown.map((chapter) => (
          <button key={chapter.index} ref={chapter.index === current ? currentButton : undefined} className={styles.directoryItem} aria-current={chapter.index === current ? 'location' : undefined} onClick={() => onSelect(chapter.index)}>
            <span className={styles.chapterNumber}>{String(chapter.index + 1).padStart(2, '0')}</span>
            <span>{chapter.title}</span>
            {chapter.index === current && <small>在读</small>}
          </button>
        )) : <p className={styles.noResults}>没有找到相应章节</p>}
      </nav>
      {pageCount > 1 && <div className={styles.directoryPager}>
        <button className={styles.tool} disabled={page === 0} onClick={() => { locateOnRender.current = false; setPage(page - 1); }}>上一页</button>
        <span>{page + 1} / {pageCount}</span>
        <button className={styles.tool} disabled={page + 1 >= pageCount} onClick={() => { locateOnRender.current = false; setPage(page + 1); }}>下一页</button>
      </div>}
    </>
  );
}

function Settings({ value, onChange }: { value: ReaderSettings; onChange: (value: ReaderSettings) => void }) {
  const themes: { key: ReaderTheme; label: string }[] = [{ key: 'day', label: '日间' }, { key: 'night', label: '夜间' }, { key: 'sage', label: '护眼' }];
  return (
    <div className={styles.settings}>
      <fieldset>
        <legend>字号</legend>
        <div className={styles.fontControl}>
          <button className={styles.secondary} aria-label="减小字号" disabled={value.fontSize <= 16} onClick={() => onChange({ ...value, fontSize: Math.max(16, value.fontSize - 2) })}>A−</button>
          <output aria-live="polite">{value.fontSize}</output>
          <button className={styles.secondary} aria-label="增大字号" disabled={value.fontSize >= 30} onClick={() => onChange({ ...value, fontSize: Math.min(30, value.fontSize + 2) })}>A＋</button>
        </div>
      </fieldset>
      <fieldset>
        <legend>行距</legend>
        <div className={styles.choices}>
          {[{ value: 1.6, label: '紧凑' }, { value: 1.9, label: '适中' }, { value: 2.2, label: '宽松' }].map((line) => <button key={line.value} className={styles.choice} aria-pressed={value.lineHeight === line.value} onClick={() => onChange({ ...value, lineHeight: line.value })}>{line.label}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>纸色</legend>
        <div className={styles.choices}>
          {themes.map((theme) => <button key={theme.key} className={styles.themeChoice} aria-pressed={value.theme === theme.key} onClick={() => onChange({ ...value, theme: theme.key })}><span data-swatch={theme.key} aria-hidden="true">文</span>{theme.label}</button>)}
        </div>
      </fieldset>
      <div className={styles.settingSample} style={{ fontSize: value.fontSize, lineHeight: value.lineHeight }}>掬一捧月色，<br />翻一页山河。</div>
      <button className={styles.locate} onClick={() => onChange({ ...DEFAULT_READER_SETTINGS })}>恢复默认设置</button>
      <p className={styles.settingsNote}>设置与阅读进度保存在此浏览器。下次打开，会回到上次读到的地方。</p>
    </div>
  );
}
